import "server-only";

import { createHash } from "node:crypto";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import { isCalendarFile } from "@/lib/calendar/invite";
import { attachmentKind, inferMimeType } from "@/lib/mail/attachments";
import { categoryFrom, DRAFT, SENT, STARRED, UNREAD } from "@/lib/mail/mailboxes";
import { senderAuth } from "@/lib/mail/privacy";
import type { Attachment, Contact, Message } from "@/lib/mail/types";
import { getDb, type AccountRow } from "../../db";
import { formatSize, parseUnsubscribe } from "../../mail/parse";
import type { ThreadRecord } from "../../mail/types";
import { folderLabel, keywordId, type Folders } from "./folders";
import { kiteLabels } from "./gmail";

// The IMAP provider's own index of the mailbox (tables in db.ts). IMAP has no conversations and its
// ids (UIDs) change when mail moves, so:
// - a message's id is a hash of its Message-ID header: the same in every folder and after moves (a
//   copy in Sent and one in Inbox, a note to yourself, are one message with both labels);
// - a message's thread comes from In-Reply-To and References: it joins the thread of any message it
//   points at, or of any message pointing at it; when it links two threads they become one. A new
//   thread's id is a hash of the first Message-ID in its References (or its own), so replies that
//   arrive before their parent still end up together;
// - each copy (folder, UID) keeps its own flags.
// Gmail mode (gmail.ts) skips the threading: X-GM-THRID is the thread, and each copy keeps its X-GM-LABELS.
// What's stored per message (`meta`) is everything a list needs, read with one FETCH; bodies are
// downloaded when a conversation is opened or prefetched.

type Part = {
  part: string;
  type: string;
  size: number;
  charset?: string;
  encoding?: string;
  name?: string;
  cid?: string;
  attachment: boolean;
};

export type Meta = {
  subject: string;
  from: Contact | null;
  to: Contact[];
  cc: Contact[];
  bcc: Contact[];
  replyTo: Contact[];
  date: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  unsubscribe?: string;
  unsubscribePost?: string;
  authResults?: string[];
  /** Leaf parts: the text and HTML bodies and the files. */
  parts: Part[];
  /** Part numbers of the bodies Kite shows. */
  text?: string;
  html?: string;
  snippet?: string;
  size: number;
};

export type Copy = { folder: string; uid: number; id: string; flags: string[]; labels: string[] };

type MessageRow = { id: string; thread_id: string; message_id: string | null; date: string; meta: string; category: string | null };

const hash = (value: string) => createHash("sha256").update(value).digest("base64url").slice(0, 22);

/** The ids in a References / In-Reply-To header. */
const messageIds = (value: string | undefined) => (value ?? "").match(/<[^<>\s]+>/g) ?? [];

/**
 * A message's Kite id: from its Message-ID, else Gmail's X-GM-MSGID, else from where it is (such
 * messages are rare and move ids when moved).
 */
export const messageKey = (messageId: string | undefined, folder: string, uid: number, uidValidity: string, gmailId?: string) =>
  hash(messageId ? messageId.toLowerCase() : gmailId ? `x-gm-msgid:${gmailId}` : `${folder}\n${uidValidity}\n${uid}`);

/** A fetched copy's Kite id. */
export const keyOf = (m: FetchMessageObject, folder: string, uidValidity: string, gmail: boolean) =>
  messageKey(m.envelope?.messageId || undefined, folder, m.uid, uidValidity, gmail ? m.emailId : undefined);

/** A fetched copy's X-GM-LABELS (Gmail mode), sorted; [] elsewhere. */
export const labelsOf = (m: FetchMessageObject, gmail: boolean) => (gmail ? [...(m.labels ?? [])].sort() : []);

function contacts(list: MessageAddressObject[] | undefined): Contact[] {
  return (list ?? []).flatMap((a) => {
    const email = a.address?.trim();
    return email ? [{ name: a.name?.trim() || email.split("@")[0] || email, email }] : [];
  });
}

