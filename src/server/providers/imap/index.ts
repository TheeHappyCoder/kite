import "server-only";

import { inferMimeType } from "@/lib/mail/attachments";
import { INBOX, SPAM, STARRED, TRASH, UNREAD } from "@/lib/mail/mailboxes";
import { getDb, listAccounts, type AccountRow } from "../../db";
import { googleCalendar } from "../../mail/google/calendar";
import { googleLinked, linkAccess } from "../../mail/google/link";
import { profilePhoto } from "../../mail/google/oauth";
import { googleContactPhotos } from "../../mail/google/people";
import { stripTrackers, toParagraphs } from "../../mail/parse";
import type { MailAdapter, MailProvider } from "../../mail/provider";
import type { LabelChange } from "../../mail/types";
import { imapAuth } from "./auth";
import { ImapError, inFolder, onConnection, serviceName } from "./client";
import * as compose from "./compose";
import * as manage from "./manage";
import { folders, forgetFolders, isFolderId, keywordId, keywordOf, type Folder, type Folders } from "./folders";
import { copiesOf, forgetMirror, messageRow, storedKeywords, threadRows, threadsOf, toMessage, toRecord, type Copy } from "./mirror";
import { changes, downloadPart, fetchInto, loadBodies, peek, scanList, startCursor } from "./sync";
import { gmailLabel, isGmail, labelId } from "./gmail";
import { watch } from "./watch";

// IMAP/SMTP (iCloud, Yahoo, Fastmail, custom domains) as a Kite mail provider. A Kite thread is a
// conversation Kite works out itself (mirror.ts); message ids are hashes of Message-IDs. Folders are
// labels of kind "folder", keywords are tags. Reading a thread's metadata needs no network (the
// index has it); bodies are downloaded when a conversation is opened or prefetched.

const CONCURRENCY = 2;

async function record(account: AccountRow, threadId: string, full: boolean) {
  const rows = threadRows(account.id, threadId);
  if (!rows.length) return null;
  const f = await folders(account);
  const items = rows.map((row) => ({ row, copies: copiesOf(account.id, row.id) })).filter((i) => i.copies.length);
  if (!items.length) return null;
  const bodies = full ? await loadBodies(account, items) : null;
  const messages = items.map(({ row, copies }) => {
    if (!bodies) return toMessage(account, row, copies, f);
    const body = bodies.get(row.id) ?? {};
    const message = toMessage(account, row, copies, f, body);
    if (body.html) {
      const stripped = stripTrackers(body.html);
      return { ...message, html: stripped.html, trackersBlocked: stripped.trackers, remoteImages: stripped.remoteImages };
    }
    return { ...message, body: toParagraphs(body.text ?? row.parsed.snippet ?? "") };
  });
  return toRecord(
    account,
    threadId,
    messages,
    items.map((i) => i.row.parsed),
    full,
  );
}

/**
 * Where a change moves one copy, or null when it stays. Mirrors applyLabelChange: a folder takes
 * mail out of Inbox, Trash, Junk and other folders; leaving a folder archives; your sent mail and
 * drafts aren't filed with the rest.
 */
function destination(copy: Folder | undefined, change: LabelChange, f: Folders, mine: boolean): Folder | "archive" | null {
  const at = copy?.role ?? null;
  const filedApart = at === "sent" || at === "drafts";
  const home = mine ? (f.role.sent ?? f.role.inbox) : f.role.inbox;
  if (change.add.includes(TRASH)) return f.role.trash ?? null;
  if (change.add.includes(SPAM)) return filedApart ? null : (f.role.junk ?? null);
  const into = change.add.find(isFolderId);
  if (into) return filedApart ? null : (f.byId.get(into) ?? null);
  if (change.add.includes(INBOX)) return filedApart || at === "inbox" ? null : (f.role.inbox ?? null);
  if (change.remove.includes(INBOX) && at === "inbox") return "archive";
  if (change.remove.includes(TRASH) && at === "trash") return change.remove.includes(INBOX) ? "archive" : home ?? null;
  if (change.remove.includes(SPAM) && at === "junk") return f.role.inbox ?? null;
  const out = change.remove.find(isFolderId);
  if (out && copy?.id === out) return "archive";
  return null;
}

/** The Archive folder, made when the mailbox has none (archiving needs somewhere to go). */
async function archiveFolder(account: AccountRow): Promise<Folder> {
  const f = await folders(account);
  if (f.role.archive) return f.role.archive;
  const existing = f.all.find((folder) => folder.path.toLowerCase() === "archive");
  if (existing) return existing;
  await onConnection(account, (client) => client.mailboxCreate("Archive"));
  forgetFolders(account.id);
  const made = (await folders(account, true)).all.find((folder) => folder.path === "Archive");
  if (!made) throw new ImapError("Kite couldn't make an Archive folder", 502, serviceName(account.id));
  return made;
}

