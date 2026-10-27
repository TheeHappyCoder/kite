import type { ReplyCandidate, RepliesData } from "./replies";
import type { Thread, ThreadAmount } from "./mail/types";

// Home's mail, with plain rules (no AI) and the provider's own sorting: people are To reply and
// Waiting on (lib/replies.ts); what the provider files under Updates, Social or Forums (Outlook's
// Other) is "Updates", one line each, with the amount an automation collected from it; Promotions
// and mailing lists go to the reading shelf. The rest of Primary is the Inbox's, not Home's.
// Read-only: sorting here moves no mail.

export type HomeLine = {
  threadId: string;
  accountId: string;
  /** Who sent the newest message. */
  name: string;
  email: string;
  subject: string;
  preview: string;
  at: string;
  unread: boolean;
  amount?: ThreadAmount;
};

export type HomeData = {
  /** Updates (the provider's Updates, Social and Forums, plus anything an automation collected an amount from), newest first. */
  things: HomeLine[];
  /** Promotions and mailing lists, newest first. */
  reading: HomeLine[];
};

/** What a candidate carries beyond ReplyCandidate: whether it came from a mailing list (List-Unsubscribe). */
export type HomeCandidate = ReplyCandidate & { list: boolean };


const LIMITS = { things: 80, reading: 12 };
const DAY = 86_400_000;

/** How many days back Home looks. */
export const HOME_DAYS = 21;

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

function lineOf(thread: Thread, amount?: ThreadAmount): HomeLine {
  const sent = thread.messages.filter((m) => !m.draft);
  const last = sent[sent.length - 1] ?? thread.messages[thread.messages.length - 1];
  return {
    threadId: thread.id,
    accountId: thread.accountId,
    name: last.from.name || last.from.email,
    email: last.from.email,
    subject: thread.subject,
    preview: last.preview ?? last.snippet ?? "",
    at: last.date,
    unread: thread.unread,
    amount,
  };
}

/**
 * Sorts the inbox for Home. Conversations already in `people` (To reply, Waiting on) are left out;
 * `amounts` are what automations collected, per Kite thread id; `me` is each account's own address.
 */
export function sortHome(
  candidates: HomeCandidate[],
  people: RepliesData,
  { amounts, me, now }: { amounts: Map<string, ThreadAmount>; me: (accountId: string) => string | undefined; now: number },
): HomeData {
  const shown = new Set([...people.toReply, ...people.waiting].map((i) => i.threadId));
  const since = now - HOME_DAYS * DAY;
  const out: HomeData = { things: [], reading: [] };
  for (const { thread, inbox, list } of candidates) {
    if (!inbox || shown.has(thread.id)) continue;
    const sent = thread.messages.filter((m) => !m.draft);
    const last = sent[sent.length - 1];
    if (!last || new Date(last.date).getTime() < since) continue;
    const own = me(thread.accountId);
    if (own && same(last.from.email, own)) continue;
    const found = amounts.get(thread.id);
    if (found) {
      out.things.push(lineOf(thread, found));
      continue;
    }
    if (thread.category === "notifications" || thread.category === "other") out.things.push(lineOf(thread));
    else if (thread.category === "newsletters" || list) out.reading.push(lineOf(thread));
  }
  const newest = (a: HomeLine, b: HomeLine) => b.at.localeCompare(a.at);
  return {
    things: out.things.sort(newest).slice(0, LIMITS.things),
    reading: out.reading.sort(newest).slice(0, LIMITS.reading),
  };
}

/** "Good morning" by the local hour. */
export function greeting(hour: number) {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  return "evening";
}
