import "server-only";

import { randomUUID } from "node:crypto";
import nodemailer from "nodemailer";
import type { AccountRow } from "../../db";
import { ReconnectRequired } from "../../mail/errors";
import { buildMime } from "../../mail/mime";
import type { DraftContent, OutgoingMessage, SavedDraft, Sent } from "../../mail/types";
import type { RenderedMessage } from "../../outgoing";
import type { MailServers } from "../../mail/provider";
import { ImapError, inFolder, isLocalHost, onConnection, serviceName } from "./client";
import { folders, type Folder, type Folders } from "./folders";
import { copiesIn, copiesOf, dropCopies, messageKey, messageRow, threadOfMessage, toMessage } from "./mirror";
import { getServers } from "./servers";
import { fetchInto, loadBodies } from "./sync";

// Sending is SMTP; IMAP has no "send". Kite writes the message (buildMime), adds the Message-ID and
// Date a provider API would add, hands it to the SMTP server without the Bcc header (SMTP delivers
// exactly what it's given; Bcc recipients go in the envelope only), then keeps the full copy in
// Sent. A server that also files sent mail itself makes a second copy with the same Message-ID,
// which Kite's index sees as the same message (Gmail always does, so Kite doesn't append there). Drafts are messages in the Drafts folder flagged
// \Draft; saving one appends the new version and deletes the old (IMAP messages can't change).
// Gmail keeps a draft once, in All Mail with the \Draft label, and Kite never reads its Drafts
// folder: a new version is appended to Drafts, then read from All Mail, and old versions are
// deleted for good (moved to Trash and removed there; an expunge in All Mail would only archive).

export function smtpTransport(servers: MailServers, user: string, pass: string) {
  return nodemailer.createTransport({
    host: servers.smtp.host,
    port: servers.smtp.port,
    secure: servers.smtp.secure,
    // Port 587 starts plain and must switch to TLS before the password is sent (a local test server is the exception).
    requireTLS: !servers.smtp.secure && !isLocalHost(servers.smtp.host),
    auth: { user, pass },
    // A server on this computer (the test server, Proton Bridge) uses its own certificate.
    ...(isLocalHost(servers.smtp.host) ? { tls: { rejectUnauthorized: false } } : {}),
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  });
}

const emailOf = (a: OutgoingMessage["to"][number]) => a.email;

/** The headers a provider API would add: Message-ID (Kite's id for the message comes from it) and Date. */
function withIdentity(account: AccountRow, mime: string, messageId: string) {
  return [`Message-ID: ${messageId}`, `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`, mime].join("\r\n");
}

const newMessageId = (account: AccountRow) => `<${randomUUID()}@${account.email.split("@")[1] ?? "kite.local"}>`;

/** The message without its Bcc header (and the header's folded lines), for the SMTP server. */
function withoutBcc(mime: string) {
  const end = mime.indexOf("\r\n\r\n");
  const head = end < 0 ? mime : mime.slice(0, end);
  const lines = head.split("\r\n");
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^bcc:/i.test(line)) {
      skipping = true;
      continue;
    }
    if (skipping && /^[ \t]/.test(line)) continue;
    skipping = false;
    kept.push(line);
  }
  return kept.join("\r\n") + (end < 0 ? "" : mime.slice(end));
}

/** Appends a message to a folder and indexes it; returns its Kite id. */
async function appendAndIndex(account: AccountRow, path: string, mime: string, flags: string[], messageId: string) {
  const appended = await onConnection(account, (client) => client.append(path, mime, flags));
  await inFolder(account, path, async (client) => {
    const uid =
      appended && appended.uid
        ? appended.uid
        : (((await client.search({ header: { "message-id": messageId } }, { uid: true })) || []) as number[]).at(-1);
    if (uid) await fetchInto(client, account.id, path, [uid]);
  });
  // Kite's id comes from the Message-ID alone, so the folder and UID don't matter here.
  return messageKey(messageId, path, 0, "");
}

export async function send(account: AccountRow, message: OutgoingMessage, rendered: RenderedMessage): Promise<Sent> {
  const servers = getServers(account.id);
  if (!servers) throw new ReconnectRequired(account.id);
  const messageId = newMessageId(account);
  const mime = withIdentity(account, buildMime(account, message, rendered), messageId);
  const recipients = [...message.to, ...(message.cc ?? []), ...(message.bcc ?? [])].map(emailOf);
  try {
    await smtpTransport(servers, servers.username, servers.password).sendMail({ envelope: { from: account.email, to: recipients }, raw: withoutBcc(mime) });
  } catch (error) {
    const e = error as { code?: string; response?: string; message?: string };
    if (e.code === "EAUTH") throw new ReconnectRequired(account.id);
    throw new ImapError(e.response || e.message || "The sending server refused the message", 502, serviceName(account.id));
  }
  const f = await folders(account);
  if (f.gmail) {
    // Gmail files what it sends itself (an appended copy would be a second message): read its All Mail copy.
    const all = f.role.all;
    if (all) {
      await inFolder(account, all.path, async (client) => {
        const uids = ((await client.search({ header: { "message-id": messageId } }, { uid: true })) || []) as number[];
        await fetchInto(client, account.id, all.path, uids);
      });
    }
    const id = messageKey(messageId, "", 0, "");
    return { id, threadId: threadOfMessage(account.id, id) ?? id };
  }
  const id = f.role.sent ? await appendAndIndex(account, f.role.sent.path, mime, ["\\Seen"], messageId) : messageKey(messageId, "", 0, "");
  return { id, threadId: threadOfMessage(account.id, id) ?? id };
}

