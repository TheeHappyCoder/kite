import type { CalendarEvent } from "./calendar/event";
import { demoEvents } from "./calendar/week";
import type { Thread } from "./mail/types";
import { ALL_ACCOUNTS, inScope, type AccountScope } from "./mail/scope";
import type { ThreadOverride } from "./mail/overrides";
import { acquaintances, findReplies, shownReplies, type RepliesData } from "./replies";
import { NUDGES, isReady, stepOf, type Expectation } from "./automations/expect";

// Today: what's due, waking, sending and pinned, gathered from the local copy. Facts only:
// nudges the user asked for, snoozes and scheduled sends the user set, pins, and events in the
// user's own calendar.
// Reply tracking (lib/replies.ts) reads who wrote last and to whom, with plain rules; it only
// orders and surfaces conversations.
//
// The server returns ISO dates in a slightly wider window; the client groups them by its
// local day (lib functions below), so "today" always means the user's today.

/** A follow-up nudge the user asked for when sending. */
export type TodayFollowup = {
  id: string;
  status: "pending" | "nudged";
  sentAt: string;
  dueAt: string;
  threadId: string;
  accountId: string;
  subject: string;
};

export type TodaySnooze = { threadId: string; accountId: string; subject: string; until: string };

export type TodayScheduled = { id: string; accountId: string; subject: string; to: string; sendAt: string };

export type TodayPinned = { threadId: string; accountId: string; subject: string; from: string; pinnedAt: string };

export type TodayData = {
  followups: TodayFollowup[];
  waking: TodaySnooze[];
  sending: TodayScheduled[];
  pinned: TodayPinned[];
  /** Events from the accounts' own calendars (empty unless "Use your calendar" is on). */
  events: CalendarEvent[];
  /** To reply and Waiting on, Done and Dismiss not yet taken out (`todayFor` does that). */
  replies: RepliesData;
  /** What automations are waiting for (the expect verb), open ones and the last fortnight's answered. */
  expected: Expectation[];
};

