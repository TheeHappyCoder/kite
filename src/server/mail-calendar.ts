import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { eventTimes, type CalendarEvent, type NewEvent } from "@/lib/calendar/event";
import { parseEvents, zonedInstant, type IcsEvent } from "@/lib/calendar/ics";
import { hasInvite, isCalendarFile, type AttendeeStatus } from "@/lib/calendar/invite";
import { expandRule } from "@/lib/calendar/recur";
import type { Thread } from "@/lib/mail/types";
import { AttachmentError, getAttachment } from "./attachments";
import { getDb, type AccountRow } from "./db";
import type { CalendarAdapter } from "./mail/provider";

// The mail calendar: for accounts whose provider has no calendar Kite can reach (IMAP, Gmail over
// IMAP without its Google sign-in), events built only from calendar files that arrived in mail,
// kept in local SQLite. Never reads bodies for dates. An invite counts once you answered Yes or
// Maybe (in Kite: invite_replies; elsewhere: your own iTIP REPLY in Sent), shows as "not answered"
// until you do, and goes on No. A later REQUEST (higher SEQUENCE) changes it, CANCEL removes it.
// Repeating events are expanded here (EXDATE and changed occurrences respected). It can't see events
// that never came by email, and events added in Kite stay in Kite. server/events.ts uses it
// through `mailCalendar` when `calendarFor(account)` has nothing.

const DAY = 86_400_000;
/** Calendar files read from the provider per run (newest first); the rest wait for the next one. */
const READ_PER_RUN = 60;
/** Bigger files (whole calendar exports) aren't kept. */
const MAX_ICS = 256 * 1024;

const g = globalThis as typeof globalThis & { __kiteMailCalendarFailed?: Set<string> };
const failed = (g.__kiteMailCalendarFailed ??= new Set());

/**
 * Reads calendar files in stored mail not read yet (from the attachment cache, else the provider).
 * Stops at the first failure that isn't the file being gone; the next run tries again.
 */
async function readNew(account: AccountRow) {
  const d = getDb();
  const threads = d
    .prepare(`SELECT id, list_data FROM threads WHERE account_id = ? AND list_data LIKE '%"calendar":true%' ORDER BY last_date DESC`)
    .all(account.id) as { id: string; list_data: string | null }[];
  if (!threads.length) return;
  const known = new Set((d.prepare("SELECT message_id FROM mail_invites WHERE account_id = ?").all(account.id) as { message_id: string }[]).map((r) => r.message_id));
  const insert = d.prepare(
    `INSERT INTO mail_invites (account_id, message_id, thread_id, uid, method, date, ics) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, message_id) DO UPDATE SET thread_id = excluded.thread_id, uid = excluded.uid, method = excluded.method, date = excluded.date, ics = excluded.ics`,
  );
  let reads = 0;
  for (const row of threads) {
    if (!row.list_data) continue;
    for (const message of (JSON.parse(row.list_data) as Thread).messages) {
      if (known.has(message.id) || !hasInvite(message)) continue;
      // Only list metadata so far (a first sync stores lists before bodies): read once its files are known, rather than recorded as having none.
      if (!message.attachments) continue;
      const file = message.attachments?.find((a) => isCalendarFile(a) && a.partId);
      let text: string | null = null;
      if (file?.partId) {
        if (reads++ >= READ_PER_RUN) return;
        try {
          const { data } = await getAttachment(account, message.id, file.partId, file.name);
          text = data.length <= MAX_ICS ? data.toString("utf-8") : null;
          failed.delete(account.id);
        } catch (error) {
          if (!(error instanceof AttachmentError)) {
            if (!failed.has(account.id)) console.error(`Mail calendar: couldn't read an invite for ${account.email}:`, error instanceof Error ? error.message : error);
            failed.add(account.id);
            return;
          }
        }
      }
      const parsed = text ? parseEvents(text, account.email) : null;
      const first = parsed?.events.find((e) => e.uid);
      insert.run(account.id, message.id, row.id, first?.uid ?? "", parsed?.method ?? "OTHER", message.date, first ? text : null);
    }
  }
}

type Item = { event: IcsEvent; method: string; date: string; trash: boolean };
type Answer = { status: AttendeeStatus; at: string };

/** Your latest answer per occurrence ("" = the whole event): Kite's own, or an iTIP REPLY you sent from elsewhere. */
function answers(items: Item[], fromKite: { occurrence: string; response: AttendeeStatus; at: string }[]) {
  const map = new Map<string, Answer>();
  const offer = (key: string, answer: Answer) => {
    const current = map.get(key);
    if (!current || answer.at > current.at) map.set(key, answer);
  };
  for (const item of items) if (item.method === "REPLY" && item.event.you && item.event.you !== "needs-action") offer(item.event.occurrence ?? "", { status: item.event.you, at: item.date });
  for (const reply of fromKite) offer(reply.occurrence, { status: reply.response, at: reply.at });
  return map;
}

