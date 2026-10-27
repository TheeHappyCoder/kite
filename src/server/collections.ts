import "server-only";

import type { CollectionColumn, CollectionData, CollectionRow, CollectionSummary } from "@/lib/automations/collections";
import type { FieldValues } from "@/lib/automations/fields";
import type { ThreadAmount } from "@/lib/mail/types";
import { getDb } from "./db";

// Collections (lib/automations/collections.ts), stored: your own tables, filled by automations'
// "Add to a collection" (server/rule-verbs.ts) and emptied row by row by Undo. Local only; they
// hold values read from your mail, so Disconnect removes an account's rows (db.ts deleteAccount).

export class CollectionError extends Error {
  name = "CollectionError";
}

type Row = {
  id: string;
  collection_id: string;
  rule_id: string | null;
  account_id: string;
  thread_id: string;
  message_id: string;
  subject: string;
  sender: string;
  at: string;
  fields: string;
  value_data: string;
};

const now = () => new Date().toISOString();

const toRow = (r: Row): CollectionRow => ({
  id: r.id,
  ruleId: r.rule_id,
  accountId: r.account_id,
  threadId: r.thread_id,
  messageId: r.message_id,
  subject: r.subject,
  sender: r.sender,
  at: r.at,
  values: JSON.parse(r.value_data) as FieldValues,
  columns: JSON.parse(r.fields) as CollectionColumn[],
});

export function listCollections(): CollectionSummary[] {
  return (
    getDb()
      .prepare(
        `SELECT c.id, c.name, COUNT(r.id) AS rows, MAX(r.at) AS last
         FROM collections c LEFT JOIN collection_rows r ON r.collection_id = c.id
         GROUP BY c.id ORDER BY c.name COLLATE NOCASE`,
      )
      .all() as { id: string; name: string; rows: number; last: string | null }[]
  ).map((c) => ({ id: c.id, name: c.name, rows: c.rows, last: c.last }));
}

export function collectionExists(id: string) {
  return !!getDb().prepare("SELECT 1 FROM collections WHERE id = ?").get(id);
}

/** One collection with its rows, newest first. */
export function getCollection(id: string, limit = 5000): CollectionData {
  const c = getDb().prepare("SELECT id, name FROM collections WHERE id = ?").get(id) as { id: string; name: string } | undefined;
  if (!c) throw new CollectionError("That collection is gone.");
  const rows = getDb().prepare("SELECT * FROM collection_rows WHERE collection_id = ? ORDER BY at DESC LIMIT ?").all(id, limit) as Row[];
  return { id: c.id, name: c.name, rows: rows.map(toRow) };
}

const cleanName = (name: string) => {
  const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!clean) throw new CollectionError("Give the collection a name.");
  return clean;
};

