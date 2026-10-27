import "server-only";

import { eventTimes, type CalendarEvent } from "@/lib/calendar/event";
import { findJoinLink } from "@/lib/calendar/ics";
import type { AttendeeStatus, InviteResponse } from "@/lib/calendar/invite";
import type { AccountRow } from "../../db";
import type { CalendarAdapter, EventChanges } from "../provider";
import { ProviderError } from "../errors";
import { CALENDAR_SCOPES, type GoogleAccess } from "./oauth";

// Google Calendar for any account with a Google sign-in that has the opt-in `calendar.events` scope
// (the Gmail API provider's own, or a Gmail-over-IMAP account's optional one: ./link.ts).
//
// Answering invites: the event is found by its
// iCalendar UID in the primary calendar and your attendee entry gets the answer, so your calendar
// and the organiser's both update. When it isn't there (auto-add off, an occurrence Google doesn't
// list), Kite answers by email instead (server/calendar.ts).
//
// Events for Today come from the same scope, primary calendar only. Google's sync tokens can't be
// combined with a time window, so the token only says whether anything changed (a few bytes); the
// window is read again when it did, or when it moves to a new day.

const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

type Attendee = { email?: string; displayName?: string; self?: boolean; responseStatus?: string; comment?: string; [key: string]: unknown };
type GoogleTime = { dateTime?: string; date?: string; timeZone?: string };
type GoogleEvent = {
  id: string;
  iCalUID?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  hangoutLink?: string;
  eventType?: string;
  start?: GoogleTime;
  end?: GoogleTime;
  recurringEventId?: string;
  originalStartTime?: GoogleTime;
  organizer?: { email?: string; displayName?: string; self?: boolean };
  attendees?: Attendee[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
};
type EventPage = { items?: GoogleEvent[]; nextPageToken?: string; nextSyncToken?: string };

const STATUS: Record<InviteResponse, string> = { accepted: "accepted", tentative: "tentative", declined: "declined" };

const ANSWER: Record<string, AttendeeStatus> = { accepted: "accepted", tentative: "tentative", declined: "declined", needsAction: "needs-action" };
/** Pages read per window (250 events each): more than a month of anyone's calendar. */
const MAX_PAGES = 8;

/** A sync token Google no longer accepts (410): read everything again. */
class Gone extends Error {}

async function call<T>(access: GoogleAccess, accountId: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${await access.token(accountId)}`, "content-type": "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 410) throw new Gone();
  if (!res.ok) throw new ProviderError(`Google Calendar ${init.method ?? "GET"} failed (${res.status}): ${(await res.text()).slice(0, 200)}`, res.status, "Google Calendar");
  return (await res.json()) as T;
}

function toEvent(account: AccountRow, e: GoogleEvent): CalendarEvent | null {
  const start = e.start?.dateTime ? new Date(e.start.dateTime).toISOString() : e.start?.date;
  // Cancelled ones, and Google's "working location" markers, aren't events to show.
  if (!start || e.status === "cancelled" || e.eventType === "workingLocation") return null;
  const end = e.end?.dateTime ? new Date(e.end.dateTime).toISOString() : e.end?.date;
  const self = e.attendees?.find((a) => a.self);
  const join = e.hangoutLink || e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri || findJoinLink(e.location, e.description);
  const organizer = e.organizer?.email && !e.organizer.self ? { name: e.organizer.displayName || e.organizer.email.split("@")[0], email: e.organizer.email } : undefined;
  return {
    id: `${account.id}:${e.id}`,
    accountId: account.id,
    ...(e.iCalUID ? { uid: e.iCalUID } : {}),
    summary: e.summary?.trim() || "(no title)",
    start,
    ...(end ? { end } : {}),
    allDay: !e.start?.dateTime,
    ...(e.location ? { location: e.location } : {}),
    ...(join ? { join } : {}),
    ...(organizer ? { organizer } : {}),
    ...(self?.responseStatus && !e.organizer?.self ? { you: ANSWER[self.responseStatus] ?? "needs-action" } : {}),
    ...(e.htmlLink ? { link: e.htmlLink } : {}),
    ...(e.recurringEventId ? { recurring: true } : {}),
  };
}

/** Pages through a list, handing each page's items to `onPage`. Returns the sync token from the last page. */
async function readAll(access: GoogleAccess, accountId: string, url: string, onPage: (items: GoogleEvent[]) => void, maxPages = MAX_PAGES) {
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page++) {
    const res: EventPage = await call<EventPage>(access, accountId, pageToken ? `${url}&pageToken=${encodeURIComponent(pageToken)}` : url);
    onPage(res.items ?? []);
    if (!res.nextPageToken) return res.nextSyncToken ?? null;
    pageToken = res.nextPageToken;
  }
  return null;
}

/** Whether anything changed since `token`, and the token for next time (null when it expired). */
async function changedSince(access: GoogleAccess, accountId: string, token: string) {
  let changed = false;
  try {
    const url = `${API}?syncToken=${encodeURIComponent(token)}&maxResults=250&fields=items(id),nextPageToken,nextSyncToken`;
    const next = await readAll(access, accountId, url, (items) => void (changed ||= items.length > 0), 40);
    return { changed, token: next };
  } catch (error) {
    if (error instanceof Gone) return { changed: true, token: null };
    throw error;
  }
}

/** A fresh sync token: no items, the whole calendar (Google gives tokens only to lists without a window). */
const freshToken = (access: GoogleAccess, accountId: string) => readAll(access, accountId, `${API}?maxResults=2500&fields=nextPageToken,nextSyncToken`, () => {}, 40);

async function readWindow(access: GoogleAccess, account: AccountRow, from: string, to: string): Promise<CalendarEvent[]> {
  const events: CalendarEvent[] = [];
  const url = `${API}?singleEvents=true&orderBy=startTime&maxResults=250&timeMin=${encodeURIComponent(from)}&timeMax=${encodeURIComponent(to)}`;
  await readAll(access, account.id, url, (items) => {
    for (const item of items) {
      const event = toEvent(account, item);
      if (event) events.push(event);
    }
  });
  return events;
}

/** Google Calendar through `access`; `offered` says which accounts have a Google sign-in at all. */
export const googleCalendar = (access: GoogleAccess, offered?: (accountId: string) => boolean): CalendarAdapter => ({
  email: true,
  ...(offered ? { offered } : {}),
  missing: (accountId) => (access.granted(accountId, CALENDAR_SCOPES) ? null : "Connect Google Calendar so your answer shows in your calendar too."),
  async respond(account, { invite, response, note }) {
    if (!invite.uid) return "not_found";
    const found = await call<{ items?: GoogleEvent[] }>(access, account.id, `${API}?iCalUID=${encodeURIComponent(invite.uid)}&maxResults=50`);
    const items = (found.items ?? []).filter((e) => e.status !== "cancelled");
    // One occurrence of a series: the exception Google keeps for it; otherwise the event itself.
    const at = invite.occurrence ? Date.parse(invite.occurrence) : null;
    const event =
      (at != null && items.find((e) => Date.parse(e.originalStartTime?.dateTime ?? e.originalStartTime?.date ?? "") === at)) ||
      items.find((e) => !e.recurringEventId) ||
      items[0];
    const me = account.email.toLowerCase();
    const attendees = event?.attendees ?? [];
    if (!event || !attendees.some((a) => a.self || a.email?.toLowerCase() === me)) return "not_found";
    const comment = note?.trim();
    await call(access, account.id, `${API}/${encodeURIComponent(event.id)}?sendUpdates=all`, {
      method: "PATCH",
      body: JSON.stringify({
        attendees: attendees.map((a) =>
          a.self || a.email?.toLowerCase() === me ? { ...a, responseStatus: STATUS[response], ...(comment ? { comment } : {}) } : a,
        ),
      }),
    });
    return "done";
  },
  async events(account, { cursor, from, to }): Promise<EventChanges> {
    const since = cursor ? await changedSince(access, account.id, cursor) : null;
    if (since && !since.changed && since.token) return { full: false, events: [], removed: [], cursor: since.token };
    // The token first, so a change made while the window is read shows up next time.
    const token = since?.token ?? (await freshToken(access, account.id));
    return { full: true, events: await readWindow(access, account, from, to), removed: [], cursor: token };
  },
  range: (account, { from, to }) => readWindow(access, account, from, to),
  async create(account, input) {
    const { start, end } = eventTimes(input);
    const time = (value: string) => (input.allDay ? { date: value } : { dateTime: value, timeZone: input.timeZone });
    const created = await call<GoogleEvent>(access, account.id, API, {
      method: "POST",
      body: JSON.stringify({
        summary: input.summary,
        ...(input.location ? { location: input.location } : {}),
        ...(input.notes ? { description: input.notes } : {}),
        start: time(start),
        end: time(end),
      }),
    });
    const event = toEvent(account, created);
    if (!event) throw new ProviderError("Google Calendar didn't return the new event.", 502, "Google Calendar");
    return event;
  },
});
