import "server-only";

import { eventTimes, type CalendarEvent } from "@/lib/calendar/event";
import { findJoinLink, stripPrefix } from "@/lib/calendar/ics";
import type { AttendeeStatus, Invite, InviteResponse } from "@/lib/calendar/invite";
import type { Contact } from "@/lib/mail/types";
import type { AccountRow } from "../../db";
import type { CalendarAdapter, EventChanges } from "../../mail/provider";
import { ProviderError } from "../../mail/errors";
import type { GraphAddress } from "./convert";
import { graph, GraphError } from "./graph";
import { canUseCalendar } from "./oauth";

// Outlook keeps invites as event messages (Graph's eventMessage types), not calendar parts, so the
// invite card reads them from Graph: the message itself (Mail scopes) for when and where, plus
// the event (Calendars.ReadWrite, opt-in) for attendees, the join link and your answer. Answers
// go through the event's accept / tentativelyAccept / decline, which update your calendar and
// tell the organiser.
//
// Events for Today: a calendarView delta query over the window (default calendar), so later reads
// bring only what changed. A delta link belongs to its window; a new window starts a new one.

type GraphTime = { dateTime?: string; timeZone?: string };
type GraphAttendee = GraphAddress & { type?: string; status?: { response?: string } };
type GraphEvent = {
  id: string;
  iCalUId?: string;
  subject?: string;
  start?: GraphTime;
  end?: GraphTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  organizer?: GraphAddress;
  attendees?: GraphAttendee[];
  onlineMeeting?: { joinUrl?: string } | null;
  responseStatus?: { response?: string };
  isOrganizer?: boolean;
  showAs?: string;
  type?: string;
  webLink?: string;
  bodyPreview?: string;
  "@removed"?: { reason?: string };
  recurrence?: { pattern?: { type?: string; interval?: number; daysOfWeek?: string[] } } | null;
};
type EventMessage = {
  id: string;
  subject?: string;
  meetingMessageType?: string;
  responseType?: string;
  startDateTime?: GraphTime;
  endDateTime?: GraphTime;
  isAllDay?: boolean;
  location?: { displayName?: string };
  from?: GraphAddress;
  event?: GraphEvent | null;
};

/** Times come back in UTC (the Prefer header below), as "2026-10-20T08:00:00.0000000". */
function iso(time: GraphTime | undefined) {
  if (!time?.dateTime) return undefined;
  const at = Date.parse(/[zZ]|[+-]\d{2}:?\d{2}$/.test(time.dateTime) ? time.dateTime : `${time.dateTime.replace(/\.\d+$/, "")}Z`);
  return Number.isNaN(at) ? undefined : new Date(at).toISOString();
}

const RESPONSE: Record<string, AttendeeStatus> = {
  accepted: "accepted",
  organizer: "accepted",
  tentativelyAccepted: "tentative",
  declined: "declined",
  none: "needs-action",
  notResponded: "needs-action",
};

/** What an answer says, from its message type when Graph leaves responseType out. */
const ANSWERED: Record<string, AttendeeStatus> = {
  meetingAccepted: "accepted",
  meetingTenativelyAccepted: "tentative",
  meetingTentativelyAccepted: "tentative",
  meetingDeclined: "declined",
};

const METHOD: Record<string, Invite["method"]> = {
  meetingRequest: "REQUEST",
  meetingCancelled: "CANCEL",
  meetingAccepted: "REPLY",
  meetingTenativelyAccepted: "REPLY",
  meetingTentativelyAccepted: "REPLY",
  meetingDeclined: "REPLY",
};

function person(address: GraphAddress | undefined): Contact | undefined {
  const email = address?.emailAddress?.address?.trim();
  return email ? { name: address?.emailAddress?.name?.trim() || email.split("@")[0], email } : undefined;
}

const DAY_NAMES: Record<string, string> = { monday: "Monday", tuesday: "Tuesday", wednesday: "Wednesday", thursday: "Thursday", friday: "Friday", saturday: "Saturday", sunday: "Sunday" };