/** Flags (read, star, keywords) for one change, as IMAP flags to add and remove. */
function flagChange(change: LabelChange) {
  const add: string[] = [];
  const remove: string[] = [];
  if (change.add.includes(UNREAD)) remove.push("\\Seen");
  if (change.remove.includes(UNREAD)) add.push("\\Seen");
  if (change.add.includes(STARRED)) add.push("\\Flagged");
  if (change.remove.includes(STARRED)) remove.push("\\Flagged");
  for (const id of change.add) if (keywordOf(id)) add.push(keywordOf(id)!);
  for (const id of change.remove) if (keywordOf(id)) remove.push(keywordOf(id)!);
  return { add, remove };
}

/**
 * Gmail: flags on every copy and X-GM-LABELS on the All Mail copy (archive is removing \Inbox), then
 * moves into Trash and Spam, or out of them back to All Mail, where the labels (\Inbox) go on after
 * and the copy is read again.
 */
async function gmailModify(account: AccountRow, ids: string[], change: LabelChange, f: Folders) {
  const flags = flagChange(change);
  const labels = {
    add: change.add.map(gmailLabel).filter((l): l is string => !!l),
    remove: change.remove.map(gmailLabel).filter((l): l is string => !!l),
  };
  const byFolder = new Map<string, Copy[]>();
  const headerOf = new Map<string, string>();
  for (const id of ids) {
    const row = messageRow(account.id, id);
    if (!row) continue;
    if (row.parsed.messageId) headerOf.set(id, row.parsed.messageId);
    for (const copy of copiesOf(account.id, id)) byFolder.set(copy.folder, [...(byFolder.get(copy.folder) ?? []), copy]);
  }
  const db = getDb();
  const all = f.role.all;
  // Copies that moved into All Mail (by UID), and messages to find there by Message-ID when the server didn't say.
  const arrived: number[] = [];
  const lookFor = new Set<string>();
  for (const [path, copies] of byFolder) {
    const role = f.byPath.get(path)?.role;
    const dest =
      change.add.includes(TRASH) && role !== "trash"
        ? f.role.trash
        : change.add.includes(SPAM) && role === "all"
          ? f.role.junk
          : (change.remove.includes(TRASH) && role === "trash") || (change.remove.includes(SPAM) && role === "junk")
            ? all
            : undefined;
    const relabel = role === "all" && (labels.add.length || labels.remove.length);
    if (!flags.add.length && !flags.remove.length && !relabel && !dest) continue;
    await inFolder(account, path, async (client) => {
      const uids = copies.map((c) => c.uid).join(",");
      if (flags.add.length) await client.messageFlagsAdd(uids, flags.add, { uid: true });
      if (flags.remove.length) await client.messageFlagsRemove(uids, flags.remove, { uid: true });
      if (relabel && labels.add.length) await client.messageFlagsAdd(uids, labels.add, { uid: true, useLabels: true });
      if (relabel && labels.remove.length) await client.messageFlagsRemove(uids, labels.remove, { uid: true, useLabels: true });
      for (const copy of copies) {
        copy.flags = [...new Set([...copy.flags.filter((x) => !flags.remove.includes(x)), ...flags.add])].sort();
        if (relabel) copy.labels = [...new Set([...copy.labels.filter((x) => !labels.remove.includes(x)), ...labels.add])].sort();
        db.prepare("UPDATE imap_copies SET flags = ?, labels = ? WHERE account_id = ? AND folder = ? AND uid = ?").run(
          JSON.stringify(copy.flags),
          JSON.stringify(copy.labels),
          account.id,
          path,
          copy.uid,
        );
      }
      if (!dest) return;
      const moved = await client.messageMove(uids, dest.path, { uid: true });
      for (const copy of copies) {
        db.prepare("DELETE FROM imap_copies WHERE account_id = ? AND folder = ? AND uid = ?").run(account.id, path, copy.uid);
        const uid = moved && moved.uidMap?.get(copy.uid);
        if (uid && dest === all) arrived.push(uid);
        else if (uid) {
          db.prepare("INSERT OR REPLACE INTO imap_copies (account_id, folder, uid, id, flags, labels) VALUES (?, ?, ?, ?, ?, ?)").run(
            account.id,
            dest.path,
            uid,
            copy.id,
            JSON.stringify(copy.flags),
            JSON.stringify(copy.labels),
          );
        } else if (headerOf.has(copy.id)) lookFor.add(headerOf.get(copy.id)!);
      }
    });
  }
  // Back in All Mail (or moved where the server didn't say): the labels go on there, then the copies are read again.
  if ((arrived.length || lookFor.size) && all) {
    await inFolder(account, all.path, async (client) => {
      const uids = new Set(arrived);
      for (const header of lookFor) for (const uid of ((await client.search({ header: { "message-id": header } }, { uid: true })) || []) as number[]) uids.add(uid);
      const list = [...uids].join(",");
      if (list && labels.add.length) await client.messageFlagsAdd(list, labels.add, { uid: true, useLabels: true });
      if (list && labels.remove.length) await client.messageFlagsRemove(list, labels.remove, { uid: true, useLabels: true });
      await fetchInto(client, account.id, all.path, [...uids]);
    });
  }
}

