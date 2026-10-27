import "server-only";

import type { Thread } from "@/lib/mail/types";
import { getAccount, getDb, type AccountRow } from "./db";
import { assignMessages, getThreadRow, placeRemote, rowsHolding } from "./store";

// Local splits and merges. Gmail's threading is never changed: these only decide which Kite
// thread a Gmail message is stored in (message_moves, thread_merges; placement in store.ts).
// Each one is a row in `regroups`, and every row it wrote remembers what it replaced, so
// undo puts things back exactly. Thread operations on a split or merged conversation reach
// only its own messages (opTargets in store.ts).

export class RegroupError extends Error {}

const db = () => getDb();

/** The subject as the user sees it (a local rename wins). */
function shownSubject(thread: Thread) {
  const local = db().prepare("SELECT subject FROM thread_overrides WHERE thread_id = ?").get(thread.id) as { subject: string | null } | undefined;
  return local?.subject || thread.subject;
}

function addRegroup(kind: "split" | "merge", accountId: string, threadId: string, source: Thread) {
  const id = crypto.randomUUID();
  db()
    .prepare("INSERT INTO regroups (id, kind, account_id, thread_id, source_id, source_subject, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, kind, accountId, threadId, source.id, shownSubject(source), new Date().toISOString());
  return id;
}

/** Puts one Gmail message in a Kite thread, remembering where it was placed before. */
function setMove(accountId: string, messageId: string, remoteId: string, threadId: string, regroupId: string) {
  const prev = db().prepare("SELECT thread_id, regroup_id FROM message_moves WHERE account_id = ? AND message_id = ?").get(accountId, messageId) as
    | { thread_id: string; regroup_id: string }
    | undefined;
  db()
    .prepare(
      `INSERT INTO message_moves (account_id, message_id, remote_id, thread_id, regroup_id, previous, previous_regroup) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, message_id) DO UPDATE SET remote_id = excluded.remote_id, thread_id = excluded.thread_id,
         regroup_id = excluded.regroup_id, previous = excluded.previous, previous_regroup = excluded.previous_regroup`,
    )
    .run(accountId, messageId, remoteId, threadId, regroupId, prev?.thread_id ?? null, prev?.regroup_id ?? null);
}

/** Sends a whole Gmail thread (and its future messages) to a Kite thread. */
function setMerge(accountId: string, remoteId: string, threadId: string, regroupId: string) {
  const prev = db().prepare("SELECT thread_id, regroup_id FROM thread_merges WHERE account_id = ? AND remote_id = ?").get(accountId, remoteId) as
    | { thread_id: string; regroup_id: string }
    | undefined;
  db()
    .prepare(
      `INSERT INTO thread_merges (account_id, remote_id, thread_id, regroup_id, previous, previous_regroup) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, remote_id) DO UPDATE SET thread_id = excluded.thread_id, regroup_id = excluded.regroup_id,
         previous = excluded.previous, previous_regroup = excluded.previous_regroup`,
    )
    .run(accountId, remoteId, threadId, regroupId, prev?.thread_id ?? null, prev?.regroup_id ?? null);
}

/** Where a Gmail thread's messages go when nothing moved them. */
function defaultThread(accountId: string, remoteId: string) {
  const merge = db().prepare("SELECT thread_id FROM thread_merges WHERE account_id = ? AND remote_id = ?").get(accountId, remoteId) as
    | { thread_id: string }
    | undefined;
  return merge?.thread_id ?? `${accountId}:${remoteId}`;
}

function stored(id: string, missing: string) {
  const row = getThreadRow(id);
  if (!row) throw new RegroupError(missing);
  return { row, thread: JSON.parse(row.data) as Thread };
}

function transaction<T>(fn: () => T): T {
  db().exec("BEGIN");
  try {
    const result = fn();
    db().exec("COMMIT");
    return result;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}

/**
 * Detaches a message (and, with `following`, every later one) into its own conversation.
 * Later replies to the detached messages follow them; messages already there stay put.
 */
export function splitThread(account: AccountRow, key: string, messageId: string, following: boolean) {
  const sourceId = `${account.id}:${key}`;
  const { row, thread } = stored(sourceId, "That conversation isn't on this device yet. Open it once, then try again.");
  const index = thread.messages.findIndex((m) => m.id === messageId);
  if (index < 0) throw new RegroupError("That message isn't in this conversation any more.");
  const moved = following ? thread.messages.slice(index) : [thread.messages[index]];
  if (moved.length === thread.messages.length) throw new RegroupError("That's the whole conversation already.");
  const remoteOf = (m: Thread["messages"][number]) => m.remoteThread ?? row.remote_id;
  const threadId = `${account.id}:${remoteOf(moved[0])}~${moved[0].id}`;
  if (getThreadRow(threadId)) throw new RegroupError("That message already starts its own conversation.");

  return transaction(() => {
    const regroupId = addRegroup("split", account.id, threadId, thread);
    const movedIds = new Set(moved.map((m) => m.id));
    moved.forEach((m) => setMove(account.id, m.id, remoteOf(m), threadId, regroupId));
    const remotes = [...new Set(moved.map(remoteOf))];
    for (const remote of remotes) {
      // Messages already in the conversation stay where they are, even if they answer a moved one.
      const held = rowsHolding(account.id, remote);
      const all = held.flatMap((h) => h.thread.messages.filter((m) => (m.remoteThread ?? h.row.remote_id) === remote).map((m) => ({ m, at: h.row.id })));
      const assigned = assignMessages(account.id, remote, all.map((x) => x.m));
      for (const { m, at } of all) {
        if (!movedIds.has(m.id) && assigned.get(m.id) === threadId) setMove(account.id, m.id, remote, at, regroupId);
      }
    }
    for (const remote of remotes) placeRemote(account, remote, "stored", [sourceId, threadId]);
    return { regroupId, threadId };
  });
}

/** Joins other conversations into one (same account). Their future messages land in it too. */
export function mergeThreads(account: AccountRow, key: string, otherKeys: string[]) {
  const targetId = `${account.id}:${key}`;
  stored(targetId, "That conversation isn't on this device yet.");
  const others = [...new Set(otherKeys.map((k) => `${account.id}:${k}`))].filter((id) => id !== targetId);
  if (!others.length) throw new RegroupError("Pick another conversation to merge with.");
  const sources = others.map((id) => stored(id, "One of those conversations isn't on this device any more."));

  return transaction(() => {
    const regroupIds: string[] = [];
    for (const { row, thread } of sources) {
      const regroupId = addRegroup("merge", account.id, targetId, thread);
      regroupIds.push(regroupId);
      const remoteOf = (m: Thread["messages"][number]) => m.remoteThread ?? row.remote_id;
      const remotes = [...new Set(thread.messages.map(remoteOf))];
      // Gmail threads that went to the merged conversation now go to the kept one.
      for (const remote of remotes) if (defaultThread(account.id, remote) === thread.id) setMerge(account.id, remote, targetId, regroupId);
      thread.messages.forEach((m) => setMove(account.id, m.id, remoteOf(m), targetId, regroupId));
      for (const remote of remotes) placeRemote(account, remote, "stored", [thread.id, targetId]);
    }
    return { regroupIds, threadId: targetId };
  });
}

type RegroupRow = { id: string; kind: "split" | "merge"; account_id: string; thread_id: string; source_id: string };

/** Puts a split or merge back: every placement it wrote returns to what it replaced. */
export function undoRegroup(regroupId: string) {
  const regroup = db().prepare("SELECT * FROM regroups WHERE id = ?").get(regroupId) as RegroupRow | undefined;
  if (!regroup) throw new RegroupError("That was already put back.");
  const account = getAccount(regroup.account_id);
  if (!account) throw new RegroupError("That account isn't connected any more.");
  const live = (id: string | null) => !!id && !!db().prepare("SELECT 1 FROM regroups WHERE id = ? AND id != ?").get(id, regroupId);

  return transaction(() => {
    const remotes = (
      db()
        .prepare("SELECT remote_id FROM message_moves WHERE regroup_id = ? UNION SELECT remote_id FROM thread_merges WHERE regroup_id = ?")
        .all(regroupId, regroupId) as { remote_id: string }[]
    ).map((r) => r.remote_id);
    for (const table of ["message_moves", "thread_merges"] as const) {
      const key = table === "message_moves" ? "message_id" : "remote_id";
      const rows = db().prepare(`SELECT ${key} AS k, previous, previous_regroup FROM ${table} WHERE regroup_id = ?`).all(regroupId) as {
        k: string;
        previous: string | null;
        previous_regroup: string | null;
      }[];
      for (const r of rows) {
        if (r.previous && live(r.previous_regroup)) {
          db()
            .prepare(`UPDATE ${table} SET thread_id = ?, regroup_id = ?, previous = NULL, previous_regroup = NULL WHERE account_id = ? AND ${key} = ?`)
            .run(r.previous, r.previous_regroup, account.id, r.k);
        } else db().prepare(`DELETE FROM ${table} WHERE account_id = ? AND ${key} = ?`).run(account.id, r.k);
      }
    }
    db().prepare("DELETE FROM regroups WHERE id = ?").run(regroupId);
    for (const remote of remotes) placeRemote(account, remote, "stored", [regroup.thread_id, regroup.source_id]);
    return { kind: regroup.kind, accountId: account.id, threadId: regroup.thread_id, sourceId: regroup.source_id };
  });
}

