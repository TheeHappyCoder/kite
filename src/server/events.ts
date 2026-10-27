import "server-only";

import type { CalendarEvent, NewEvent } from "@/lib/calendar/event";
import { getDb, type AccountRow } from "./db";
import { ReconnectRequired } from "./mail/errors";
import { mailCalendar } from "./mail-calendar";
import { calendarFor, mailFor } from "./providers/registry";
import { getPreferences } from "./settings";

// Events from each account's own calendar, copied into the local `events` table on the sync tick
// so Today reads them like everything else (never waiting on the network). Read-only: the only
// write is an event the user filled in with "Add to calendar". Kept only while the `calendar`
// preference is on and the sign-in allows it; turning it off empties the copy. Accounts whose
// provider has no calendar Kite can reach use the mail calendar instead (server/mail-calendar.ts):
// the real one always wins, so nothing shows twice.

const DAY = 86_400_000;
/** The window kept: a few days back (time zones, yesterday's list) to five weeks ahead. */
const BEFORE_DAYS = 3;
const AFTER_DAYS = 35;
/** How often each account's calendar is checked (a change check is a few bytes; the window is read only when it changed). */
const CHECK_MS = 2 * 60_000;

type SyncRow = { cursor: string | null; window_from: string; synced_at: string };

const g = globalThis as typeof globalThis & { __kiteCalendarChecked?: Map<string, number>; __kiteCalendarFailed?: Map<string, string> };
const checkedAt = (g.__kiteCalendarChecked ??= new Map());
const failed = (g.__kiteCalendarFailed ??= new Map());

/** The window for `now`: whole UTC days, so it (and the provider's cursor) moves once a day. */
function windowFor(now: number) {
  const from = new Date(Math.floor(now / DAY) * DAY - BEFORE_DAYS * DAY);
  return { from: from.toISOString(), to: new Date(from.getTime() + (BEFORE_DAYS + AFTER_DAYS) * DAY).toISOString() };
}

/** Where the account's events come from: its provider's calendar, else the mail calendar (mail accounts only). */
export function eventSource(account: Pick<AccountRow, "id" | "provider">) {
  return calendarFor(account) ?? (mailFor(account) ? mailCalendar : null);
}

/** Whether the account's events come from invites in its mail (no provider calendar Kite can reach). */
export const usesMailCalendar = (account: Pick<AccountRow, "id" | "provider">) => eventSource(account) === mailCalendar;

/** Whether Kite reads this account's calendar: the preference is on and the sign-in allows it. */
function calendarReadable(account: AccountRow) {
  const calendar = eventSource(account);
  return !!calendar && getPreferences().calendar && !calendar.missing(account.id);
}

function forget(accountId: string) {
  const d = getDb();
  const removed = d.prepare("DELETE FROM events WHERE account_id = ?").run(accountId).changes;
  d.prepare("DELETE FROM calendar_sync WHERE account_id = ?").run(accountId);
  return removed > 0;
}

function store(events: CalendarEvent[]) {
  const insert = getDb().prepare(
    `INSERT INTO events (id, account_id, start, end, data) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET start = excluded.start, end = excluded.end, data = excluded.data`,
  );
  for (const event of events) insert.run(event.id, event.accountId, event.start, event.end ?? null, JSON.stringify(event));
}

/**
 * Reads what changed in the account's calendar (at most every couple of minutes unless `force`).
 * Returns true when the local copy changed. Never throws for calendar trouble: mail sync goes on.
 */