/** Header lines (unfolded) by lower-cased name; a header seen twice keeps every value. */
function parseHeaders(raw: Buffer | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!raw) return out;
  const text = raw.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const name = line.slice(0, at).trim().toLowerCase();
    out.set(name, [...(out.get(name) ?? []), line.slice(at + 1).trim()]);
  }
  return out;
}

/** The leaf parts of a BODYSTRUCTURE, and which ones are the bodies. */
function leafParts(root: MessageStructureObject | undefined) {
  const parts: Part[] = [];
  const walk = (node: MessageStructureObject, inAlternative: boolean) => {
    const type = (node.type || "text/plain").toLowerCase();
    if (node.childNodes?.length && type.startsWith("multipart/")) {
      for (const child of node.childNodes) walk(child, type === "multipart/alternative" || inAlternative);
      return;
    }
    const name = node.dispositionParameters?.filename || node.parameters?.name;
    const disposition = (node.disposition || "").toLowerCase();
    const isText = type === "text/plain" || type === "text/html";
    parts.push({
      part: node.part || "1",
      type,
      size: node.size ?? 0,
      charset: node.parameters?.charset,
      encoding: node.encoding,
      name: name || undefined,
      cid: node.id?.replace(/^<|>$/g, "").trim() || undefined,
      // A text part is a body unless it's explicitly an attachment or a named file outside an alternative.
      attachment: !isText || disposition === "attachment" || (!!name && !inAlternative && disposition !== "inline"),
    });
  };
  if (root) walk(root, false);
  const bodies = parts.filter((p) => !p.attachment);
  return { parts, text: bodies.find((p) => p.type === "text/plain")?.part, html: bodies.find((p) => p.type === "text/html")?.part };
}

/** What a list needs from one FETCH (envelope, flags, structure, a few headers). */
function metaOf(m: FetchMessageObject): Meta {
  const env = m.envelope ?? {};
  const headers = parseHeaders(m.headers);
  const one = (name: string) => headers.get(name)?.[0];
  const { parts, text, html } = leafParts(m.bodyStructure);
  const date = m.internalDate ? new Date(m.internalDate) : env.date ? new Date(env.date) : new Date();
  return {
    subject: env.subject ?? "",
    from: contacts(env.from)[0] ?? contacts(env.sender)[0] ?? null,
    to: contacts(env.to),
    cc: contacts(env.cc),
    bcc: contacts(env.bcc),
    replyTo: contacts(env.replyTo),
    date: (Number.isNaN(date.getTime()) ? new Date() : date).toISOString(),
    messageId: env.messageId || undefined,
    inReplyTo: env.inReplyTo || undefined,
    references: one("references"),
    unsubscribe: one("list-unsubscribe"),
    unsubscribePost: one("list-unsubscribe-post"),
    authResults: headers.get("authentication-results"),
    parts,
    text,
    html,
    size: m.size ?? 0,
  };
}

/** The headers asked for with every FETCH. */
export const FETCH_HEADERS = ["references", "list-unsubscribe", "list-unsubscribe-post", "authentication-results"];

/**
 * Stores one fetched copy: the message (new, or known from another folder) and where it is. Returns
 * the threads that changed: the message's, plus any thread it merged away.
 */