/** Applies a change to messages: flags on every copy, then moves, a folder at a time. The index follows. */
async function modify(account: AccountRow, ids: string[], change: LabelChange) {
  const f = await folders(account);
  if (change.add.includes(TRASH) && !f.role.trash) throw new ImapError("This account has no Trash folder. Create one in your mail service first.", 400, serviceName(account.id));
  if (f.gmail) return gmailModify(account, ids, change, f);
  const flags = flagChange(change);
  const me = account.email.toLowerCase();
  const byFolder = new Map<string, Copy[]>();
  const moves = new Map<string, { copy: Copy; to: Folder | "archive" }[]>();
  for (const id of ids) {
    const row = messageRow(account.id, id);
    if (!row) continue;
    const toOthers = [...row.parsed.to, ...row.parsed.cc].some((c) => c.email.toLowerCase() !== me);
    const mine = row.parsed.from?.email.toLowerCase() === me && toOthers;
    for (const copy of copiesOf(account.id, id)) {
      byFolder.set(copy.folder, [...(byFolder.get(copy.folder) ?? []), copy]);
      const to = destination(f.byPath.get(copy.folder), change, f, mine);
      if (to && (to === "archive" || to.path !== copy.folder)) moves.set(copy.folder, [...(moves.get(copy.folder) ?? []), { copy, to }]);
    }
  }
  const archive = [...moves.values()].some((list) => list.some((m) => m.to === "archive")) ? await archiveFolder(account) : null;
  const db = getDb();
  // Destinations whose new UIDs the server didn't report (no UIDPLUS): their UIDNEXT before the first move.
  const unmapped = new Map<string, number>();
  for (const [path, copies] of byFolder) {
    const planned = moves.get(path) ?? [];
    if (!flags.add.length && !flags.remove.length && !planned.length) continue;
    await inFolder(account, path, async (client) => {
      const uids = copies.map((c) => c.uid).join(",");
      if (flags.add.length) await client.messageFlagsAdd(uids, flags.add, { uid: true });
      if (flags.remove.length) await client.messageFlagsRemove(uids, flags.remove, { uid: true });
      for (const copy of copies) {
        const next = [...new Set([...copy.flags.filter((x) => !flags.remove.includes(x)), ...flags.add])].sort();
        db.prepare("UPDATE imap_copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?").run(JSON.stringify(next), account.id, path, copy.uid);
        copy.flags = next;
      }
      // One MOVE per destination; the new UIDs (UIDPLUS) keep the index right until the next check.
      // Without UIDPLUS the destination is read back below, so Undo finds the copies straight away.
      const targets = new Map<string, Copy[]>();
      for (const { copy, to } of planned) {
        const dest = to === "archive" ? archive! : to;
        if (dest.path === path) continue;
        targets.set(dest.path, [...(targets.get(dest.path) ?? []), copy]);
      }
      for (const [dest, list] of targets) {
        if (!client.capabilities.has("UIDPLUS") && !unmapped.has(dest)) {
          const status = await client.status(dest, { uidNext: true });
          const next = status && status.uidNext;
          if (next) unmapped.set(dest, next);
        }
        const moved = await client.messageMove(list.map((c) => c.uid).join(","), dest, { uid: true });
        for (const copy of list) {
          db.prepare("DELETE FROM imap_copies WHERE account_id = ? AND folder = ? AND uid = ?").run(account.id, path, copy.uid);
          const uid = moved && moved.uidMap?.get(copy.uid);
          if (uid) {
            db.prepare("INSERT OR REPLACE INTO imap_copies (account_id, folder, uid, id, flags, labels) VALUES (?, ?, ?, ?, ?, '[]')").run(
              account.id,
              dest,
              uid,
              copy.id,
              JSON.stringify(copy.flags),
            );
          }
        }
      }
    });
  }
  for (const [dest, from] of unmapped) {
    await inFolder(account, dest, async (client) => {
      // `n:*` also answers with the last message when nothing is newer; keep only UIDs from n.
      const uids = (await client.fetchAll(`${from}:*`, { uid: true }, { uid: true })).map((m) => m.uid).filter((uid) => uid >= from);
      await fetchInto(client, account.id, dest, uids);
    });
  }
}

