import "server-only";

import { patchOverride, type OverridePatch, type ThreadOverride } from "@/lib/mail/overrides";
import { getDb } from "./db";
import { reindexThread } from "./store";

// Local per-thread state (thread_overrides). Sync never writes here, so it survives every
// upsert and "Reset local copy".

type OverrideRow = {
  thread_id: string;
  chat: number | null;
  muted: number;
  pinned_at: string | null;
  note: string | null;
  subject: string | null;
  reply_done: string | null;
  reply_off: number;
};

function fromRow(row: OverrideRow): ThreadOverride {
  const o: ThreadOverride = {};
  if (row.chat !== null) o.chat = row.chat === 1;
  if (row.muted) o.muted = true;
  if (row.pinned_at) o.pinnedAt = row.pinned_at;
  if (row.note) o.note = row.note;
  if (row.subject) o.subject = row.subject;
  if (row.reply_done) o.replyDone = row.reply_done;
  if (row.reply_off) o.replyOff = true;
  return o;
}

export function listOverrides(): Record<string, ThreadOverride> {
  const rows = getDb().prepare("SELECT * FROM thread_overrides").all() as OverrideRow[];
  return Object.fromEntries(rows.map((r) => [r.thread_id, fromRow(r)]));
}

export function getOverride(threadId: string): ThreadOverride | undefined {
  const row = getDb().prepare("SELECT * FROM thread_overrides WHERE thread_id = ?").get(threadId) as OverrideRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Writes (or removes) a thread's override, replacing it entirely. */
function putOverride(threadId: string, override: ThreadOverride | null) {
  const db = getDb();
  if (!override) db.prepare("DELETE FROM thread_overrides WHERE thread_id = ?").run(threadId);
  else
    db.prepare(
      `INSERT INTO thread_overrides (thread_id, chat, muted, pinned_at, note, note_at, subject, reply_done, reply_off, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN ?5 IS NULL THEN NULL ELSE ?9 END, ?6, ?7, ?8, ?9)
       ON CONFLICT(thread_id) DO UPDATE SET chat = excluded.chat, muted = excluded.muted, pinned_at = excluded.pinned_at,
         note = excluded.note,
         note_at = CASE WHEN excluded.note IS NULL THEN NULL WHEN excluded.note IS thread_overrides.note THEN thread_overrides.note_at ELSE excluded.updated_at END,
         subject = excluded.subject, reply_done = excluded.reply_done, reply_off = excluded.reply_off,
         updated_at = excluded.updated_at`,
    ).run(
      threadId,
      override.chat === undefined ? null : override.chat ? 1 : 0,
      override.muted ? 1 : 0,
      override.pinnedAt ?? null,
      override.note ?? null,
      override.subject ?? null,
      override.replyDone ?? null,
      override.replyOff ? 1 : 0,
      new Date().toISOString(),
    );
}

/** Applies one change; notes and subjects are searchable, so the thread is indexed again. */
export function updateOverride(threadId: string, patch: OverridePatch) {
  const next = patchOverride(getOverride(threadId), patch);
  putOverride(threadId, next);
  if (patch.note !== undefined || patch.subject !== undefined) reindexThread(threadId);
  return next;
}

/** Whether new mail in this conversation should skip the inbox. */
export function isMuted(threadId: string) {
  return !!getDb().prepare("SELECT 1 FROM thread_overrides WHERE thread_id = ? AND muted = 1").get(threadId);
}