export function storeCopy(accountId: string, folder: string, uidValidity: string, m: FetchMessageObject, flags: string[], gmail: boolean): string[] {
  const db = getDb();
  const meta = metaOf(m);
  const id = keyOf(m, folder, uidValidity, gmail);
  const labels = labelsOf(m, gmail);
  const existing = db.prepare("SELECT thread_id, meta FROM imap_messages WHERE account_id = ? AND id = ?").get(accountId, id) as
    | { thread_id: string; meta: string }
    | undefined;
  const touched = new Set<string>();
  // A copy moved here from another UID in this folder (or this UID reused after UIDVALIDITY changed).
  db.prepare("DELETE FROM imap_copies WHERE account_id = ? AND folder = ? AND uid = ?").run(accountId, folder, m.uid);
  db.prepare("INSERT INTO imap_copies (account_id, folder, uid, id, flags, labels) VALUES (?, ?, ?, ?, ?, ?)").run(
    accountId,
    folder,
    m.uid,
    id,
    JSON.stringify(flags),
    JSON.stringify(labels),
  );
  // Gmail says which conversation a message is in, and can change it, so it's taken every time.
  const gmailThread = gmail && m.threadId ? m.threadId : null;
  if (existing) {
    // Keep a snippet read earlier.
    const old = JSON.parse(existing.meta) as Meta;
    const threadId = gmailThread ?? existing.thread_id;
    db.prepare("UPDATE imap_messages SET meta = ?, thread_id = ? WHERE account_id = ? AND id = ?").run(JSON.stringify({ ...meta, snippet: old.snippet }), threadId, accountId, id);
    touched.add(existing.thread_id);
    touched.add(threadId);
    return [...touched];
  }
  if (gmailThread) {
    db.prepare("INSERT INTO imap_messages (account_id, id, thread_id, message_id, date, meta) VALUES (?, ?, ?, ?, ?, ?)").run(
      accountId,
      id,
      gmailThread,
      meta.messageId?.toLowerCase() ?? null,
      meta.date,
      JSON.stringify(meta),
    );
    return [gmailThread];
  }

  const refs = [...new Set([...messageIds(meta.references), ...messageIds(meta.inReplyTo)].map((r) => r.toLowerCase()))];
  const own = meta.messageId?.toLowerCase();
  const found = new Set<string>();
  if (refs.length) {
    const rows = db
      .prepare(`SELECT DISTINCT thread_id FROM imap_messages WHERE account_id = ? AND message_id IN (${refs.map(() => "?").join(", ")})`)
      .all(accountId, ...refs) as { thread_id: string }[];
    rows.forEach((r) => found.add(r.thread_id));
  }
  if (own) {
    const rows = db
      .prepare("SELECT DISTINCT m.thread_id FROM imap_refs r JOIN imap_messages m ON m.account_id = r.account_id AND m.id = r.id WHERE r.account_id = ? AND r.ref = ?")
      .all(accountId, own) as { thread_id: string }[];
    rows.forEach((r) => found.add(r.thread_id));
  }
  const threadId = found.size ? [...found].sort()[0] : hash(refs[0] ?? own ?? id);
  for (const other of found) {
    if (other === threadId) continue;
    db.prepare("UPDATE imap_messages SET thread_id = ? WHERE account_id = ? AND thread_id = ?").run(threadId, accountId, other);
    touched.add(other);
  }
  db.prepare("INSERT INTO imap_messages (account_id, id, thread_id, message_id, date, meta) VALUES (?, ?, ?, ?, ?, ?)").run(
    accountId,
    id,
    threadId,
    own ?? null,
    meta.date,
    JSON.stringify(meta),
  );
  const addRef = db.prepare("INSERT OR IGNORE INTO imap_refs (account_id, ref, id) VALUES (?, ?, ?)");
  for (const ref of refs) addRef.run(accountId, ref, id);
  touched.add(threadId);
  return [...touched];
}

/** Updates a known copy's flags (and Gmail labels, when given); returns its thread when something changed. */
export function setCopyFlags(accountId: string, folder: string, uid: number, flags: string[], labels?: string[]): string | null {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT c.flags, c.labels, m.thread_id FROM imap_copies c JOIN imap_messages m ON m.account_id = c.account_id AND m.id = c.id WHERE c.account_id = ? AND c.folder = ? AND c.uid = ?",
    )
    .get(accountId, folder, uid) as { flags: string; labels: string; thread_id: string } | undefined;
  if (!row) return null;
  const next = JSON.stringify([...flags].sort());
  const nextLabels = labels ? JSON.stringify([...labels].sort()) : row.labels;
  if (row.flags === next && row.labels === nextLabels) return null;
  db.prepare("UPDATE imap_copies SET flags = ?, labels = ? WHERE account_id = ? AND folder = ? AND uid = ?").run(next, nextLabels, accountId, folder, uid);
  return row.thread_id;
}

