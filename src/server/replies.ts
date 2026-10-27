import "server-only";

import { remotesOf } from "@/lib/mail/threads";
import { splitMessage } from "@/lib/mail/quotes";
import type { Thread } from "@/lib/mail/types";
import { findReplies, REPLY_WINDOW_DAYS, type RepliesData } from "@/lib/replies";
import { acquaintance, ownNames } from "./contacts";
import { getDb, listAccounts } from "./db";
import { getOverride } from "./overrides";
import { getPreferences } from "./settings";
import { getThreadRow, replyCandidates } from "./store";

// Reply tracking for Today (rules in lib/replies.ts), read from the local copy on each request.
// Read-only: nothing here changes mail. Conversations with a nudge the user set at send time stay
// in "Follow-ups due" instead of showing twice.

/** Gmail threads (account|remote) with a pending or fired send-time nudge. */
function nudged() {
  const rows = getDb().prepare("SELECT account_id, thread_remote_id FROM followups WHERE status IN ('pending', 'nudged')").all() as {
    account_id: string;
    thread_remote_id: string;
  }[];
  return new Set(rows.map((r) => `${r.account_id}|${r.thread_remote_id}`));
}

/**
 * Conversations dismissed from To reply, per sender of the message they were about: dismissing a
 * stranger's conversation teaches Kite you don't answer them.
 */
function dismissedBySender(own: Set<string>) {
  const rows = getDb()
    .prepare("SELECT t.list_data AS data FROM thread_overrides o JOIN threads t ON t.id = o.thread_id WHERE o.reply_off = 1")
    .all() as { data: string }[];
  const counts = new Map<string, number>();
  for (const row of rows) {
    const theirs = (JSON.parse(row.data) as Thread).messages.filter((m) => !m.draft && !own.has(m.from.email.toLowerCase()));
    const email = theirs[theirs.length - 1]?.from.email.trim().toLowerCase();
    if (email) counts.set(email, (counts.get(email) ?? 0) + 1);
  }
  return counts;
}

/** The message's whole new text from the full copy (the slim one only has a one-line preview). */
function freshText(thread: Thread, messageId: string) {
  const row = getThreadRow(thread.id);
  const message = row ? (JSON.parse(row.data) as Thread).messages.find((m) => m.id === messageId) : undefined;
  return message ? splitMessage(message).text.fresh : undefined;
}

export function collectReplies(accountIds: Set<string>, now: number): RepliesData {
  const accounts = listAccounts().filter((a) => accountIds.has(a.id));
  const own = new Map(accounts.map((a) => [a.id, a.email]));
  const followed = nudged();
  const since = new Date(now - REPLY_WINDOW_DAYS * 86_400_000).toISOString();
  const candidates = replyCandidates([...own.keys()], since).filter(
    ({ thread }) => !remotesOf(thread).some((remote) => followed.has(`${thread.accountId}|${remote}`)),
  );
  const dismissed = dismissedBySender(new Set(listAccounts().map((a) => a.email.toLowerCase())));
  const found = findReplies(candidates, {
    me: (id) => own.get(id),
    people: acquaintance,
    dismissed: (email) => dismissed.get(email.trim().toLowerCase()) ?? 0,
    ownNames: ownNames(),
    waitDays: getPreferences().compose.waitDays,
    now,
    freshText: (thread, message) => freshText(thread, message.id) ?? message.preview ?? "",
  });
  // The local rename is what the user sees everywhere else.
  const named = (list: RepliesData["toReply"]) => list.map((item) => ({ ...item, subject: getOverride(item.threadId)?.subject ?? item.subject }));
  return { toReply: named(found.toReply), waiting: named(found.waiting) };
}