/** The All Mail copies of a message, with the newest first. */
async function allMailCopies(account: AccountRow, path: string, messageId: string) {
  return inFolder(account, path, async (client) => {
    const uids = (((await client.search({ header: { "message-id": messageId } }, { uid: true })) || []) as number[]).sort((a, b) => b - a);
    await fetchInto(client, account.id, path, uids);
    return uids;
  });
}

/** Gmail: deletes All Mail copies for good: into Trash, then removed there. */
async function deleteForever(account: AccountRow, f: Folders, uids: number[], messageId: string | null) {
  const all = f.role.all;
  const trash = f.role.trash;
  if (!all || !trash || !uids.length) return;
  const moved = await inFolder(account, all.path, (client) => client.messageMove(uids.join(","), trash.path, { uid: true }));
  dropCopies(account.id, all.path, uids);
  await inFolder(account, trash.path, async (client) => {
    let inTrash = uids.map((uid) => (moved && moved.uidMap?.get(uid)) || 0).filter(Boolean);
    if (inTrash.length < uids.length && messageId) inTrash = ((await client.search({ header: { "message-id": messageId } }, { uid: true })) || []) as number[];
    if (inTrash.length) await client.messageDelete(inTrash.join(","), { uid: true });
  });
}

async function saveGmailDraft(account: AccountRow, f: Folders, box: Folder, mime: string, messageId: string): Promise<SavedDraft> {
  const all = f.role.all;
  if (!all) throw new ImapError("This Gmail account has no All Mail folder", 400, serviceName(account.id));
  await onConnection(account, (client) => client.append(box.path, mime, ["\\Draft", "\\Seen"]));
  const [, ...stale] = await allMailCopies(account, all.path, messageId);
  await deleteForever(account, f, stale, messageId);
  const id = messageKey(messageId, "", 0, "");
  return { id, messageId: id, threadId: threadOfMessage(account.id, id) ?? id };
}

async function draftsFolder(account: AccountRow) {
  const box = (await folders(account)).role.drafts;
  if (!box) throw new ImapError("This mailbox has no Drafts folder", 400, serviceName(account.id));
  return box;
}

export async function saveDraft(account: AccountRow, message: OutgoingMessage, rendered: RenderedMessage, draftId?: string): Promise<SavedDraft> {
  const box = await draftsFolder(account);
  const before = draftId ? messageRow(account.id, draftId) : null;
  // The same Message-ID for every version keeps the draft's id (and Kite's link to it) stable.
  const messageId = before?.parsed.messageId ?? newMessageId(account);
  const mime = withIdentity(account, buildMime(account, message, rendered), messageId);
  const f = await folders(account);
  if (f.gmail) return saveGmailDraft(account, f, box, mime, messageId);
  const oldCopies = before ? copiesOf(account.id, before.id).filter((c) => c.folder === box.path) : [];
  const id = await appendAndIndex(account, box.path, mime, ["\\Draft", "\\Seen"], messageId);
  const newest = Math.max(...copiesIn(account.id, box.path).filter((c) => c.id === id).map((c) => c.uid));
  const stale = oldCopies.filter((c) => c.uid !== newest).map((c) => c.uid);
  if (stale.length) {
    await inFolder(account, box.path, (client) => client.messageDelete(stale.join(","), { uid: true }));
    dropCopies(account.id, box.path, stale);
  }
  return { id, messageId: id, threadId: threadOfMessage(account.id, id) ?? id };
}

export async function deleteDraft(account: AccountRow, draftId: string) {
  const f = await folders(account);
  if (f.gmail) {
    const uids = copiesOf(account.id, draftId)
      .filter((c) => c.folder === f.role.all?.path)
      .map((c) => c.uid);
    return deleteForever(account, f, uids, messageRow(account.id, draftId)?.parsed.messageId ?? null);
  }
  const box = await draftsFolder(account);
  const uids = copiesOf(account.id, draftId)
    .filter((c) => c.folder === box.path)
    .map((c) => c.uid);
  if (!uids.length) return;
  await inFolder(account, box.path, (client) => client.messageDelete(uids.join(","), { uid: true }));
  dropCopies(account.id, box.path, uids);
}

export async function getDraft(account: AccountRow, draftId: string): Promise<DraftContent> {
  const row = messageRow(account.id, draftId);
  if (!row) throw new ImapError("That draft is gone", 404, serviceName(account.id));
  const f = await folders(account);
  const copies = copiesOf(account.id, draftId);
  const body = (await loadBodies(account, [{ row, copies }])).get(draftId) ?? {};
  const message = toMessage(account, row, copies, f, body);
  return {
    messageId: draftId,
    threadId: row.thread_id,
    to: message.to,
    cc: message.cc ?? [],
    bcc: row.parsed.bcc,
    subject: row.parsed.subject,
    html: body.html ?? null,
    text: body.html ? null : (body.text ?? ""),
    inReplyTo: row.parsed.inReplyTo,
    references: row.parsed.references,
    files: (message.attachments ?? []).filter((a) => !a.inline),
  };
}

export async function listDrafts(account: AccountRow): Promise<SavedDraft[]> {
  const f = await folders(account);
  // Gmail: drafts are the All Mail copies labelled \Draft (made here or in Gmail).
  const box = f.gmail ? f.role.all : f.role.drafts;
  if (!box) return [];
  const copies = copiesIn(account.id, box.path).filter((c) => !f.gmail || c.labels.includes("\\Draft"));
  const ids = [...new Set(copies.map((c) => c.id))];
  return ids.map((id) => ({ id, messageId: id, threadId: threadOfMessage(account.id, id) ?? id }));
}