/** Forgets copies that are gone from a folder (and messages left without any). Returns their threads. */
export function dropCopies(accountId: string, folder: string, uids: number[]): string[] {
  if (!uids.length) return [];
  const db = getDb();
  const touched = new Set<string>();
  const find = db.prepare(
    "SELECT c.id, m.thread_id FROM imap_copies c JOIN imap_messages m ON m.account_id = c.account_id AND m.id = c.id WHERE c.account_id = ? AND c.folder = ? AND c.uid = ?",
  );
  const del = db.prepare("DELETE FROM imap_copies WHERE account_id = ? AND folder = ? AND uid = ?");
  const ids = new Set<string>();
  for (const uid of uids) {
    const row = find.get(accountId, folder, uid) as { id: string; thread_id: string } | undefined;
    if (!row) continue;
    del.run(accountId, folder, uid);
    ids.add(row.id);
    touched.add(row.thread_id);
  }
  for (const id of ids) removeIfOrphaned(accountId, id);
  return [...touched];
}

/** Sets messages' Inbox tabs (Gmail mode); returns the conversations whose tab changed. */
export function setCategories(accountId: string, entries: [id: string, category: string | null][]): string[] {
  const db = getDb();
  const get = db.prepare("SELECT thread_id, category FROM imap_messages WHERE account_id = ? AND id = ?");
  const set = db.prepare("UPDATE imap_messages SET category = ? WHERE account_id = ? AND id = ?");
  const touched = new Set<string>();
  for (const [id, category] of entries) {
    const row = get.get(accountId, id) as { thread_id: string; category: string | null } | undefined;
    if (!row || row.category === category) continue;
    set.run(category, accountId, id);
    touched.add(row.thread_id);
  }
  return [...touched];
}

function removeIfOrphaned(accountId: string, id: string) {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM imap_copies WHERE account_id = ? AND id = ?").get(accountId, id)) return;
  db.prepare("DELETE FROM imap_messages WHERE account_id = ? AND id = ?").run(accountId, id);
  db.prepare("DELETE FROM imap_refs WHERE account_id = ? AND id = ?").run(accountId, id);
}

type CopyRow = { folder: string; uid: number; id: string; flags: string; labels: string };
const toCopy = (r: CopyRow): Copy => ({ ...r, flags: JSON.parse(r.flags) as string[], labels: JSON.parse(r.labels) as string[] });

/** Every stored copy in a folder (UIDs ascending). */
export function copiesIn(accountId: string, folder: string): Copy[] {
  return (getDb().prepare("SELECT folder, uid, id, flags, labels FROM imap_copies WHERE account_id = ? AND folder = ? ORDER BY uid").all(accountId, folder) as CopyRow[]).map(toCopy);
}

/** Forgets a whole folder's copies (its UIDVALIDITY changed, or it's gone). */
export function dropFolder(accountId: string, folder: string): string[] {
  return dropCopies(accountId, folder, copiesIn(accountId, folder).map((c) => c.uid));
}

export function copiesOf(accountId: string, id: string): Copy[] {
  return (getDb().prepare("SELECT folder, uid, id, flags, labels FROM imap_copies WHERE account_id = ? AND id = ?").all(accountId, id) as CopyRow[]).map(toCopy);
}

export function messageRow(accountId: string, id: string): (MessageRow & { parsed: Meta }) | null {
  const row = getDb().prepare("SELECT id, thread_id, message_id, date, meta, category FROM imap_messages WHERE account_id = ? AND id = ?").get(accountId, id) as
    | MessageRow
    | undefined;
  return row ? { ...row, parsed: JSON.parse(row.meta) as Meta } : null;
}

export function threadRows(accountId: string, threadId: string): (MessageRow & { parsed: Meta })[] {
  return (getDb().prepare("SELECT id, thread_id, message_id, date, meta, category FROM imap_messages WHERE account_id = ? AND thread_id = ? ORDER BY date").all(accountId, threadId) as MessageRow[]).map(
    (r) => ({ ...r, parsed: JSON.parse(r.meta) as Meta }),
  );
}