/** Highest SEQUENCE wins; on a tie, the later email. */
const newer = (a: Item, b: Item | undefined) => !b || a.event.sequence > b.event.sequence || (a.event.sequence === b.event.sequence && a.date > b.date);

function toEvent(account: AccountRow, uid: string, event: IcsEvent, start: string, end: string | undefined, you: AttendeeStatus | undefined, recurring: boolean): CalendarEvent {
  const day = (iso: string) => iso.slice(0, 10);
  const allDayEnd = end && day(end) > day(start) ? day(end) : day(new Date(Date.parse(start) + DAY).toISOString());
  return {
    id: `${account.id}:mail:${uid}:${start}`,
    accountId: account.id,
    uid,
    summary: event.summary,
    start: event.allDay ? day(start) : start,
    end: event.allDay ? allDayEnd : end,
    allDay: event.allDay,
    ...(event.location ? { location: event.location } : {}),
    ...(event.join ? { join: event.join } : {}),
    ...(event.organizer ? { organizer: event.organizer } : {}),
    ...(you ? { you } : {}),
    ...(recurring ? { recurring: true } : {}),
    source: "mail",
  };
}

const span = (e: CalendarEvent) => {
  const start = Date.parse(e.allDay ? `${e.start}T00:00:00Z` : e.start);
  const end = e.end ? Date.parse(e.allDay ? `${e.end}T00:00:00Z` : e.end) : start;
  // All-day days are read in UTC; a day either side keeps them for every zone (the client places them).
  return e.allDay ? { start: start - DAY, end: end + DAY } : { start, end: Math.max(end, start + 1) };
};