export function createCollection(name: string): CollectionSummary {
  const id = crypto.randomUUID();
  const clean = cleanName(name);
  getDb().prepare("INSERT INTO collections (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(id, clean, now(), now());
  return { id, name: clean, rows: 0, last: null };
}

export function renameCollection(id: string, name: string) {
  if (!getDb().prepare("UPDATE collections SET name = ?, updated_at = ? WHERE id = ?").run(cleanName(name), now(), id).changes) {
    throw new CollectionError("That collection is gone.");
  }
}

/** Deletes a collection and its rows (automations adding to it then skip that step). */
export function deleteCollection(id: string) {
  const db = getDb();
  db.prepare("DELETE FROM collection_rows WHERE collection_id = ?").run(id);
  db.prepare("DELETE FROM collections WHERE id = ?").run(id);
}

/** Adds one email's row; null when that email is already in the collection. */
export function addRow(input: Omit<CollectionRow, "id"> & { collectionId: string }): string | null {
  const id = crypto.randomUUID();
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO collection_rows (id, collection_id, rule_id, account_id, thread_id, message_id, subject, sender, at, fields, value_data, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.collectionId,
      input.ruleId,
      input.accountId,
      input.threadId,
      input.messageId,
      input.subject,
      input.sender,
      input.at,
      JSON.stringify(input.columns),
      JSON.stringify(input.values),
      now(),
    );
  return result.changes ? id : null;
}

/** What a row held before an email updated it, so Undo can put it back. */
export type RowBefore = Pick<Row, "thread_id" | "message_id" | "subject" | "sender" | "at" | "fields" | "value_data">;

/**
 * One row per thing: the row whose `key` value matches this email's (case-insensitive) takes the
 * email's values when the email is newer (an older email only fills what the row is missing).
 * Without a match, a new row. Returns what changed, or null when nothing did.
 */
export function upsertRow(
  input: Omit<CollectionRow, "id"> & { collectionId: string },
  key: string,
): { id: string; before: RowBefore | null } | null {
  const want = input.values[key]?.text.trim().toLowerCase();
  if (!want) {
    const id = addRow(input);
    return id ? { id, before: null } : null;
  }
  const db = getDb();
  const found = db
    .prepare(`SELECT * FROM collection_rows WHERE collection_id = ? AND lower(trim(json_extract(value_data, '$.' || ? || '.text'))) = ? ORDER BY at DESC LIMIT 1`)
    .get(input.collectionId, key, want) as Row | undefined;
  if (!found) {
    const id = addRow(input);
    return id ? { id, before: null } : null;
  }
  if (found.message_id === input.messageId) return null;
  const old = JSON.parse(found.value_data) as FieldValues;
  const newer = input.at >= found.at;
  const values: FieldValues = newer ? { ...old, ...Object.fromEntries(Object.entries(input.values).filter(([, v]) => v)) } : { ...input.values, ...Object.fromEntries(Object.entries(old).filter(([, v]) => v)) };
  const columns = new Map((JSON.parse(found.fields) as CollectionColumn[]).map((c) => [c.key, c]));
  for (const c of input.columns) if (!columns.has(c.key)) columns.set(c.key, c);
  if (JSON.stringify(values) === found.value_data && columns.size === (JSON.parse(found.fields) as CollectionColumn[]).length) return null;
  const before: RowBefore = { thread_id: found.thread_id, message_id: found.message_id, subject: found.subject, sender: found.sender, at: found.at, fields: found.fields, value_data: found.value_data };
  const latest = newer ? input : { threadId: found.thread_id, messageId: found.message_id, subject: found.subject, sender: found.sender, at: found.at };
  db.prepare("UPDATE collection_rows SET thread_id = ?, message_id = ?, subject = ?, sender = ?, at = ?, fields = ?, value_data = ? WHERE id = ?").run(
    latest.threadId,
    latest.messageId,
    latest.subject,
    latest.sender,
    latest.at,
    JSON.stringify([...columns.values()]),
    JSON.stringify(values),
    found.id,
  );
  return { id: found.id, before };
}

/** Undo of an update: the row as it was. */
export function restoreRow(id: string, before: RowBefore) {
  getDb()
    .prepare("UPDATE collection_rows SET thread_id = ?, message_id = ?, subject = ?, sender = ?, at = ?, fields = ?, value_data = ? WHERE id = ?")
    .run(before.thread_id, before.message_id, before.subject, before.sender, before.at, before.fields, before.value_data, id);
}

/** Rows of a collection that arrived in [start, end), oldest first (the month-end pack). */
export function rowsBetween(collectionId: string, start: string, end: string): CollectionRow[] {
  return (getDb().prepare("SELECT * FROM collection_rows WHERE collection_id = ? AND at >= ? AND at < ? ORDER BY at").all(collectionId, start, end) as Row[]).map(toRow);
}

export function collectionName(id: string) {
  return (getDb().prepare("SELECT name FROM collections WHERE id = ?").get(id) as { name: string } | undefined)?.name ?? null;
}

export function hasRow(collectionId: string, messageId: string) {
  return !!getDb().prepare("SELECT 1 FROM collection_rows WHERE collection_id = ? AND message_id = ?").get(collectionId, messageId);
}

export function removeRow(id: string) {
  getDb().prepare("DELETE FROM collection_rows WHERE id = ?").run(id);
}

/**
 * The amount an automation read from each conversation (its newest collected row with an amount),
 * by Kite thread id: Home and the inbox's Everything else side show it on the line.
 */
export function amountsByThread(threadIds: string[]) {
  const out = new Map<string, ThreadAmount>();
  const db = getDb();
  for (let i = 0; i < threadIds.length; i += 500) {
    const ids = threadIds.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT thread_id, fields, value_data FROM collection_rows WHERE thread_id IN (${ids.map(() => "?").join(",")}) ORDER BY at DESC`)
      .all(...ids) as Pick<Row, "thread_id" | "fields" | "value_data">[];
    for (const row of rows) {
      if (out.has(row.thread_id)) continue;
      const column = (JSON.parse(row.fields) as CollectionColumn[]).find((c) => c.type === "money");
      const value = column ? (JSON.parse(row.value_data) as FieldValues)[column.key] : null;
      if (value?.number != null) out.set(row.thread_id, { value: value.number, currency: value.currency ?? "" });
    }
  }
  return out;
}