const mail: MailAdapter = {
  concurrency: CONCURRENCY,
  resetLocal(accountId) {
    forgetMirror(accountId);
    forgetFolders(accountId);
  },
  startCursor,
  changes,
  async listThreads(account, list, max, onPage) {
    const ids = await scanList(account, list, max * 2, (found) => {
      const threads = threadsOf(account.id, found);
      if (threads.length) onPage?.(threads);
    });
    return threadsOf(account.id, ids).slice(0, max);
  },
  async listMessages(account, list, max) {
    return (await scanList(account, list, max)).slice(0, max);
  },
  fetchThread: (account, threadId, full) => record(account, threadId, full),
  async fetchMessage(account, messageId, full) {
    const row = messageRow(account.id, messageId);
    if (!row) throw new ImapError("That message is gone", 404, serviceName(account.id));
    const copies = copiesOf(account.id, messageId);
    const f = await folders(account);
    if (!full) return toMessage(account, row, copies, f);
    const body = (await loadBodies(account, [{ row, copies }])).get(messageId) ?? {};
    const message = toMessage(account, row, copies, f, body);
    return body.html ? { ...message, html: body.html } : { ...message, body: toParagraphs(body.text ?? "") };
  },
  async attachment(account, messageId, partId, name) {
    const row = messageRow(account.id, messageId);
    if (!row) return null;
    const part = row.parsed.parts.find((p) => p.part === partId);
    const data = await downloadPart(account, copiesOf(account.id, messageId), partId);
    if (!data) return null;
    const fileName = part?.name || name || "attachment";
    return { name: fileName, mimeType: inferMimeType(fileName, part?.type), data };
  },
  async modifyThreads(account, threadIds, change) {
    const ids = threadIds.flatMap((t) => threadRows(account.id, t).map((r) => r.id));
    await modify(account, ids, change);
  },
  modifyMessages: (account, messageIds, change) => modify(account, messageIds, change),
  send: compose.send,
  canDeletePermanently: (account) => onConnection(account, (client) => Promise.resolve(client.capabilities.has("UIDPLUS"))),
  async deletePermanently(account, ids) {
    const f = await folders(account);
    const trash = f.role.trash;
    if (!trash) throw new ImapError("This account has no Trash folder.", 400, serviceName(account.id));
    await inFolder(account, trash.path, async (client) => {
      if (!client.capabilities.has("UIDPLUS")) throw new ImapError("Empty Trash in your mail service; this server cannot safely delete individual messages permanently.", 400, serviceName(account.id));
      const copies = ids.flatMap((id) => copiesOf(account.id, id).filter((c) => c.folder === trash.path));
      if (!copies.length) return;
      await client.messageDelete(copies.map((c) => c.uid).join(","), { uid: true });
      for (const c of copies) getDb().prepare("DELETE FROM imap_copies WHERE account_id = ? AND folder = ? AND uid = ?").run(account.id, trash.path, c.uid);
    });
  },
  saveDraft: compose.saveDraft,
  deleteDraft: compose.deleteDraft,
  getDraft: compose.getDraft,
  listDrafts: compose.listDrafts,
  watch,
  peek,
};

/** Gmail mode with its optional Google sign-in: the calendar, contact photos and profile photo come through it. */
const googleExtras = (accountId: string) => isGmail(accountId) && googleLinked(accountId);

export const imapProvider: MailProvider = {
  id: "imap",
  auth: imapAuth,
  mail,
  serviceName,
  organisesLike: (accountId) => (isGmail(accountId) ? "gmail" : null),
  // IMAP has none of these; Gmail accounts get them from the optional Google sign-in. Without it,
  // invites are answered by email.
  picture: async (account) => (googleExtras(account.id) ? profilePhoto(await linkAccess.token(account.id)) : null),
  calendar: googleCalendar(linkAccess, googleExtras),
  contactPhotos: googleContactPhotos(linkAccess, () => listAccounts().filter((a) => a.provider === "imap" && googleExtras(a.id)), googleExtras),
  labels: {
    // The user's folders, then the keywords on stored mail (IMAP has no list of keywords).
    async list(account) {
      const f = await folders(account, true);
      // Gmail: the user's folders are its labels, tags on each message.
      if (f.gmail) return f.all.filter((folder) => !folder.role).map((folder) => ({ id: labelId(folder.path), name: folder.name, kind: "tag" as const, color: null, hidden: false }));
      const own = f.all.filter((folder) => !folder.role).map((folder) => ({ id: folder.id, name: folder.name, kind: "folder" as const, color: null, hidden: false }));
      const tags = storedKeywords(account.id).map((k) => ({ id: keywordId(k), name: k.replace(/^\$/, ""), kind: "tag" as const, color: null, hidden: false }));
      return [...own, ...tags];
    },
    create: manage.createLabel,
    rename: manage.renameLabel,
    remove: manage.removeLabel,
  },
};