/** The mail calendar's events overlapping [from, to), built from stored invites. */
function build(account: AccountRow, from: string, to: string): CalendarEvent[] {
  const d = getDb();
  const rows = d
    .prepare(
      `SELECT m.uid, m.method, m.date, m.ics, t.labels FROM mail_invites m JOIN threads t ON t.id = m.thread_id
       WHERE m.account_id = ? AND m.ics IS NOT NULL`,
    )
    .all(account.id) as { uid: string; method: string; date: string; ics: string; labels: string }[];
  const kite = d.prepare("SELECT uid, occurrence, response, at FROM invite_replies WHERE account_id = ?").all(account.id) as {
    uid: string;
    occurrence: string;
    response: AttendeeStatus;
    at: string;
  }[];
  const me = account.email.toLowerCase();
  const byUid = new Map<string, Item[]>();
  for (const row of rows) {
    // Calendar spam stays out; invites in the bin still count once answered.
    if (row.labels.includes('"SPAM"')) continue;
    const trash = row.labels.includes('"TRASH"');
    for (const event of parseEvents(row.ics, account.email)?.events ?? []) {
      if (!event.uid) continue;
      const list = byUid.get(event.uid) ?? [];
      list.push({ event, method: row.method, date: row.date, trash });
      byUid.set(event.uid, list);
    }
  }

  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const out: CalendarEvent[] = [];
  for (const [uid, items] of byUid) {
    let master: Item | undefined;
    const changed = new Map<string, Item>();
    for (const item of items) {
      if (item.method !== "REQUEST" || item.event.cancelled) continue;
      if (item.event.occurrence) {
        if (newer(item, changed.get(item.event.occurrence))) changed.set(item.event.occurrence, item);
      } else if (newer(item, master)) master = item;
    }
    if (!master && !changed.size) continue;
    const sequence = master?.event.sequence ?? 0;
    // A cancellation of the whole event at least as new as the invite removes it; of one occurrence, just that one.
    const cancels = items.filter((i) => i.method === "CANCEL" || (i.method === "REQUEST" && i.event.cancelled));
    if (cancels.some((c) => !c.event.occurrence && c.event.sequence >= sequence)) continue;
    const cancelled = new Set(cancels.flatMap((c) => c.event.occurrence ?? []));
    const replies = answers(items, kite.filter((r) => r.uid === uid));
    const organiser = (master ?? [...changed.values()][0]).event.organizer?.email.toLowerCase();
    const own = !organiser || organiser === me;
    const allInBin = items.every((i) => i.trash);
    const yourAnswer = (item: Item, occurrence: string): AttendeeStatus | undefined => {
      if (own) return undefined;
      const answer = replies.get(occurrence) ?? replies.get("");
      // The invite's own PARTSTAT for you counts when it's newer than any answer seen (answered on another device).
      const said = item.event.you && item.event.you !== "needs-action" ? { status: item.event.you, at: item.date } : undefined;
      const latest = said && (!answer || said.at > answer.at) ? said : answer;
      return latest?.status ?? "needs-action";
    };
    const add = (item: Item, occurrence: string, start: string, end: string | undefined, recurring: boolean) => {
      const you = yourAnswer(item, occurrence);
      if (you === "declined" || (you === "needs-action" && allInBin)) return;
      const event = toEvent(account, uid, item.event, start, end, you, recurring);
      const { start: s, end: e } = span(event);
      if (s < toMs && e > fromMs) out.push(event);
    };

    if (master) {
      const base = master.event;
      const length = base.end ? Date.parse(base.end) - Date.parse(base.start) : 0;
      // Wall-clock bound: the window's end plus a day either way for zones.
      const walls = base.rule ? (expandRule(base.rule, base.wallStart, toMs + 2 * DAY, base.pastUntil) ?? [base.wallStart]) : [base.wallStart];
      const recurring = !!base.rule;
      const exdates = new Set(base.exdates);
      for (const wall of walls) {
        const start = base.instantAt(wall);
        if (exdates.has(start) || cancelled.has(start)) continue;
        const change = changed.get(start);
        if (change) {
          changed.delete(start);
          add(change, start, change.event.start, change.event.end, recurring);
        } else add(master, recurring ? start : "", start, length ? new Date(Date.parse(start) + length).toISOString() : undefined, recurring);
      }
    }
    // Changed occurrences whose original time wasn't walked (outside the window, or no series in mail).
    for (const [occurrence, change] of changed) if (!cancelled.has(occurrence)) add(change, occurrence, change.event.start, change.event.end, !!master);
  }

  const local = d
    .prepare("SELECT data FROM local_events WHERE account_id = ? AND start < ? AND COALESCE(end, start) > ?")
    .all(account.id, to, from.slice(0, 10)) as { data: string }[];
  for (const row of local) out.push(JSON.parse(row.data) as CalendarEvent);
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** "Add to calendar" for a mail calendar: kept only in Kite. */
function create(account: AccountRow, input: NewEvent): CalendarEvent {
  const times = eventTimes(input);
  const start = input.allDay ? times.start : zonedInstant(times.start, input.timeZone);
  const end = input.allDay ? times.end : zonedInstant(times.end, input.timeZone);
  if (!start || !end) throw new Error("Kite couldn't read that time zone.");
  const event: CalendarEvent = {
    id: `${account.id}:kite:${randomUUID()}`,
    accountId: account.id,
    summary: input.summary,
    start,
    end,
    allDay: input.allDay,
    ...(input.location ? { location: input.location } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    source: "kite",
  };
  getDb().prepare("INSERT INTO local_events (id, account_id, start, end, data) VALUES (?, ?, ?, ?, ?)").run(event.id, account.id, event.start, event.end ?? null, JSON.stringify(event));
  return event;
}

/**
 * An event an automation adds ("Add to my calendar"): kept only in Kite, for any account. A plain
 * date is an all-day event; a date with a time lasts an hour. Returns its id (Undo removes it).
 */
export function addKiteEvent(account: AccountRow, input: { summary: string; start: string; allDay: boolean }) {
  const at = new Date(input.start);
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const next = new Date(at);
  next.setDate(next.getDate() + 1);
  const event: CalendarEvent = {
    id: `${account.id}:kite:${randomUUID()}`,
    accountId: account.id,
    summary: input.summary.slice(0, 500),
    start: input.allDay ? day(at) : at.toISOString(),
    end: input.allDay ? day(next) : new Date(at.getTime() + 3_600_000).toISOString(),
    allDay: input.allDay,
    source: "kite",
  };
  getDb().prepare("INSERT INTO local_events (id, account_id, start, end, data) VALUES (?, ?, ?, ?, ?)").run(event.id, account.id, event.start, event.end ?? null, JSON.stringify(event));
  return event.id;
}

/** Removes an event added in Kite (the event card's Remove). False when there's no such event. */
export function removeLocalEvent(id: string): boolean {
  const d = getDb();
  d.prepare("DELETE FROM events WHERE id = ?").run(id);
  return d.prepare("DELETE FROM local_events WHERE id = ?").run(id).changes > 0;
}

/** Forgets what was read from stored mail (Reset local copy); it's read again as mail comes back. Events added in Kite stay. */
export function resetMailCalendar() {
  getDb().exec("DELETE FROM mail_invites");
}

/**
 * The mail calendar as an event source for server/events.ts (the parts of CalendarAdapter it uses).
 * The cursor is a hash of the window's events ("mail:…"), so an unchanged calendar reports nothing.
 */
export const mailCalendar: Pick<CalendarAdapter, "missing" | "events" | "range"> & { create(account: AccountRow, event: NewEvent): Promise<CalendarEvent> } = {
  missing: () => null,
  async events(account, { cursor, from, to }) {
    await readNew(account);
    const events = build(account, from, to);
    const hash = `mail:${createHash("sha1").update(JSON.stringify(events)).digest("base64url")}`;
    return hash === cursor ? { full: false, events: [], removed: [], cursor } : { full: true, events, removed: [], cursor: hash };
  },
  range: async (account, { from, to }) => build(account, from, to),
  create: async (account, input) => create(account, input),
};
