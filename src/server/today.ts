import "server-only";

import type { Thread } from "@/lib/mail/types";
import { inScope, type AccountScope } from "@/lib/mail/scope";
import type { TodayData, TodayFollowup, TodayPinned, TodayScheduled, TodaySnooze } from "@/lib/today";
import { getDb, listAccounts, listSnoozes } from "./db";
import { listEvents } from "./events";
import type { OutgoingMessage } from "./mail/types";
import { getOverride } from "./overrides";
import { collectReplies } from "./replies";
import { listExpectations } from "./expectations";
import { getThreadRow, rowsHolding } from "./store";

// Collects Today from the local copy (read-only), calendar events included (server/events.ts). Dates go out as ISO strings in a window
// a little wider than the week shown; the client groups them by its own local day.

const DAY = 86_400_000;
/** Covers yesterday and the next 7 days in any time zone. */
const BEFORE = 3 * DAY;
const AFTER = 9 * DAY;

/** The subject the user sees: the local rename, else Gmail's. */
function subjectOf(threadId: string, fallback: string) {
  return getOverride(threadId)?.subject ?? fallback;
}

function storedThread(threadId: string) {
  const row = getThreadRow(threadId);
  return row ? (JSON.parse(row.data) as Thread) : null;
}

function within(iso: string, now: number) {
  const time = new Date(iso).getTime();
  return !Number.isNaN(time) && time >= now - BEFORE && time <= now + AFTER;
}

/** Nudges that fired (no reply yet) and ones coming due, with the conversation they're about. */
function followups(accountIds: Set<string>): TodayFollowup[] {
  const rows = getDb()
    .prepare("SELECT * FROM followups WHERE status = 'nudged' OR status = 'pending' ORDER BY due_at")
    .all() as {
    id: string;
    account_id: string;
    thread_remote_id: string;
    sent_at: string;
    due_at: string;
    status: "pending" | "nudged";
  }[];
  return rows.flatMap((row) => {
    if (!accountIds.has(row.account_id)) return [];
    // The Gmail thread may have been split or merged since: open the newest conversation holding it.
    const home = rowsHolding(row.account_id, row.thread_remote_id).sort((a, b) => b.row.last_date.localeCompare(a.row.last_date))[0];
    if (!home) return [];
    return [
      {
        id: row.id,
        status: row.status,
        sentAt: row.sent_at,
        dueAt: row.due_at,
        threadId: home.row.id,
        accountId: row.account_id,
        subject: subjectOf(home.row.id, home.thread.subject),
      },
    ];
  });
}

function snoozes(accountIds: Set<string>, now: number): TodaySnooze[] {
  return [...accountIds].flatMap((accountId) =>
    listSnoozes(accountId).flatMap((snooze) => {
      if (!within(snooze.until, now)) return [];
      // Snoozes are stored under the thread key.
      const threadId = `${accountId}:${snooze.thread_id}`;
      const thread = storedThread(threadId);
      return thread ? [{ threadId, accountId, subject: subjectOf(threadId, thread.subject), until: snooze.until }] : [];
    }),
  );
}

function sending(accountIds: Set<string>, now: number): TodayScheduled[] {
  const rows = getDb()
    .prepare("SELECT id, account_id, payload, send_at FROM scheduled WHERE status = 'pending' AND json_extract(payload, '$.held') IS NULL AND send_at <= ? ORDER BY send_at")
    .all(new Date(now + AFTER).toISOString()) as { id: string; account_id: string; payload: string; send_at: string }[];
  return rows.flatMap((row) => {
    if (!accountIds.has(row.account_id)) return [];
    const message = JSON.parse(row.payload) as OutgoingMessage;
    const to = message.to.map((a) => a.name || a.email).join(", ");
    return [{ id: row.id, accountId: row.account_id, subject: message.subject || "(no subject)", to, sendAt: row.send_at }];
  });
}

function pinned(accountIds: Set<string>): TodayPinned[] {
  const rows = getDb()
    .prepare(
      `SELECT o.thread_id, o.pinned_at, o.subject, t.account_id, t.data FROM thread_overrides o
       JOIN threads t ON t.id = o.thread_id WHERE o.pinned_at IS NOT NULL ORDER BY o.pinned_at DESC`,
    )
    .all() as { thread_id: string; pinned_at: string; subject: string | null; account_id: string; data: string }[];
  return rows.flatMap((row) => {
    if (!accountIds.has(row.account_id)) return [];
    const thread = JSON.parse(row.data) as Thread;
    const last = thread.messages[thread.messages.length - 1];
    return [{ threadId: row.thread_id, accountId: row.account_id, subject: row.subject ?? thread.subject, from: last?.from.name || last?.from.email || "", pinnedAt: row.pinned_at }];
  });
}

export function collectToday(scope: AccountScope): TodayData {
  const accountIds = new Set(listAccounts().map((a) => a.id).filter((id) => inScope(scope, id)));
  const now = Date.now();
  return {
    followups: followups(accountIds),
    waking: snoozes(accountIds, now),
    sending: sending(accountIds, now),
    pinned: pinned(accountIds),
    events: listEvents(accountIds, new Date(now - BEFORE).toISOString(), new Date(now + AFTER).toISOString()),
    replies: collectReplies(accountIds, now),
    expected: listExpectations(scope),
  };
}