export function threadOfMessage(accountId: string, id: string): string | null {
  return messageRow(accountId, id)?.thread_id ?? null;
}

/** Threads of these message ids, newest message first, without repeats. */
export function threadsOf(accountId: string, ids: string[]): string[] {
  if (!ids.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = getDb()
      .prepare(`SELECT thread_id, MAX(date) AS last FROM imap_messages WHERE account_id = ? AND id IN (${chunk.map(() => "?").join(", ")}) GROUP BY thread_id`)
      .all(accountId, ...chunk) as { thread_id: string; last: string }[];
    for (const r of rows) {
      if (seen.has(r.thread_id)) continue;
      seen.add(r.thread_id);
      out.push(r.thread_id);
    }
  }
  const last = new Map(
    out.map((t) => [t, (getDb().prepare("SELECT MAX(date) AS d FROM imap_messages WHERE account_id = ? AND thread_id = ?").get(accountId, t) as { d: string }).d]),
  );
  return out.sort((a, b) => (last.get(b) ?? "").localeCompare(last.get(a) ?? ""));
}

/** Messages with files (from the stored structures), newest first. */
export function messagesWithFiles(accountId: string, max: number): string[] {
  const rows = getDb()
    .prepare(`SELECT id FROM imap_messages WHERE account_id = ? AND meta LIKE '%"attachment":true%' ORDER BY date DESC LIMIT ?`)
    .all(accountId, max) as { id: string }[];
  return rows.map((r) => r.id);
}

export function setSnippet(accountId: string, id: string, snippet: string) {
  const row = messageRow(accountId, id);
  if (!row) return;
  getDb().prepare("UPDATE imap_messages SET meta = ? WHERE account_id = ? AND id = ?").run(JSON.stringify({ ...row.parsed, snippet }), accountId, id);
}

/** Every keyword (non-system flag) on stored mail: the account's tags. */
export function storedKeywords(accountId: string): string[] {
  const rows = getDb()
    .prepare("SELECT DISTINCT j.value AS flag FROM imap_copies c, json_each(c.flags) j WHERE c.account_id = ?")
    .all(accountId) as { flag: string }[];
  return rows.map((r) => r.flag).filter(isKeyword).sort((a, b) => a.localeCompare(b));
}

/** Flags that are the user's own tags (not IMAP's \Seen..., nor clients' bookkeeping like $Forwarded). */
const BOOKKEEPING = /^(\$(forwarded|mdnsent|junk|notjunk|phishing|submitpending|submitted|mailflagbit\d|hasattachment|hasnoattachment|important|autosent|notify)|junk|nonjunk|notjunk)$/i;
const isKeyword = (flag: string) => !flag.startsWith("\\") && !BOOKKEEPING.test(flag);

