import "server-only";

import type { Invite } from "@/lib/calendar/invite";
import type { Attachment, Contact, FileItem, Mailbox, Message, Regroup, Thread } from "@/lib/mail/types";
import { attachmentKind, inferMimeType } from "@/lib/mail/attachments";
import { labelNamed, parseSearch, type SearchTerm } from "@/lib/mail/search";
import { freshPreview, htmlToText, snippetFresh, splitMessage } from "@/lib/mail/quotes";
import { homeRemote, remotesOf } from "@/lib/mail/threads";
import { messagesInMailbox } from "@/lib/mail/trash";
import { getDb, type AccountRow } from "./db";
import { categoryFrom, DRAFT, INBOX, SENT, UNREAD } from "@/lib/mail/mailboxes";
import { scopeIds, scopeSql, type AccountScope } from "@/lib/mail/scope";
import type { ReplyCandidate } from "@/lib/replies";
import { UNSUBSCRIBE_GRACE_DAYS, type SenderDetail, type SenderSummary } from "@/lib/mail/cleanup";
import type { ThreadRecord } from "./mail/types";
import { userLabelFilter } from "./labels";

// Local copy of each account's mail. Lists and search read from here; the sync
// engine keeps it current from Gmail's history feed.

type ThreadRow = {
  id: string;
  account_id: string;
  remote_id: string;
  last_date: string;
  labels: string;
  sender_email: string | null;
  sender_name: string | null;
  unsubscribe: string | null;
  full: number;
  data: string;
  message_labels?: string | null;
};

type SenderStatus = "allowed" | "pending" | "blocked";

const isLoaded = (message: Message) => !!message.html || message.body.length > 0;

/**
 * Whether a message's full copy was downloaded. Full fetches always list attachments (even
 * none), so a message with an empty body still counts and isn't downloaded again every tick.
 */
const isFetched = (message: Message) => isLoaded(message) || message.attachments !== undefined;

/**
 * What search indexes: the new text of each message (quoted history is indexed with the
 * message it came from), plus forwarded content, which often isn't in the thread.
 */
function textOf(message: Message) {
  if (!isLoaded(message)) return snippetFresh(message.snippet ?? "");
  const split = splitMessage(message);
  const html = split.html;
  const fresh = html ? `${htmlToText(html.fresh)} ${message.body.length ? split.text.fresh : ""}` : split.text.fresh;
  const forwarded = split.text.kind === "forward" ? (html ? htmlToText(html.quoted) : split.text.quoted) : "";
  return `${fresh} ${forwarded}`.replace(/\s+/g, " ").slice(0, 20_000);
}

/** The list row's one-line preview: new text only, so replies don't preview the quote. */
function previewOf(message: Message) {
  return isLoaded(message) ? freshPreview(message) || undefined : undefined;
}

function indexThread(thread: Thread) {
  const db = getDb();
  db.prepare("DELETE FROM threads_fts WHERE id = ?").run(thread.id);
  const people = thread.messages.flatMap((m) => [m.from.name, m.from.email, ...m.to.map((t) => `${t.name} ${t.email}`)]).join(" ");
  // A local subject and the private note are searchable too (thread_overrides).
  const local = db.prepare("SELECT subject, note FROM thread_overrides WHERE thread_id = ?").get(thread.id) as
    | { subject: string | null; note: string | null }
    | undefined;
  db.prepare("INSERT INTO threads_fts (id, subject, people, body) VALUES (?, ?, ?, ?)").run(
    thread.id,
    local?.subject ? `${local.subject} ${thread.subject}` : thread.subject,
    people,
    [local?.note ?? "", ...thread.messages.map(textOf)].join(" "),
  );
}

/** Indexes a stored thread again (its local subject or note changed). */
export function reindexThread(id: string) {
  const row = getDb().prepare("SELECT data FROM threads WHERE id = ?").get(id) as { data: string } | undefined;
  if (row) indexThread(JSON.parse(row.data) as Thread);
}

/** Bump when textOf or previewOf change, so stored threads are re-derived once. */
const DERIVED_VERSION = "7";