export async function syncCalendar(account: AccountRow, force = false): Promise<boolean> {
  if (!calendarReadable(account)) return forget(account.id);
  const now = Date.now();
  if (!force && now - (checkedAt.get(account.id) ?? 0) < CHECK_MS) return false;
  checkedAt.set(account.id, now);

  const d = getDb();
  const state = d.prepare("SELECT cursor, window_from, synced_at FROM calendar_sync WHERE account_id = ?").get(account.id) as SyncRow | undefined;
  const { from, to } = windowFor(now);
  try {
    const source = eventSource(account)!;
    // A cursor belongs to its window and its source (the account may have switched to or from the mail calendar).
    const cursor = state?.window_from === from && (state.cursor?.startsWith("mail:") ?? false) === (source === mailCalendar) ? state.cursor : null;
    const result = await source.events(account, { cursor, from, to });
    failed.delete(account.id);
    const changed = result.full || result.events.length > 0 || result.removed.length > 0;
    d.exec("BEGIN");
    try {
      if (result.full) d.prepare("DELETE FROM events WHERE account_id = ?").run(account.id);
      store(result.events);
      const remove = d.prepare("DELETE FROM events WHERE id = ?");
      for (const id of result.removed) remove.run(`${account.id}:${id}`);
      d.prepare(
        `INSERT INTO calendar_sync (account_id, cursor, window_from, synced_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET cursor = excluded.cursor, window_from = excluded.window_from, synced_at = excluded.synced_at`,
      ).run(account.id, result.cursor, from, new Date(now).toISOString());
      d.exec("COMMIT");
    } catch (error) {
      d.exec("ROLLBACK");
      throw error;
    }
    return changed;
  } catch (error) {
    if (error instanceof ReconnectRequired) return false;
    // Logged once per kind of failure, not every couple of minutes.
    const message = error instanceof Error ? error.message : String(error);
    if (failed.get(account.id) !== message) console.error(`Calendar read failed for ${account.email}:`, message);
    failed.set(account.id, message);
    return false;
  }
}

/** Stored events overlapping [from, to) for these accounts, earliest first. */
export function listEvents(accountIds: Iterable<string>, from: string, to: string): CalendarEvent[] {
  const ids = [...accountIds];
  if (!ids.length) return [];
  // All-day events are stored as days ("2026-10-20"), which sort before any instant on that day.
  const rows = getDb()
    .prepare(
      `SELECT data FROM events WHERE account_id IN (${ids.map(() => "?").join(",")})
       AND start < ? AND COALESCE(end, start) > ? ORDER BY start`,
    )
    .all(...ids, to, from.slice(0, 10)) as { data: string }[];
  const events = rows.map((row) => JSON.parse(row.data) as CalendarEvent);
  // Events added in Kite (Add to calendar on a mail calendar, automations) for every account,
  // whether or not its calendar is synced here; a mail calendar's copy of them isn't doubled.
  const seen = new Set(events.map((e) => e.id));
  const local = getDb()
    .prepare(`SELECT data FROM local_events WHERE account_id IN (${ids.map(() => "?").join(",")}) AND start < ? AND COALESCE(end, start) > ?`)
    .all(...ids, to, from.slice(0, 10)) as { data: string }[];
  for (const row of local) {
    const event = JSON.parse(row.data) as CalendarEvent;
    if (!seen.has(event.id)) events.push(event);
  }
  return events.sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Events for the Calendar view: the local copy when [from, to) is inside the synced window, else read
 * from each readable account once and not stored. `failed`: accounts whose calendar couldn't be read.
 */
export async function readRange(accounts: AccountRow[], from: string, to: string): Promise<{ events: CalendarEvent[]; failed: string[] }> {
  const synced = windowFor(Date.now());
  if (from >= synced.from && to <= synced.to) return { events: listEvents(accounts.map((a) => a.id), from, to), failed: [] };
  const failed: string[] = [];
  const read = await Promise.all(
    accounts.filter(calendarReadable).map((account) =>
      eventSource(account)!.range(account, { from, to }).catch((error) => {
        if (!(error instanceof ReconnectRequired)) console.error(`Calendar read failed for ${account.email}:`, error instanceof Error ? error.message : error);
        failed.push(account.id);
        return [];
      }),
    ),
  );
  const events = read.flat().sort((a, b) => a.start.localeCompare(b.start));
  return { events, failed };
}

export class EventError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/** "Add to calendar": the event the user filled in, saved in the account's calendar (or only in Kite, for a mail calendar) and the local copy. */
export async function createEvent(account: AccountRow, input: NewEvent): Promise<CalendarEvent> {
  const calendar = eventSource(account);
  if (!calendar) throw new EventError("This account has no calendar Kite can add to.", 400);
  const missing = calendar.missing(account.id);
  if (missing) throw new EventError(missing, 409);
  const event = await calendar.create(account, input);
  if (getPreferences().calendar) store([event]);
  return event;
}
