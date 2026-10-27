import "server-only";

import type { PreparedReply } from "@/lib/rules/prepared";
import { getDb } from "./db";

// Replies prepared by rules (the prepare_reply verb), one per conversation, keyed by Kite thread
// id. Local only: Kite never sends one by itself. The reader shows it in the quick-reply box;
// sending a reply, Discard, or Undo of the rule's run removes it. Bodies can hold names from
// mail, so they stay out of logs.

type Row = {
  thread_id: string;
  id: string;
  account_id: string;
  rule_id: string;
  rule_name: string;
  message_id: string;
  body: string;
  missing: string;
  created_at: string;
  ai: number;
};

function fromRow(row: Row): PreparedReply {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    messageId: row.message_id,
    body: row.body,
    missing: JSON.parse(row.missing) as string[],
    createdAt: row.created_at,
    ...(row.ai ? { ai: true } : {}),
  };
}

export function getPrepared(threadId: string): PreparedReply | null {
  const row = getDb().prepare("SELECT * FROM prepared_replies WHERE thread_id = ?").get(threadId) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** Stores a prepared reply, replacing an older one for the same conversation. */
export function putPrepared(
  threadId: string,
  accountId: string,
  reply: Omit<PreparedReply, "createdAt">,
) {
  getDb()
    .prepare(
      `INSERT INTO prepared_replies (thread_id, id, account_id, rule_id, rule_name, message_id, body, missing, created_at, ai)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET id = excluded.id, rule_id = excluded.rule_id, rule_name = excluded.rule_name,
         message_id = excluded.message_id, body = excluded.body, missing = excluded.missing, created_at = excluded.created_at, ai = excluded.ai`,
    )
    .run(threadId, reply.id, accountId, reply.ruleId, reply.ruleName, reply.messageId, reply.body, JSON.stringify(reply.missing), new Date().toISOString(), reply.ai ? 1 : 0);
}

/**
 * Discard (or sent): with `id`, only that one (Undo leaves a newer prepared reply alone). An AI
 * draft still waiting for the AI is called off too, so it never lands after the fact.
 */
export function discardPrepared(threadId: string, id?: string) {
  const db = getDb();
  if (id) db.prepare("DELETE FROM prepared_replies WHERE thread_id = ? AND id = ?").run(threadId, id);
  else db.prepare("DELETE FROM prepared_replies WHERE thread_id = ?").run(threadId);
  db.prepare(`UPDATE ai_jobs SET status = 'cancelled', reason = 'Discarded' WHERE thread_id = ? AND status = 'queued'${id ? " AND id = ?" : ""}`).run(...(id ? [threadId, id] : [threadId]));
}

/** A reply your AI drafted (or is about to draft) already waits here: a rule's "Draft with AI" makes one per conversation. */
export function hasAiDraft(threadId: string) {
  const db = getDb();
  return !!(
    db.prepare("SELECT 1 FROM prepared_replies WHERE thread_id = ? AND ai = 1").get(threadId) ||
    db.prepare("SELECT 1 FROM ai_jobs WHERE thread_id = ? AND status = 'queued'").get(threadId)
  );
}