/** Recomputes previews and the search index for stored threads after the derivation changed. */
export function upgradeDerived() {
  const db = getDb();
  const row = db.prepare("SELECT value FROM settings WHERE key = 'derived_version'").get() as { value: string } | undefined;
  if (row?.value === DERIVED_VERSION) return;
  const rows = db.prepare("SELECT id, data FROM threads").all() as { id: string; data: string }[];
  const update = db.prepare("UPDATE threads SET data = ? WHERE id = ?");
  db.exec("BEGIN");
  try {
    for (const { id, data } of rows) {
      const thread = JSON.parse(data) as Thread;
      thread.messages = thread.messages.map((m) => ({ ...m, preview: previewOf(m) }));
      update.run(JSON.stringify(thread), id);
      indexThread(thread);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES ('derived_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(DERIVED_VERSION);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Keeps already-downloaded bodies when a metadata-only refresh of the same thread arrives. */
function mergeMessages(previous: Message[] | undefined, next: Message[]) {
  if (!previous) return next;
  const known = new Map(previous.map((m) => [m.id, m]));
  return next.map((m) => {
    const old = known.get(m.id);
    // Labels come from the fresh copy: read state and drafts change, bodies don't.
    return old && isFetched(old) && !isFetched(m)
      ? {
          ...m,
          ...old,
          snippet: m.snippet,
          unread: m.unread,
          draft: m.draft,
          labels: m.labels ?? old.labels,
          inReplyTo: m.inReplyTo ?? old.inReplyTo,
          subject: m.subject ?? old.subject,
        }
      : m;
  });
}

// ---------------------------------------------------------------------------
// Placement: which Kite thread each Gmail message is stored in
// ---------------------------------------------------------------------------
//
// Usually one Gmail thread is one Kite thread (`${account}:${gmailThreadId}`). Local splits
// and merges (regroup.ts) change that without touching Gmail: message_moves puts single
// messages in another Kite thread, thread_merges sends a whole Gmail thread (and its future
// messages) to another one. Every store of a Gmail thread goes through placeRemote, so sync
// re-applies them whenever Gmail adds a message.

const byDate = (a: Message, b: Message) => a.date.localeCompare(b.date);
const homeId = (accountId: string, remoteId: string) => `${accountId}:${remoteId}`;

/** The Gmail thread a stored message came from. */
const remoteOf = (row: ThreadRow, m: Message) => m.remoteThread ?? row.remote_id;

/**
 * The Kite thread for each message of one Gmail thread: an explicit move, else the
 * conversation its parent message went to (replies follow a split), else the Gmail
 * thread's own conversation (or the one it was merged into).
 */
export function assignMessages(accountId: string, remoteId: string, messages: Message[]) {
  const db = getDb();
  const merge = db.prepare("SELECT thread_id FROM thread_merges WHERE account_id = ? AND remote_id = ?").get(accountId, remoteId) as
    | { thread_id: string }
    | undefined;
  const fallback = merge?.thread_id ?? homeId(accountId, remoteId);
  const moves = new Map(
    (
      db.prepare("SELECT message_id, thread_id FROM message_moves WHERE account_id = ? AND remote_id = ?").all(accountId, remoteId) as {
        message_id: string;
        thread_id: string;
      }[]
    ).map((r) => [r.message_id, r.thread_id]),
  );
  const byHeader = new Map<string, string>();
  const assigned = new Map<string, string>();
  for (const m of [...messages].sort(byDate)) {
    const parent = m.inReplyTo ? byHeader.get(m.inReplyTo.trim()) : undefined;
    const target = moves.get(m.id) ?? (parent && parent !== fallback ? parent : fallback);
    assigned.set(m.id, target);
    if (m.messageIdHeader) byHeader.set(m.messageIdHeader.trim(), target);
  }
  return assigned;
}

/** Kite threads that may hold messages of a Gmail thread. */
function holderIds(accountId: string, remoteId: string) {
  const rows = getDb()
    .prepare(
      `SELECT thread_id FROM thread_merges WHERE account_id = ? AND remote_id = ?
       UNION SELECT thread_id FROM message_moves WHERE account_id = ? AND remote_id = ?`,
    )
    .all(accountId, remoteId, accountId, remoteId) as { thread_id: string }[];
  return [homeId(accountId, remoteId), ...rows.map((r) => r.thread_id)];
}

type Held = { row: ThreadRow; thread: Thread };

/** Stored threads holding messages of this Gmail thread (several after a split or merge). */
export function rowsHolding(accountId: string, remoteId: string, extra: string[] = []): Held[] {
  const held: Held[] = [];
  for (const id of new Set([...holderIds(accountId, remoteId), ...extra])) {
    const row = getThreadRow(id);
    if (!row) continue;
    const thread = JSON.parse(row.data) as Thread;
    if (thread.messages.some((m) => remoteOf(row, m) === remoteId)) held.push({ row, thread });
  }
  return held;
}

/** Every stored message of a Gmail thread, wherever it was placed, oldest first. */
export function remoteMessages(accountId: string, remoteId: string) {
  return rowsHolding(accountId, remoteId)
    .flatMap(({ row, thread }) => thread.messages.filter((m) => remoteOf(row, m) === remoteId))
    .sort(byDate);
}

/** A Kite thread now holding the Gmail thread's messages, and the ids of those that arrived new. */
export type Placement = { id: string; fresh: string[] };

/**
 * Stores one Gmail thread's messages in the Kite threads they belong to and returns each
 * thread now holding them, with the messages that arrived new. `record` null removes the Gmail
 * thread; "stored" places the stored copy again (after a split, merge or undo). `extra`
 * names threads that held its messages before the change.
 */
export function placeRemote(account: AccountRow, remoteId: string, record: ThreadRecord | null | "stored", extra: string[] = []): Placement[] {
  const holders = new Map<string, Held>();
  for (const id of new Set([...holderIds(account.id, remoteId), ...extra])) {
    const row = getThreadRow(id);
    if (row) holders.set(id, { row, thread: JSON.parse(row.data) as Thread });
  }
  const before = [...holders.values()].flatMap(({ row, thread }) =>
    thread.messages
      .filter((m) => remoteOf(row, m) === remoteId)
      .map((m) => ({ ...m, subject: m.subject ?? thread.subject, remoteThread: remoteId })),
  );
  const known = new Set(before.map((m) => m.id));
  const fresh = record && record !== "stored" ? record : null;
  const messages = fresh
    ? mergeMessages(before, fresh.thread.messages.map((m) => ({ ...m, remoteThread: remoteId }))).map((m) => ({ ...m, preview: previewOf(m) }))
    : record === "stored"
      ? before
      : [];
  const assigned = assignMessages(account.id, remoteId, messages);

  const placements: Placement[] = [];
  for (const id of new Set([...holders.keys(), ...assigned.values()])) {
    const held = holders.get(id);
    const kept = held
      ? held.thread.messages
          .filter((m) => remoteOf(held.row, m) !== remoteId)
          .map((m) => ({ ...m, subject: m.subject ?? held.thread.subject }))
      : [];
    const mine = messages.filter((m) => assigned.get(m.id) === id);
    const all = [...kept, ...mine].sort(byDate);
    if (!all.length) {
      if (held) deleteThread(id);
      continue;
    }
    writeThread(account, id, all, held, mine.length ? fresh : null);
    placements.push({ id, fresh: mine.filter((m) => !known.has(m.id)).map((m) => m.id) });
  }
  // Extracted attachment text follows the message, including permanent removals.
  for (const old of before) {
    const current = messages.find((m) => m.id === old.id);
    if (!current) {
      for (const table of ["document_text", "file_prints"]) getDb().prepare(`DELETE FROM ${table} WHERE account_id = ? AND message_id = ?`).run(account.id, old.id);
    } else {
      const parts = new Set(current.attachments?.map((a) => a.partId));
      for (const attachment of old.attachments ?? []) {
        if (!attachment.partId || parts.has(attachment.partId)) continue;
        for (const table of ["document_text", "file_prints"]) getDb().prepare(`DELETE FROM ${table} WHERE account_id = ? AND message_id = ? AND part_id = ?`).run(account.id, old.id, attachment.partId);
      }
    }
  }
  return placements;
}

function writeThread(account: AccountRow, id: string, messages: Message[], held: Held | undefined, record: ThreadRecord | null) {
  const labels = [...new Set(messages.flatMap((m) => m.labels ?? []))];
  const full = messages.every(isFetched);
  const first = messages[0];
  const last = messages[messages.length - 1];
  const me = account.email.toLowerCase();
  const external = [...messages].reverse().find((m) => m.from.email.toLowerCase() !== me);
  const thread: Thread = {
    id,
    accountId: account.id,
    remoteId: held?.row.remote_id ?? homeRemote(id.slice(account.id.length + 1)),
    subject: first.subject ?? held?.thread.subject ?? record?.thread.subject ?? "(no subject)",
    messages,
    mailbox: "inbox",
    category: last.labels?.length ? categoryFrom(last.labels) : (held?.thread.category ?? record?.thread.category ?? "important"),
    unread: labels.includes("UNREAD"),
    starred: labels.includes("STARRED"),
    loaded: full,
  };
  const unsubscribe = record ? (record.unsubscribe ? JSON.stringify(record.unsubscribe) : null) : (held?.row.unsubscribe ?? null);
  getDb()
    .prepare(
      `INSERT INTO threads (id, account_id, remote_id, last_date, labels, sender_email, sender_name, unsubscribe, full, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_date = excluded.last_date, labels = excluded.labels,
         sender_email = excluded.sender_email, sender_name = excluded.sender_name,
         unsubscribe = excluded.unsubscribe, full = excluded.full, data = excluded.data`,
    )
    .run(
      id,
      account.id,
      thread.remoteId!,
      last.date,
      JSON.stringify(labels),
      external?.from.email.toLowerCase() ?? null,
      external?.from.name ?? null,
      unsubscribe,
      full ? 1 : 0,
      JSON.stringify(thread),
    );
  indexThread(thread);
}

/** Stores a Gmail thread fetched by sync (split and merge choices applied). */
export function upsertRecord(account: AccountRow, record: ThreadRecord) {
  return placeRemote(account, record.thread.remoteId!, record);
}

/** The Gmail thread is gone: its messages leave every Kite thread that held them. */
export function removeRemote(account: AccountRow, remoteId: string) {
  placeRemote(account, remoteId, null);
}

/**
 * What a thread operation must change in Gmail: whole Gmail threads (threads.modify) where
 * this conversation holds all of one, single messages where it holds only part of it.
 */
export function opTargets(accountId: string, id: string): { threads: string[]; messages: string[] } {
  const row = getThreadRow(id);
  const key = id.slice(accountId.length + 1);
  if (!row) return { threads: key.includes("~") ? [] : [key], messages: [] };
  const groups = new Map<string, string[]>();
  for (const m of (JSON.parse(row.data) as Thread).messages) {
    const remote = remoteOf(row, m);
    groups.set(remote, [...(groups.get(remote) ?? []), m.id]);
  }
  const threads: string[] = [];
  const messages: string[] = [];
  for (const [remote, ids] of groups) {
    if (rowsHolding(accountId, remote).some((h) => h.row.id !== id)) messages.push(...ids);
    else threads.push(remote);
  }
  return { threads, messages };
}

/** Gmail threads behind the newest `limit` conversations of a mailbox whose bodies were never downloaded, newest first. */
export function remotesToPrefetch(accountId: string, mailbox: "inbox" | "screener", limit: number) {
  const rows = getDb()
    .prepare(
      `SELECT data FROM (
         SELECT t.full, t.data, t.last_date FROM threads t WHERE ${MAILBOX_SQL[mailbox]} AND t.account_id = ?
         ORDER BY t.last_date DESC LIMIT ?
       ) t WHERE t.full = 0 ORDER BY t.last_date DESC`,
    )
    .all(accountId, limit) as { data: string }[];
  return rows.map((r) => remotesOf(JSON.parse(r.data) as Thread));
}

/** Whether every stored message of a Gmail thread has its full copy. */
export function remoteFullyStored(accountId: string, remoteId: string) {
  const held = rowsHolding(accountId, remoteId);
  return (
    held.length > 0 &&
    held.every(({ row, thread }) => thread.messages.every((m) => remoteOf(row, m) !== remoteId || isFetched(m)))
  );
}

function deleteThread(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM threads WHERE id = ?").run(id);
  db.prepare("DELETE FROM threads_fts WHERE id = ?").run(id);
}

export function getThreadRow(id: string) {
  return getDb().prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | undefined;
}

/** Keeps an invite read from the provider (Outlook's event messages) with its message, until the next refresh replaces the copy. */
export function saveInvite(id: string, messageId: string, invite: Invite) {
  const row = getThreadRow(id);
  if (!row) return;
  const thread = JSON.parse(row.data) as Thread;
  const message = thread.messages.find((m) => m.id === messageId);
  if (!message) return;
  message.invite = invite;
  getDb().prepare("UPDATE threads SET data = ? WHERE id = ?").run(JSON.stringify(thread), id);
}

/** Your own mail in a conversation: sent messages and drafts. */
function ownMessage(m: Message) {
  return !!m.labels?.some((l) => l === SENT || l === DRAFT);
}

/**
 * What "unread" marks in a conversation: its newest message from someone else (your own replies
 * stay read), or the newest message when everything in it is yours.
 */
export function unreadTarget(thread: Thread): string | undefined {
  const newest = [...thread.messages].sort(byDate).reverse();
  return (newest.find((m) => !ownMessage(m)) ?? newest[0])?.id;
}

/** Applies a label change locally so the UI reflects it before Gmail's history catches up. */
export function updateLabels(id: string, add: string[], remove: string[]) {
  const row = getThreadRow(id);
  if (!row) return;
  const thread = JSON.parse(row.data) as Thread;
  // The operation changed every message of this conversation, so mirror it per message. Your own
  // sent mail and drafts aren't filed back into the Inbox or marked unread (no provider does).
  const others = thread.messages.some((m) => !ownMessage(m));
  thread.messages = thread.messages.map((m) => {
    const labels = new Set(m.labels);
    const keep = others && ownMessage(m);
    add.forEach((l) => (keep && (l === INBOX || l === UNREAD)) || labels.add(l));
    remove.forEach((l) => labels.delete(l));
    return { ...m, labels: [...labels], unread: labels.has("UNREAD") || undefined };
  });
  const labels = new Set(thread.messages.flatMap((m) => m.labels ?? []));
  thread.unread = labels.has("UNREAD");
  thread.starred = labels.has("STARRED");
  getDb()
    .prepare("UPDATE threads SET labels = ?, data = ? WHERE id = ?")
    .run(JSON.stringify([...labels]), JSON.stringify(thread), id);
}

/** Applies a label change to some messages of a conversation (rules touch only the mail that just arrived). */
export function updateMessageLabels(id: string, messageIds: string[], add: string[], remove: string[]) {
  const row = getThreadRow(id);
  if (!row) return;
  const thread = JSON.parse(row.data) as Thread;
  const ids = new Set(messageIds);
  thread.messages = thread.messages.map((m) => {
    if (!ids.has(m.id)) return m;
    const labels = new Set(m.labels);
    add.forEach((l) => labels.add(l));
    remove.forEach((l) => labels.delete(l));
    return { ...m, labels: [...labels], unread: labels.has("UNREAD") || undefined };
  });
  const labels = new Set(thread.messages.flatMap((m) => m.labels ?? []));
  thread.unread = labels.has("UNREAD");
  thread.starred = labels.has("STARRED");
  getDb()
    .prepare("UPDATE threads SET labels = ?, data = ? WHERE id = ?")
    .run(JSON.stringify([...labels]), JSON.stringify(thread), id);
}

/** A thread's slim copy (db.ts `listCopy`: everything but bodies), for lists, search filters and files. */
const LIST_DATA = "t.list_data";
const LIST_COLUMNS = `t.id, t.account_id, t.remote_id, t.last_date, t.labels, t.sender_email, t.sender_name, t.unsubscribe, t.full, ${LIST_DATA} AS data,
  CASE WHEN EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value IN ('TRASH', 'SPAM')) THEN
    (SELECT json_group_object(json_extract(m.value, '$.id'), json_extract(m.value, '$.labels')) FROM json_each(t.data, '$.messages') m)
  END AS message_labels`;

/** The thread's key (its id after the account), which snoozes are stored under. */
const KEY = "substr(t.id, length(t.account_id) + 2)";
const HAS = (label: string) => `EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = '${label}')`;
const NOT_HIDDEN = `((NOT ${HAS("TRASH")} AND NOT ${HAS("SPAM")}) OR EXISTS (
  SELECT 1 FROM json_each(t.data, '$.messages') m WHERE NOT EXISTS (
    SELECT 1 FROM json_each(m.value, '$.labels') l WHERE l.value IN ('TRASH', 'SPAM')
  )
))`;
const SENDER_STATUS = "COALESCE((SELECT status FROM senders s WHERE s.email = t.sender_email), 'allowed')";

const MAILBOX_SQL: Record<Exclude<Mailbox, "snoozed" | "scheduled">, string> = {
  trash: HAS("TRASH"),
  inbox: `${HAS("INBOX")} AND ${NOT_HIDDEN} AND ${SENDER_STATUS} = 'allowed'`,
  screener: `${HAS("INBOX")} AND ${NOT_HIDDEN} AND ${SENDER_STATUS} = 'pending'`,
  starred: `${HAS("STARRED")} AND ${NOT_HIDDEN}`,
  sent: `${HAS("SENT")} AND ${NOT_HIDDEN}`,
  drafts: `${HAS("DRAFT")} AND ${NOT_HIDDEN}`,
  // "All mail" (the mailbox keeps the id `archive`): everything but Trash, Spam and drafts, like Gmail's All Mail.
  archive: `${NOT_HIDDEN} AND NOT ${HAS("DRAFT")}`,
};

/** List rows from the slim copy (LIST_COLUMNS): bodies are served when a conversation is opened. */
function hydrate(rows: (ThreadRow & { until?: string | null; reminder?: string | null })[], mailbox: Mailbox): Thread[] {
  const regroups = rows.length ? latestRegroups() : new Map<string, Regroup>();
  const userLabels = userLabelFilter();
  return rows.map((row) => {
    const thread = JSON.parse(row.data) as Thread;
    if (row.message_labels) {
      const byId = JSON.parse(row.message_labels) as Record<string, string[] | null>;
      thread.messages = messagesInMailbox(thread.messages.map((m) => ({ ...m, labels: byId[m.id] ?? [] })), mailbox === "trash");
      thread.unread = thread.messages.some((m) => m.unread);
      thread.starred = thread.messages.some((m) => m.labels?.includes("STARRED"));
    }
    const labels = userLabels(row.account_id, JSON.parse(row.labels) as string[]);
    return {
      ...thread,
      labels: labels.length ? labels : undefined,
      regroup: regroups.get(row.id),
      list: row.unsubscribe ? true : undefined,
      loaded: false,
      // All mail holds Inbox conversations too: those stay "inbox", so their actions are the Inbox's.
      mailbox: mailbox === "archive" && row.labels.includes('"INBOX"') ? "inbox" : mailbox,
      snoozedUntil: row.until ?? undefined,
      reminder: row.reminder ? { sentAt: row.reminder } : undefined,
    };
  });
}

/** The newest split or merge that made each thread (for the reader's "Split from…" note). */
function latestRegroups() {
  const rows = getDb().prepare("SELECT * FROM regroups ORDER BY created_at").all() as {
    id: string;
    kind: Regroup["kind"];
    thread_id: string;
    source_id: string;
    source_subject: string;
    created_at: string;
  }[];
  return new Map(
    rows.map((r) => [r.thread_id, { id: r.id, kind: r.kind, sourceId: r.source_id, sourceSubject: r.source_subject, createdAt: r.created_at }]),
  );
}

const REMINDER = `(SELECT f.sent_at FROM followups f WHERE f.account_id = t.account_id AND f.thread_remote_id = t.remote_id AND f.status = 'nudged' LIMIT 1) AS reminder`;

/**
 * Reply tracking's candidates (lib/replies.ts): conversations active since `since`, slim copies, not in
 * Trash or Spam, not muted, from senders that aren't blocked or held in the Screener.
 */
export function replyCandidates(accountIds: string[], since: string): (ReplyCandidate & { list: boolean })[] {
  if (!accountIds.length) return [];
  const rows = getDb()
    .prepare(
      `SELECT ${LIST_COLUMNS} FROM threads t
       WHERE t.account_id IN (SELECT value FROM json_each(?)) AND t.last_date >= ? AND ${NOT_HIDDEN} AND ${SENDER_STATUS} = 'allowed'
         AND NOT EXISTS (SELECT 1 FROM thread_overrides o WHERE o.thread_id = t.id AND o.muted = 1)
       ORDER BY t.last_date DESC LIMIT 2000`,
    )
    .all(JSON.stringify(accountIds), since) as ThreadRow[];
  return rows.map((row) => {
    const labels = JSON.parse(row.labels) as string[];
    const category = categoryFrom(labels);
    return {
      thread: { ...(JSON.parse(row.data) as Thread), id: row.id, accountId: row.account_id },
      inbox: labels.includes("INBOX"),
      bulk: !!row.unsubscribe || category === "newsletters" || category === "notifications",
      list: !!row.unsubscribe,
    };
  });
}

export function queryThreads(mailbox: Mailbox, scope: AccountScope, limit = 1000): Thread[] {
  const db = getDb();
  const { sql: accountFilter, args } = scopeSql(scope, "t.account_id");

  if (mailbox === "snoozed") {
    const rows = db
      .prepare(
        `SELECT ${LIST_COLUMNS}, s.until AS until, NULL AS reminder FROM threads t
         JOIN snoozes s ON s.account_id = t.account_id AND s.thread_id = ${KEY}
         WHERE ${accountFilter} AND ${NOT_HIDDEN} ORDER BY s.until ASC LIMIT ${limit}`,
      )
      .all(...args) as (ThreadRow & { until: string })[];
    return hydrate(rows, "snoozed");
  }
  if (mailbox === "scheduled") return [];

  const rows = db
    .prepare(
      `SELECT ${LIST_COLUMNS}, ${REMINDER} FROM threads t WHERE ${MAILBOX_SQL[mailbox]} AND ${accountFilter}
       ORDER BY t.last_date DESC LIMIT ${limit}`,
    )
    .all(...args) as ThreadRow[];
  return hydrate(rows, mailbox);
}

/** How many conversations a mailbox holds (`unread`: only unread ones), counted in SQL without reading any mail. */
export function countThreads(mailbox: Exclude<Mailbox, "scheduled">, scope: AccountScope, { unread = false } = {}): number {
  const { sql: accountFilter, args } = scopeSql(scope, "t.account_id");
  const where = [accountFilter];
  if (unread) where.push(HAS("UNREAD"));
  const sql =
    mailbox === "snoozed"
      ? `SELECT COUNT(*) AS n FROM threads t JOIN snoozes s ON s.account_id = t.account_id AND s.thread_id = ${KEY} WHERE ${where.join(" AND ")} AND ${NOT_HIDDEN}`
      : `SELECT COUNT(*) AS n FROM threads t WHERE ${MAILBOX_SQL[mailbox]} AND ${where.join(" AND ")}`;
  return (getDb().prepare(sql).get(...args) as { n: number }).n;
}

/** Conversations carrying one of the user's labels/folders, newest first (trash and spam left out). */
export function queryLabel(accountId: string, labelId: string, limit = 1000): Thread[] {
  const rows = getDb()
    .prepare(
      `SELECT ${LIST_COLUMNS}, ${REMINDER} FROM threads t WHERE t.account_id = ? AND EXISTS (SELECT 1 FROM json_each(t.labels) WHERE value = ?)
       AND ${NOT_HIDDEN} ORDER BY t.last_date DESC LIMIT ${limit}`,
    )
    .all(accountId, labelId) as ThreadRow[];
  return rows.map(hydrateFound);
}

/** An FTS5 match for one value: each word prefix-matched, in order ("a b"* style), optionally in one column. */
function ftsMatch(value: string, column?: string, prefix = true) {
  const words = value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!words.length) return null;
  const phrase = `"${words.join(" ")}"${prefix ? "*" : ""}`;
  return column ? `${column} : ${phrase}` : phrase;
}

const MESSAGES = `json_each(${LIST_DATA}, '$.messages') m`;
const PERSON = (path: string) => `lower(COALESCE(json_extract(${path}, '$.email'), '') || ' ' || COALESCE(json_extract(${path}, '$.name'), ''))`;
const FILES = `${MESSAGES}, json_each(m.value, '$.attachments') a WHERE COALESCE(json_extract(a.value, '$.inline'), 0) = 0`;

/** Words: the full-text index, or text extracted from attached documents. */
function textSql(term: SearchTerm): { sql: string; args: string[] } | null {
  const match = ftsMatch(term.value, undefined, !term.phrase);
  if (!match) return null;
  const words = "t.id IN (SELECT id FROM threads_fts WHERE threads_fts MATCH ?)";
  // The documents first: few match, and only then is a conversation's JSON worth reading (every search would read all of it).
  const like = `%${term.value.toLowerCase().replace(/[!%_]/g, (c) => `!${c}`)}%`;
  const documents = getDb().prepare("SELECT account_id, message_id FROM document_text WHERE lower(text) LIKE ? ESCAPE '!'").all(like) as { account_id: string; message_id: string }[];
  if (!documents.length) return { sql: `(${words})`, args: [match] };
  return {
    sql: `(${words} OR EXISTS (SELECT 1 FROM json_each(?) d WHERE d.value ->> 0 = t.account_id AND instr(t.list_data, d.value ->> 1) > 0 AND EXISTS (SELECT 1 FROM json_each(t.list_data, '$.messages') dm WHERE json_extract(dm.value, '$.id') = d.value ->> 1)))`,
    args: [match, JSON.stringify(documents.map((d) => [d.account_id, d.message_id]))],
  };
}

/** One term as SQL (exact checks on the stored thread; the FTS match only narrows). */
function termSql(term: SearchTerm): { sql: string; args: string[] } | null {
  const v = term.value;
  switch (term.field) {
    case "any": {
      // a OR b: each side as its own condition (a side that can't be said in SQL matches anything).
      const parts = (term.any ?? []).map((t) => {
        const part = t.field === "text" ? textSql(t) : termSql(t);
        return part ? { sql: t.negate ? `NOT (${part.sql})` : `(${part.sql})`, args: part.args } : null;
      });
      if (!parts.length || parts.some((p) => !p)) return null;
      return { sql: parts.map((p) => p!.sql).join(" OR "), args: parts.flatMap((p) => p!.args) };
    }
    case "from":
      return { sql: `EXISTS (SELECT 1 FROM ${MESSAGES} WHERE instr(${PERSON("m.value -> '$.from'")}, ?) > 0)`, args: [v] };
    case "to":
      return {
        sql: `EXISTS (SELECT 1 FROM ${MESSAGES}, json_each(m.value, '$.to') r WHERE instr(${PERSON("r.value")}, ?) > 0)
          OR EXISTS (SELECT 1 FROM ${MESSAGES}, json_each(m.value, '$.cc') r WHERE instr(${PERSON("r.value")}, ?) > 0)`,
        args: [v, v],
      };
    case "subject":
      return {
        sql: `instr(lower(COALESCE((SELECT o.subject FROM thread_overrides o WHERE o.thread_id = t.id), '') || ' ' || json_extract(${LIST_DATA}, '$.subject')), ?) > 0`,
        args: [v],
      };
    case "filename":
      return { sql: `EXISTS (SELECT 1 FROM ${FILES} AND instr(lower(json_extract(a.value, '$.name')), ?) > 0)`, args: [v] };
    case "has":
      return { sql: `EXISTS (SELECT 1 FROM ${FILES})`, args: [] };
    case "is":
      if (v === "unread") return { sql: HAS("UNREAD"), args: [] };
      if (v === "read") return { sql: `NOT ${HAS("UNREAD")}`, args: [] };
      if (v === "starred") return { sql: HAS("STARRED"), args: [] };
      return { sql: `EXISTS (SELECT 1 FROM snoozes s WHERE s.account_id = t.account_id AND s.thread_id = ${KEY})`, args: [] };
    case "in":
      if (v === "anywhere") return null;
      if (v === "archive") return { sql: `NOT ${HAS("INBOX")} AND NOT ${HAS("DRAFT")} AND t.sender_email IS NOT NULL`, args: [] };
      return { sql: HAS({ inbox: "INBOX", sent: "SENT", drafts: "DRAFT", trash: "TRASH", spam: "SPAM" }[v] ?? "INBOX"), args: [] };
    case "before":
      return { sql: "t.last_date < ?", args: [v] };
    case "after":
      return { sql: "t.last_date >= ?", args: [v] };
    case "label": {
      // Gmail matches a label by name, case-insensitively, with spaces and "/" also written as "-". Names are
      // compared here, not in SQL: SQLite's lower() only knows ASCII ("Échéances").
      const labels = getDb().prepare("SELECT account_id, id, name FROM labels").all() as { account_id: string; id: string; name: string }[];
      const named = labels.filter((l) => labelNamed(l.name, v)).map((l) => `${l.account_id}\n${l.id}`);
      return { sql: `EXISTS (SELECT 1 FROM json_each(t.labels) j WHERE t.account_id || char(10) || j.value IN (SELECT value FROM json_each(?)))`, args: [JSON.stringify(named)] };
    }
    case "text":
      return null;
  }
}

/**
 * Search with Gmail's syntax (see lib/mail/search.ts): words and "phrases" over subject,
 * people and bodies, plus from:, to:, subject:, filename:, has:attachment, is:, in:,
 * before:/after:/newer_than:/older_than:, each negatable with "-". Trash and spam only
 * show up with in:trash, in:spam or in:anywhere.
 */
export function searchThreads(query: string, scope: AccountScope, limit = 100, offset = 0): Thread[] {
  const terms = parseSearch(query);
  if (!terms.length) return [];
  const where: string[] = [];
  const args: string[] = [];
  const fts: string[] = [];

  for (const term of terms) {
    if (term.field === "text") {
      const text = textSql(term);
      if (!text) continue;
      where.push(term.negate ? `NOT ${text.sql}` : text.sql);
      args.push(...text.args);
      continue;
    }
    // People and subjects narrow through the index first; the exact check follows.
    if (!term.negate && (term.field === "from" || term.field === "to" || term.field === "subject")) {
      const match = ftsMatch(term.value, term.field === "subject" ? "subject" : "people");
      if (match) fts.push(match);
    }
    const sql = termSql(term);
    if (!sql) continue;
    where.push(term.negate ? `NOT (${sql.sql})` : `(${sql.sql})`);
    args.push(...sql.args);
  }
  if (!fts.length && !where.length) return [];

  const showsHidden = terms.some((t) => t.field === "in" && !t.negate && ["trash", "spam", "anywhere"].includes(t.value));
  if (!showsHidden) where.push(NOT_HIDDEN);
  if (scopeIds(scope)) {
    const s = scopeSql(scope, "t.account_id");
    where.push(s.sql);
    args.push(...s.args);
  }
  const from = fts.length ? "threads_fts f JOIN threads t ON t.id = f.id" : "threads t";
  if (fts.length) where.unshift("threads_fts MATCH ?");
  const rows = getDb()
    .prepare(`SELECT ${LIST_COLUMNS}, ${REMINDER} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY t.last_date DESC, t.id DESC LIMIT ${Math.max(1, Math.min(1000, Math.floor(limit)))} OFFSET ${Math.max(0, Math.floor(offset))}`)
    .all(...(fts.length ? [fts.join(" AND ")] : []), ...args) as ThreadRow[];
  return rows.map(hydrateFound);
}

/** A search hit: its mailbox comes from its labels, since results span every mailbox. */
function hydrateFound(row: ThreadRow) {
  const labels = JSON.parse(row.labels) as string[];
  const mailbox: Mailbox = labels.includes("TRASH") ? "trash" : labels.includes("INBOX") ? "inbox" : labels.includes("DRAFT") ? "drafts" : labels.includes("SENT") && !row.sender_email ? "sent" : "archive";
  return hydrate([row], mailbox)[0];
}

/** Threads by id, newest first (results Gmail found for "Search older mail in Gmail"). */
export function threadsByIds(ids: string[]): Thread[] {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(`SELECT ${LIST_COLUMNS}, ${REMINDER} FROM threads t WHERE t.id IN (SELECT value FROM json_each(?)) ORDER BY t.last_date DESC`)
    .all(JSON.stringify(ids)) as ThreadRow[];
  return rows.map(hydrateFound);
}

/** Conversations by id that aren't in Trash or Spam, newest first (a space's list). */
export function liveThreadsByIds(ids: string[]): Thread[] {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(`SELECT ${LIST_COLUMNS}, ${REMINDER} FROM threads t WHERE t.id IN (SELECT value FROM json_each(?)) AND ${NOT_HIDDEN} ORDER BY t.last_date DESC`)
    .all(JSON.stringify(ids)) as ThreadRow[];
  return rows.map(hydrateFound);
}

export function threadCount(accountId: string) {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM threads WHERE account_id = ?").get(accountId) as { n: number }).n;
}

// ---------------------------------------------------------------------------
// Senders (Screener)
// ---------------------------------------------------------------------------

export function senderStatus(email: string): SenderStatus | null {
  const row = getDb().prepare("SELECT status FROM senders WHERE email = ?").get(email.toLowerCase()) as
    | { status: SenderStatus }
    | undefined;
  return row?.status ?? null;
}

export function setSenderStatus(email: string, status: SenderStatus, onlyIfNew = false) {
  getDb()
    .prepare(
      `INSERT INTO senders (email, status, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(email) DO ${onlyIfNew ? "NOTHING" : "UPDATE SET status = excluded.status, updated_at = excluded.updated_at"}`,
    )
    .run(email.toLowerCase(), status, new Date().toISOString());
}

export function markUnsubscribed(email: string) {
  const at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO senders (email, status, unsubscribed_at, updated_at) VALUES (?, 'allowed', ?, ?)
       ON CONFLICT(email) DO UPDATE SET unsubscribed_at = excluded.unsubscribed_at`,
    )
    .run(email.toLowerCase(), at, at);
}

/** Cleanup's "Keep" (and taking it back): the sender stays out of Cleanup's suggestions. */
export function setSenderKept(email: string, kept: boolean) {
  const at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO senders (email, status, kept_at, updated_at) VALUES (?, 'allowed', ?, ?)
       ON CONFLICT(email) DO UPDATE SET kept_at = excluded.kept_at`,
    )
    .run(email.toLowerCase(), kept ? at : null, at);
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

/** Every email from the thread's sender in the slim copy, with the thread's inbox state (message labels aren't in it). */
const SENDER_MESSAGES = `
  SELECT t.sender_email AS email, t.sender_name AS name, t.account_id AS account, ${HAS("INBOX")} AS inbox,
    t.unsubscribe IS NOT NULL AS unsub, json_extract(m.value, '$.date') AS date,
    COALESCE(json_extract(m.value, '$.unread'), 0) AS unread,
    (SELECT COALESCE(SUM(json_extract(a.value, '$.bytes')), 0) FROM json_each(m.value, '$.attachments') a) AS bytes
  FROM threads t, json_each(${LIST_DATA}, '$.messages') m
  WHERE t.sender_email IS NOT NULL AND ${NOT_HIDDEN} AND lower(json_extract(m.value, '$.from.email')) = t.sender_email`;

/** Cleanup's sender table: per-sender counts from the local copy (list_data only). Two emails at least. */
export function senderSummaries(scope: AccountScope, limit = 1000): SenderSummary[] {
  const { sql: accountFilter, args } = scopeSql(scope, "t.account_id");
  const rows = getDb()
    .prepare(
      `WITH m AS (${SENDER_MESSAGES} AND ${accountFilter})
       SELECT m.email, MAX(m.name) AS name, COUNT(*) AS emails, SUM(m.inbox) AS inInbox, SUM(m.unread) AS unread,
         SUM(m.unread AND NOT m.inbox) AS archivedUnread, MIN(m.date) AS firstDate, MAX(m.date) AS lastDate,
         MAX(CASE WHEN m.unread THEN NULL ELSE m.date END) AS lastRead, SUM(m.bytes) AS fileBytes,
         MAX(m.unsub) AS canUnsubscribe, s.unsubscribed_at AS unsubscribedAt, s.kept_at AS keptAt,
         COALESCE(s.status, 'allowed') AS status,
         SUM(s.unsubscribed_at IS NOT NULL AND julianday(m.date) > julianday(s.unsubscribed_at) + ${UNSUBSCRIBE_GRACE_DAYS}) AS sinceUnsubscribe,
         json_group_array(DISTINCT m.account) AS accountIds
       FROM m LEFT JOIN senders s ON s.email = m.email
       GROUP BY m.email
       HAVING emails >= 2
       ORDER BY emails DESC
       LIMIT ${limit}`,
    )
    .all(...args) as (Omit<SenderSummary, "canUnsubscribe" | "accountIds"> & { canUnsubscribe: number; accountIds: string })[];
  return rows.map((row) => ({ ...row, canUnsubscribe: !!row.canUnsubscribe, accountIds: JSON.parse(row.accountIds) }));
}

/** A sender's newest emails for Cleanup's detail pane (list_data only). */
export function senderRecent(email: string, scope: AccountScope, limit = 6): SenderDetail["recent"] {
  const { sql: accountFilter, args } = scopeSql(scope, "t.account_id");
  const rows = getDb()
    .prepare(
      `SELECT COALESCE(json_extract(m.value, '$.subject'), json_extract(${LIST_DATA}, '$.subject')) AS subject,
         json_extract(m.value, '$.date') AS date, COALESCE(json_extract(m.value, '$.unread'), 0) AS unread, ${HAS("INBOX")} AS inInbox
       FROM threads t, json_each(${LIST_DATA}, '$.messages') m
       WHERE t.sender_email = ? AND ${NOT_HIDDEN} AND ${accountFilter} AND lower(json_extract(m.value, '$.from.email')) = t.sender_email
       ORDER BY date DESC LIMIT ${limit}`,
    )
    .all(email.toLowerCase(), ...args) as { subject: string | null; date: string; unread: number; inInbox: number }[];
  return rows.map((r) => ({ subject: r.subject || "(no subject)", date: r.date, unread: !!r.unread, inInbox: !!r.inInbox }));
}

export function latestUnsubscribe(email: string, scope: AccountScope = "all") {
  const filter = scopeSql(scope, "account_id");
  const row = getDb()
    .prepare(`SELECT unsubscribe, account_id FROM threads WHERE sender_email = ? AND unsubscribe IS NOT NULL AND ${filter.sql} ORDER BY last_date DESC LIMIT 1`)
    .get(email.toLowerCase(), ...filter.args) as { unsubscribe: string; account_id: string } | undefined;
  return row ? { ...(JSON.parse(row.unsubscribe) as { http?: string; mailto?: string; oneClick: boolean }), accountId: row.account_id } : null;
}

/** A sender's conversations still in one account's inbox. */
export function inboxThreadsFromSender(email: string, accountId: string) {
  return (
    getDb()
      .prepare(`SELECT t.id FROM threads t WHERE t.sender_email = ? AND t.account_id = ? AND ${HAS("INBOX")}`)
      .all(email.toLowerCase(), accountId) as { id: string }[]
  ).map((r) => r.id);
}

/** A stored message as bulk changes see it: its labels, sender and provider thread. */
export type StoredMessage = { id: string; labels: string[]; from: string; remote: string };

/**
 * One account's stored messages, read in SQL so a bulk change needn't ask the provider about each:
 * those from `senders`, those in Trash, or every one (`all`). Mail the local copy hasn't got isn't here.
 */
export function storedMessages(accountId: string, only: { senders: string[] } | "trash" | "all"): Map<string, StoredMessage> {
  const narrow =
    only === "all" ? "1" : only === "trash" ? HAS("TRASH") : only.senders.length ? `(${only.senders.map(() => "instr(lower(t.data), ?) > 0").join(" OR ")})` : "0";
  const args = typeof only === "object" ? only.senders.map((s) => `"${s.toLowerCase()}"`) : [];
  const rows = getDb()
    .prepare(
      `SELECT json_extract(m.value, '$.id') AS id, json_extract(m.value, '$.labels') AS labels, lower(json_extract(m.value, '$.from.email')) AS sender,
         COALESCE(json_extract(m.value, '$.remoteThread'), t.remote_id) AS remote
       FROM threads t, json_each(t.data, '$.messages') m WHERE t.account_id = ? AND ${narrow}`,
    )
    .all(accountId, ...args) as { id: string; labels: string | null; sender: string | null; remote: string }[];
  const found = new Map<string, StoredMessage>();
  for (const r of rows) found.set(r.id, { id: r.id, labels: r.labels ? (JSON.parse(r.labels) as string[]) : [], from: r.sender ?? "", remote: r.remote });
  return found;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Every listed attachment in the local copy, newest first. Read straight from the
 * stored threads, so it stays in step with sync, deletes and resets.
 */
export function listFiles({
  accountId,
  query,
  kind,
  threadIds,
  people,
  parts,
  name,
  limit = 400,
  offset = 0,
}: {
  accountId: AccountScope;
  query: string;
  kind: Attachment["kind"] | null;
  /** Only these Kite threads. */
  threadIds?: string[];
  /** Only messages from, to or copied to one of these (lowercased) addresses. */
  people?: string[];
  /** Only these attachments. */
  parts?: { accountId: string; messageId: string; partId: string }[];
  /** Only files with exactly this name (any case). */
  name?: string;
  limit?: number;
  offset?: number;
}): FileItem[] {
  // Inline images belong to the message, not the file list (marked when mail is stored; older mail
  // by upgradeDerived). Reads the slim copies, so no bodies are parsed.
  const where = [NOT_HIDDEN, "COALESCE(json_extract(a.value, '$.inline'), 0) = 0"];
  const args: string[] = [];
  if (scopeIds(accountId)) {
    const s = scopeSql(accountId, "t.account_id");
    where.push(s.sql);
    args.push(...s.args);
  }
  if (threadIds) {
    if (!threadIds.length) return [];
    where.push(`t.id IN (${threadIds.map(() => "?").join(", ")})`);
    args.push(...threadIds);
  }
  if (people) {
    if (!people.length) return [];
    const list = people.map(() => "?").join(", ");
    const among = (field: string) => `EXISTS (SELECT 1 FROM json_each(m.value, '$.${field}') r WHERE lower(json_extract(r.value, '$.email')) IN (${list}))`;
    where.push(`(lower(json_extract(m.value, '$.from.email')) IN (${list}) OR ${among("to")} OR ${among("cc")})`);
    args.push(...people, ...people, ...people);
  }
  if (parts) {
    if (!parts.length) return [];
    where.push(`(${parts.map(() => "(t.account_id = ? AND json_extract(m.value, '$.id') = ? AND json_extract(a.value, '$.partId') = ?)").join(" OR ")})`);
    for (const p of parts) args.push(p.accountId, p.messageId, p.partId);
  }
  if (name) {
    where.push("lower(json_extract(a.value, '$.name')) = ?");
    args.push(name.toLowerCase());
  }
  for (const term of query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
    where.push(
      `lower(json_extract(a.value, '$.name') || ' ' || json_extract(${LIST_DATA}, '$.subject') || ' ' ||
        json_extract(m.value, '$.from.name') || ' ' || json_extract(m.value, '$.from.email') || ' ' || COALESCE((SELECT text FROM document_text dt WHERE dt.account_id = t.account_id AND dt.message_id = json_extract(m.value, '$.id') AND dt.part_id = json_extract(a.value, '$.partId')), '')) LIKE ? ESCAPE '!'`,
    );
    args.push(`%${term.replace(/[!%_]/g, (c) => `!${c}`)}%`);
  }
  const rows = getDb()
    .prepare(
      `SELECT t.id AS threadId, t.account_id AS accountId, json_extract(${LIST_DATA}, '$.subject') AS subject,
         json_extract(m.value, '$.id') AS messageId, json_extract(m.value, '$.date') AS date,
         json_extract(m.value, '$.from') AS sender, a.value AS attachment
       FROM threads t, ${MESSAGES}, json_each(m.value, '$.attachments') a
       WHERE ${where.join(" AND ")}
       ORDER BY date DESC, t.id, m.key, a.key LIMIT ${kind ? limit * 5 : limit} OFFSET ${Math.max(0, Math.floor(offset))}`,
    )
    .all(...args) as { threadId: string; accountId: string; subject: string; messageId: string; date: string; sender: string; attachment: string }[];
  // Type and kind are worked out again on read, so mail stored before a rule changed is still filed right.
  const files: FileItem[] = rows.map((row) => {
    const attachment = JSON.parse(row.attachment) as Attachment;
    return {
      ...attachment,
      mimeType: inferMimeType(attachment.name, attachment.mimeType),
      kind: attachmentKind(attachment.name, attachment.mimeType),
      accountId: row.accountId,
      threadId: row.threadId,
      messageId: row.messageId,
      subject: row.subject,
      from: JSON.parse(row.sender) as Contact,
      date: row.date,
    };
  });
  return files.filter((f) => !kind || f.kind === kind).slice(0, limit);
}

type AttachCandidates = { conversation: FileItem[]; people: FileItem[]; recent: FileItem[] };

/**
 * Files to offer in compose's "Attach from your files", in order: this conversation's, then
 * ones exchanged with the recipients, then recent ones. Each file appears once, in its first group.
 * Files without a part id can't be attached by reference, so they're left out.
 */
export function attachCandidates({
  threadIds,
  people,
  query,
  kind,
}: {
  threadIds: string[];
  people: string[];
  query: string;
  kind: Attachment["kind"] | null;
}): AttachCandidates {
  const seen = new Set<string>();
  const fresh = (files: FileItem[]) =>
    files.filter((f) => {
      const key = `${f.accountId}:${f.messageId}:${f.partId}`;
      if (!f.partId || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const base = { accountId: "all" as const, query, kind };
  return {
    conversation: fresh(threadIds.length ? listFiles({ ...base, threadIds, limit: 60 }) : []),
    people: fresh(people.length ? listFiles({ ...base, people, limit: 60 }) : []),
    recent: fresh(listFiles({ ...base, limit: 80 })),
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Stored conversations (with bodies) that mention an address, newest first, for the People panel. */
export function threadsWithPerson(email: string, scope: AccountScope, limit = 300): Thread[] {
  const s = scopeSql(scope, "t.account_id");
  const rows = getDb()
    .prepare(
      `SELECT t.data FROM threads t WHERE instr(lower(t.data), ?) > 0 AND ${NOT_HIDDEN}
       AND ${s.sql} ORDER BY t.last_date DESC LIMIT ${limit}`,
    )
    .all(`"${email.toLowerCase()}"`, ...s.args) as { data: string }[];
  return rows.map((r) => JSON.parse(r.data) as Thread);
}