/** Days ahead Coming up covers, today included. */
export const DAYS_AHEAD = 7;

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A stored date as a Date; "2026-10-15" (typed in a correction) is that local day, not UTC midnight. */
export function parseWhen(value: string) {
  const plain = DATE_ONLY.exec(value);
  const date = plain ? new Date(Number(plain[1]), Number(plain[2]) - 1, Number(plain[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Whole local days from `now`'s day to `date`'s day (0 today, 1 tomorrow, -1 yesterday). */
function dayOffset(date: Date, now: Date) {
  // Rounded, so a daylight-saving change never shifts a day.
  return Math.round((startOfDay(date).getTime() - startOfDay(now).getTime()) / 86_400_000);
}

const isSameDay = (value: string, now: Date) => {
  const date = parseWhen(value);
  return !!date && dayOffset(date, now) === 0;
};

/** True when a time falls on or before the end of `now`'s day (due today, or already due). */
const dueByToday = (value: string, now: Date) => {
  const date = parseWhen(value);
  return !!date && dayOffset(date, now) <= 0;
};

export type DayGroup = { offset: number; events: CalendarEvent[] };

/** The local days an event is on, as offsets from `now`'s day (all-day events: every day they cover). */
function eventDays(event: CalendarEvent, now: Date) {
  const start = parseWhen(event.start);
  if (!start) return [];
  const first = dayOffset(start, now);
  if (!event.allDay) return [first];
  const end = event.end ? parseWhen(event.end) : null;
  // The end is exclusive: a one-day event ends at the next day's start.
  const last = end ? Math.max(first, dayOffset(end, now) - 1) : first;
  return Array.from({ length: Math.min(last - first + 1, 60) }, (_, i) => first + i);
}

/** Coming up, grouped by local day: today and the next six days, all-day events on top, declined ones left out. */
function groupByDay(now: Date, events: CalendarEvent[] = []): DayGroup[] {
  const groups = new Map<number, DayGroup>();
  const group = (offset: number) => {
    let found = groups.get(offset);
    if (!found) groups.set(offset, (found = { offset, events: [] }));
    return found;
  };
  const shown = (offset: number) => offset >= -1 && offset < DAYS_AHEAD;
  for (const event of events) {
    if (event.you === "declined") continue;
    // Yesterday's meetings are over.
    for (const offset of eventDays(event, now)) if (shown(offset) && offset >= 0) group(offset).events.push(event);
  }
  return [...groups.values()]
    .sort((a, b) => a.offset - b.offset)
    .map((day) => ({
      offset: day.offset,
      events: day.events.sort((a, b) => Number(b.allDay) - Number(a.allDay) || (parseWhen(a.start)?.getTime() ?? 0) - (parseWhen(b.start)?.getTime() ?? 0) || a.summary.localeCompare(b.summary)),
    }));
}

/** What each part of Today shows for `now` (the server sends a wider window). */
export function todayFor(data: TodayData, now: Date, overrides: Record<string, ThreadOverride> = {}) {
  return {
    replies: shownReplies(data.replies, overrides),
    days: groupByDay(now, data.events),
    followups: data.followups.filter((f) => f.status === "nudged" || dueByToday(f.dueAt, now)),
    waking: data.waking.filter((s) => isSameDay(s.until, now)).sort((a, b) => a.until.localeCompare(b.until)),
    sending: data.sending.filter((s) => dueByToday(s.sendAt, now)).sort((a, b) => a.sendAt.localeCompare(b.sendAt)),
    pinned: data.pinned,
  };
}

/** The sidebar count: things due today (not yesterday's, not pins). */
export function dueTodayCount(data: TodayData, now: Date) {
  const shown = todayFor(data, now);
  // Things due, not meetings: and every request or nudge ready to send.
  return shown.followups.length + shown.waking.length + shown.sending.length + data.expected.filter((e) => isReady(stepOf(e, now.getTime()))).length;
}

/**
 * Demo mode has no local store: snoozes, scheduled messages, nudges and pins come from the
 * sample threads, and events from the sample invites.
 */
export function demoToday(
  threads: Thread[],
  overrides: Record<string, ThreadOverride>,
  replies: { accounts: { id: string; email: string }[]; waitDays: number; now: number },
): TodayData {
  const subjectOf = (t: Thread) => overrides[t.id]?.subject ?? t.subject;
  const lastFrom = (t: Thread) => t.messages[t.messages.length - 1]?.from.name ?? "";
  const own = new Map(replies.accounts.map((a) => [a.id, a.email]));
  const ownEmails = new Set(replies.accounts.map((a) => a.email.toLowerCase()));
  const dismissed = new Map<string, number>();
  for (const t of threads) {
    if (!overrides[t.id]?.replyOff) continue;
    const email = t.messages.filter((m) => !m.draft && !ownEmails.has(m.from.email.toLowerCase())).at(-1)?.from.email.toLowerCase();
    if (email) dismissed.set(email, (dismissed.get(email) ?? 0) + 1);
  }
  const found = findReplies(
    threads.filter((t) => !t.muted && !overrides[t.id]?.muted && !t.reminder).map((thread) => ({
      thread,
      inbox: thread.mailbox === "inbox",
      bulk: thread.category === "newsletters" || thread.category === "notifications",
    })),
    {
      me: (id) => own.get(id),
      people: acquaintances(threads, ownEmails),
      dismissed: (email) => dismissed.get(email.trim().toLowerCase()) ?? 0,
      waitDays: replies.waitDays,
      now: replies.now,
    },
  );
  const named = (list: RepliesData["toReply"]) => list.map((item) => ({ ...item, subject: overrides[item.threadId]?.subject ?? item.subject }));
  return {
    replies: { toReply: named(found.toReply), waiting: named(found.waiting) },
    expected: demoExpected(found.waiting, replies.now),
    followups: threads
      .filter((t) => t.reminder)
      .map((t) => ({
        id: t.id,
        status: "nudged",
        sentAt: t.reminder!.sentAt,
        dueAt: t.reminder!.sentAt,
        threadId: t.id,
        accountId: t.accountId,
        subject: subjectOf(t),
      })),
    waking: threads
      .filter((t) => t.mailbox === "snoozed" && t.snoozedUntil)
      .map((t) => ({ threadId: t.id, accountId: t.accountId, subject: subjectOf(t), until: t.snoozedUntil! })),
    sending: threads
      .filter((t) => t.scheduled)
      .map((t) => ({
        id: t.scheduled!.id,
        accountId: t.accountId,
        subject: subjectOf(t),
        to: t.messages[0]?.to.map((c) => c.name || c.email).join(", ") ?? "",
        sendAt: t.scheduled!.sendAt,
      })),
    pinned: threads
      .filter((t) => overrides[t.id]?.pinnedAt)
      .map((t) => ({ threadId: t.id, accountId: t.accountId, subject: subjectOf(t), from: lastFrom(t), pinnedAt: overrides[t.id].pinnedAt! }))
      .sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt)),
    events: demoEvents(threads),
  };
}

/**
 * Demo mode's Waiting on checklist: the sample conversations you're waiting on, as a "Get paid"
 * automation would track them (one nudge ready, one not due yet), plus a monthly request.
 */
function demoExpected(waiting: RepliesData["waiting"], now: number): Expectation[] {
  const DAY = 86_400_000;
  const base = (i: number, at: number): Omit<Expectation, "id" | "threadId" | "who" | "subject" | "accountId"> => ({
    ruleId: "demo-get-paid",
    ruleName: "Get paid",
    answer: "",
    plan: { askSubject: "", ask: "", nudges: NUDGES, every: 7, auto: false },
    since: new Date(at).toISOString(),
    dueAt: new Date(at + (i === 0 ? 14 : 20) * DAY).toISOString(),
    askedAt: null,
    nudged: 0,
    nudgedAt: null,
    status: "waiting",
    metAt: null,
    metThreadId: null,
    error: null,
  });
  // As a "Get paid" automation would have started them when you sent: the first nudge is ready three days on.
  const fromThreads = waiting.slice(0, 2).map((item, i) => ({
    ...base(i, Date.parse(item.at)),
    dueAt: new Date(Date.parse(item.at) + (i === 0 ? 3 : 10) * DAY).toISOString(),
    id: `demo-expect-${i}`,
    threadId: item.threadId,
    accountId: item.accountId,
    who: [{ email: item.person.email, name: item.person.name }],
    subject: item.subject,
  }));
  const accountId = waiting[0]?.accountId ?? "demo";
  const period = new Date(now - 30 * DAY).toLocaleString("en-GB", { month: "long", year: "numeric" });
  const ask = (i: number, name: string, email: string, met: boolean): Expectation => ({
    ...base(0, now - 6 * DAY),
    id: `demo-ask-${i}`,
    ruleId: "demo-documents",
    ruleName: "Client documents",
    threadId: null,
    accountId,
    who: [{ email, name }],
    subject: `Documents for ${period}`,
    plan: { askSubject: "Documents for {period}", ask: "Hi {first_name},\n\nCould you send me your statements for {period}?\n\nThanks", nudges: NUDGES.slice(0, 2), every: 4, auto: false, period },
    askedAt: new Date(now - 6 * DAY).toISOString(),
    dueAt: new Date(now - DAY).toISOString(),
    status: met ? "met" : "waiting",
    metAt: met ? new Date(now - 2 * DAY).toISOString() : null,
  });
  return [...fromThreads, ask(0, "Thandi Mokoena", "thandi@mokoena-design.co.za", false), ask(1, "Pieter van Wyk", "pieter@vanwykbuild.co.za", true)];
}

/** Narrows Today to the accounts in view (the account switcher). */
export function forAccount(data: TodayData, scope: AccountScope): TodayData {
  if (scope === ALL_ACCOUNTS) return data;
  const mine = <T extends { accountId: string }>(list: T[]) => list.filter((x) => inScope(scope, x.accountId));
  return {
    followups: mine(data.followups),
    waking: mine(data.waking),
    sending: mine(data.sending),
    pinned: mine(data.pinned),
    events: mine(data.events),
    replies: { toReply: mine(data.replies.toReply), waiting: mine(data.replies.waiting) },
    expected: mine(data.expected),
  };
}