function describePattern(pattern: NonNullable<GraphEvent["recurrence"]>["pattern"]) {
  if (!pattern?.type) return undefined;
  const unit = pattern.type === "daily" ? "day" : pattern.type === "weekly" ? "week" : pattern.type.includes("Monthly") ? "month" : "year";
  const n = pattern.interval ?? 1;
  let text = n > 1 ? `Every ${n} ${unit}s` : { day: "Every day", week: "Weekly", month: "Monthly", year: "Yearly" }[unit]!;
  const days = (pattern.daysOfWeek ?? []).map((d) => DAY_NAMES[d]).filter(Boolean);
  if (unit === "week" && days.length) text += ` on ${days.join(", ")}`;
  return text;
}

const ACTION: Record<InviteResponse, string> = { accepted: "accept", tentative: "tentativelyAccept", declined: "decline" };
const PREFER_UTC = { prefer: 'IdType="ImmutableId", outlook.timezone="UTC"' };

type DeltaPage = { value?: GraphEvent[]; "@odata.nextLink"?: string; "@odata.deltaLink"?: string };
/** Pages per read (100 events each). */
const MAX_PAGES = 20;

function toEvent(account: AccountRow, e: GraphEvent): CalendarEvent | null {
  const start = iso(e.start);
  if (!start || e.isCancelled) return null;
  // All-day events are whole days in any zone: keep the day itself.
  const day = (time: GraphTime | undefined) => time?.dateTime?.slice(0, 10);
  const location = e.location?.displayName || undefined;
  const organizer = e.isOrganizer ? undefined : person(e.organizer);
  const you = e.isOrganizer ? undefined : RESPONSE[e.responseStatus?.response ?? ""];
  const join = e.onlineMeeting?.joinUrl || findJoinLink(location, e.bodyPreview);
  const end = e.isAllDay ? day(e.end) : iso(e.end);
  return {
    id: `${account.id}:${e.id}`,
    accountId: account.id,
    ...(e.iCalUId ? { uid: e.iCalUId } : {}),
    summary: e.subject?.trim() || "(no title)",
    start: e.isAllDay ? day(e.start)! : start,
    ...(end ? { end } : {}),
    allDay: !!e.isAllDay,
    ...(location ? { location } : {}),
    ...(join ? { join } : {}),
    ...(organizer ? { organizer } : {}),
    ...(you ? { you } : {}),
    ...(e.webLink ? { link: e.webLink } : {}),
    ...(e.type === "occurrence" || e.type === "exception" ? { recurring: true } : {}),
  };
}

/** Follows a delta query to its delta link: changed events and the ids that are gone. */
async function readDelta(account: AccountRow, url: string): Promise<Omit<EventChanges, "full">> {
  const events: CalendarEvent[] = [];
  const removed: string[] = [];
  let next: string | undefined = url;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const res: DeltaPage = await graph<DeltaPage>(account.id, next, { headers: { prefer: `${PREFER_UTC.prefer}, odata.maxpagesize=100` } });
    for (const item of res.value ?? []) {
      const event = item["@removed"] ? null : toEvent(account, item);
      if (event) events.push(event);
      else removed.push(item.id);
    }
    if (res["@odata.deltaLink"]) return { events, removed, cursor: res["@odata.deltaLink"] };
    next = res["@odata.nextLink"];
  }
  // Too many pages: keep what came, start over next time.
  return { events, removed, cursor: null };
}

/** Graph's dateTimeTimeZone for what the user typed (all-day: midnight to midnight). */
function graphTime(value: string, allDay: boolean, timeZone: string) {
  return { dateTime: allDay ? `${value}T00:00:00` : value, timeZone };
}