/** One message in Kite's model, from its copies (labels are the union of where it is). */
export function toMessage(account: Pick<AccountRow, "id" | "email">, row: MessageRow & { parsed: Meta }, copies: Copy[], f: Folders, body?: { text?: string; html?: string }): Message {
  const meta = row.parsed;
  const labels = new Set<string>();
  let unseen = false;
  let flagged = false;
  let draft = false;
  for (const copy of copies) {
    const folder = f.byPath.get(copy.folder);
    const label = folderLabel(folder);
    if (label) labels.add(label);
    const set = new Set(copy.flags);
    if (set.has("\\Draft") || copy.labels.includes("\\Draft")) draft = true;
    if (set.has("\\Flagged")) flagged = true;
    // Your own sent copy is read; what counts is the copy that arrived.
    if (!set.has("\\Seen") && folder?.role !== "sent") unseen = true;
    for (const flag of copy.flags) if (isKeyword(flag)) labels.add(keywordId(flag));
    for (const label of kiteLabels(copy.labels)) labels.add(label);
  }
  if (draft) labels.add(DRAFT);
  if (row.category) labels.add(row.category);
  if (unseen && !draft) labels.add(UNREAD);
  if (flagged) labels.add(STARRED);
  // Sent by this account but filed elsewhere (Archive, a folder): it's still yours. Not a draft, and
  // not one that also arrived (a note to yourself in Inbox).
  const roles = copies.map((c) => f.byPath.get(c.folder)?.role);
  if (!labels.has(SENT) && !draft && meta.from?.email.toLowerCase() === account.email.toLowerCase() && !roles.some((r) => r === "inbox" || r === "drafts")) labels.add(SENT);

  const message: Message = {
    id: row.id,
    from: meta.from ?? { name: "unknown", email: "unknown" },
    to: meta.to,
    cc: meta.cc.length ? meta.cc : undefined,
    replyTo: meta.replyTo.length ? meta.replyTo : undefined,
    draft: draft || undefined,
    date: meta.date,
    body: [],
    snippet: meta.snippet ?? "",
    messageIdHeader: meta.messageId,
    inReplyTo: meta.inReplyTo,
    references: meta.references,
    unread: (unseen && !draft) || undefined,
    remoteThread: row.thread_id,
    labels: [...labels],
    subject: meta.subject || undefined,
  };
  if (meta.parts.some((p) => p.attachment && isCalendarFile({ name: p.name ?? "", mimeType: p.type }))) message.calendar = true;
  if (!body) return message;
  if (meta.authResults?.length) message.auth = senderAuth(meta.authResults, message.from.email);
  message.attachments = meta.parts.filter((p) => p.attachment).map((p) => toAttachment(p, body.html ?? null));
  return message;
}

function toAttachment(p: Part, html: string | null): Attachment {
  // An invite's text/calendar part has no file name: kept as a hidden "invite.ics" for the invite card.
  const calendarPart = !p.name && p.type === "text/calendar";
  const name = p.name || (p.type === "message/rfc822" ? "message.eml" : calendarPart ? "invite.ics" : "attachment");
  const attachment: Attachment = {
    name,
    size: formatSize(p.size),
    kind: attachmentKind(name, p.type),
    partId: p.part,
    mimeType: inferMimeType(name, p.type),
    bytes: p.size,
    contentId: p.cid,
  };
  const inline = calendarPart || (!!p.cid && !!html && (html.includes(`cid:${p.cid}`) || html.includes(`cid:<${p.cid}>`)));
  return inline ? { ...attachment, inline: true } : attachment;
}

/** A thread in Kite's model (the record the store indexes), from stored rows and copies. */
export function toRecord(account: AccountRow, threadId: string, messages: Message[], rows: Meta[], full: boolean): ThreadRecord {
  const labels = [...new Set(messages.flatMap((m) => m.labels ?? []))];
  const me = account.email.toLowerCase();
  const externalIndex = messages.findLastIndex((m) => m.from.email.toLowerCase() !== me);
  const recipients = messages
    .filter((m) => m.from.email.toLowerCase() === me)
    .flatMap((m) => [...m.to, ...(m.cc ?? [])])
    .map((c) => c.email.toLowerCase());
  const lastExternal = externalIndex >= 0 ? rows[externalIndex] : null;
  return {
    thread: {
      id: `${account.id}:${threadId}`,
      remoteId: threadId,
      accountId: account.id,
      subject: rows[0]?.subject || "(no subject)",
      messages,
      mailbox: "inbox",
      category: categoryFrom(messages.at(-1)?.labels ?? []),
      unread: labels.includes(UNREAD),
      starred: labels.includes(STARRED),
      loaded: full,
    },
    labels,
    sender: externalIndex >= 0 ? messages[externalIndex].from : null,
    unsubscribe: lastExternal ? parseUnsubscribe(lastExternal.unsubscribe ?? "", lastExternal.unsubscribePost ?? "") : null,
    recipients: [...new Set(recipients)],
  };
}

/** Forgets everything stored for an account (Disconnect also deletes the rows with the account). */
export function forgetMirror(accountId: string) {
  const db = getDb();
  for (const table of ["imap_messages", "imap_copies", "imap_refs"]) db.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
}
