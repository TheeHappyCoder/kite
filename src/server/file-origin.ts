import "server-only";

import { createHash } from "node:crypto";
import type { FileItem } from "@/lib/mail/types";
import { getDb } from "./db";
import { listFiles } from "./store";

// Where a file on disk came from: Kite keeps a SHA-256 of every attachment whose bytes it already has
// (opened, downloaded, read through the drive), never downloading anything just to fingerprint it.
// A dropped or right-clicked file is hashed where it is (the page or the desktop shell), so only the
// hash and its name reach here.

export const SHA = /^[0-9a-f]{64}$/;

/** Whether the attachment is still in the local copy (a download can finish after Disconnect or Reset local copy). */
export function partStored(accountId: string, messageId: string, partId: string) {
  return !!getDb().prepare(`SELECT 1 FROM accounts a JOIN threads t ON t.account_id = a.id,
    json_each(t.list_data, '$.messages') m, json_each(m.value, '$.attachments') p
    WHERE a.id = ? AND json_extract(m.value, '$.id') = ?
      AND json_extract(p.value, '$.partId') = ? LIMIT 1`).get(accountId, messageId, partId);
}

/** Keeps the file's fingerprint, once per attachment. */
export function rememberPrint(accountId: string, messageId: string, partId: string, data: Buffer) {
  const db = getDb();
  if (db.prepare("SELECT 1 FROM file_prints WHERE account_id = ? AND message_id = ? AND part_id = ?").get(accountId, messageId, partId)) return;
  if (!partStored(accountId, messageId, partId)) return;
  const sha = createHash("sha256").update(data).digest("hex");
  db.prepare("INSERT OR REPLACE INTO file_prints VALUES (?, ?, ?, ?)").run(accountId, messageId, partId, sha);
}

export type FileOrigin = {
  /** The same bytes, newest first. */
  exact: FileItem[];
  /** No exact match: files with the same name, newest first. A guess, shown as one. */
  named: FileItem[];
};

export function findOrigin(sha: string | null, name: string, part?: { accountId: string; messageId: string; partId: string }): FileOrigin {
  if (part) {
    const exact = listFiles({ accountId: "all", query: "", kind: null, parts: [part], limit: 1 });
    if (exact.length) return { exact, named: [] };
  }
  const parts = !sha ? [] : getDb().prepare("SELECT account_id AS accountId, message_id AS messageId, part_id AS partId FROM file_prints WHERE sha = ? LIMIT 50")
    .all(sha) as { accountId: string; messageId: string; partId: string }[];
  const exact = parts.length ? listFiles({ accountId: "all", query: "", kind: null, parts, limit: 20 }) : [];
  const named = exact.length || !name ? [] : listFiles({ accountId: "all", query: "", kind: null, name, limit: 5 });
  return { exact, named };
}