export const outlookCalendar: CalendarAdapter = {
  email: false,
  missing: (accountId) => (canUseCalendar(accountId) ? null : "Connect your Outlook calendar so Kite can answer invites there."),
  async invite(account, message) {
    const expand = canUseCalendar(account.id) ? "?$expand=microsoft.graph.eventMessage/event" : "";
    let m: EventMessage;
    try {
      m = await graph<EventMessage>(account.id, `/me/messages/${encodeURIComponent(message.id)}${expand}`, { headers: PREFER_UTC });
    } catch (error) {
      if (error instanceof GraphError && error.status === 404) return null;
      throw error;
    }
    const event = m.event ?? null;
    const start = iso(event?.start) ?? iso(m.startDateTime);
    if (!start) return null;
    const method = METHOD[m.meetingMessageType ?? ""] ?? "PUBLISH";
    const from = person(m.from);
    const attendees =
      method === "REPLY" && from
        ? [{ ...from, status: RESPONSE[m.responseType ?? ""] ?? ANSWERED[m.meetingMessageType ?? ""] ?? "needs-action" }]
        : (event?.attendees ?? []).flatMap((a) => {
            const p = person(a);
            return p && a.type !== "resource" ? [{ ...p, status: RESPONSE[a.status?.response ?? ""] ?? "needs-action", ...(a.type === "optional" ? { optional: true } : {}) }] : [];
          });
    const location = event?.location?.displayName || m.location?.displayName || undefined;
    const bodyText = message.html ?? message.body.join("\n");
    return {
      uid: event?.iCalUId || `outlook:${message.id}`,
      method,
      sequence: 0,
      // Without the event (deleted, or no calendar permission) the title comes from the subject, minus
      // the "Canceled: " prefix and Google's " @ Fri Oct 16, 2026 10am - … (you@…)" tail.
      summary: event?.subject || stripPrefix((m.subject ?? "").replace(/ @ [A-Z][a-z]{2} [A-Z][a-z]{2} \d.*$/, "")) || "(no title)",
      start,
      end: iso(event?.end) ?? iso(m.endDateTime),
      allDay: event?.isAllDay ?? m.isAllDay ?? false,
      recurrence: describePattern(event?.recurrence?.pattern),
      location,
      join: event?.onlineMeeting?.joinUrl || findJoinLink(location, bodyText),
      organizer: person(event?.organizer) ?? (method === "REQUEST" || method === "CANCEL" ? from : undefined),
      attendees,
      cancelled: method === "CANCEL" || event?.isCancelled || undefined,
      you: event?.responseStatus?.response ? RESPONSE[event.responseStatus.response] : undefined,
    };
  },
  async respond(account, { message, response, note }) {
    const m = await graph<EventMessage>(account.id, `/me/messages/${encodeURIComponent(message.id)}?$select=id&$expand=microsoft.graph.eventMessage/event($select=id)`);
    if (!m.event?.id) return "not_found";
    await graph(account.id, `/me/events/${encodeURIComponent(m.event.id)}/${ACTION[response]}`, {
      method: "POST",
      body: { comment: note?.trim() ?? "", sendResponse: true },
    });
    return "done";
  },
  async events(account, { cursor, from, to }): Promise<EventChanges> {
    if (cursor) {
      try {
        return { full: false, ...(await readDelta(account, cursor)) };
      } catch (error) {
        // An expired delta link (410, or "resync required"): read the window again.
        if (!(error instanceof GraphError) || (error.status !== 410 && !/sync/i.test(error.code ?? ""))) throw error;
      }
    }
    const url = `/me/calendarView/delta?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}`;
    return { full: true, ...(await readDelta(account, url)) };
  },
  async range(account, { from, to }) {
    const events: CalendarEvent[] = [];
    let next: string | undefined = `/me/calendarView?startDateTime=${encodeURIComponent(from)}&endDateTime=${encodeURIComponent(to)}&$top=100`;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const res: { value?: GraphEvent[]; "@odata.nextLink"?: string } = await graph(account.id, next, { headers: PREFER_UTC });
      for (const item of res.value ?? []) {
        const event = toEvent(account, item);
        if (event) events.push(event);
      }
      next = res["@odata.nextLink"];
    }
    return events;
  },
  async create(account, input) {
    const { start, end } = eventTimes(input);
    const created = await graph<GraphEvent>(account.id, "/me/events", {
      method: "POST",
      headers: PREFER_UTC,
      body: {
        subject: input.summary,
        ...(input.location ? { location: { displayName: input.location } } : {}),
        ...(input.notes ? { body: { contentType: "text", content: input.notes } } : {}),
        isAllDay: input.allDay,
        start: graphTime(start, input.allDay, input.timeZone),
        end: graphTime(end, input.allDay, input.timeZone),
      },
    });
    const event = toEvent(account, created);
    if (!event) throw new ProviderError("Outlook didn't return the new event.", 502, "Outlook");
    return event;
  },
};
