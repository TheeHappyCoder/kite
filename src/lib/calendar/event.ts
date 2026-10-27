import * as z from "zod";
import { AttendeeStatus } from "./invite";

// An event in the account's own calendar (Google Calendar, Outlook), or in Kite's mail calendar for
// accounts without one (server/mail-calendar.ts), copied into the local `events` table by the sync
// engine (server/events.ts) so Today never waits on the network. Read-only: Kite adds an event only
// when the user fills in "Add to calendar" and saves.

export const CalendarEvent = z.object({
  /** `${accountId}:${the provider's event id}`. */
  id: z.string(),
  accountId: z.string(),
  /** The iCalendar UID (matches `Invite.uid` for events that came by invite). */
  uid: z.string().optional(),
  summary: z.string(),
  /** ISO instant; all-day events: the local day "YYYY-MM-DD". */
  start: z.string(),
  /** Exclusive, like the providers ("YYYY-MM-DD" the day after the last for all-day events). */
  end: z.string().optional(),
  allDay: z.boolean().default(false),
  location: z.string().optional(),
  /** A video call link (Meet, Teams, Zoom, Webex). */
  join: z.string().optional(),
  organizer: z.object({ name: z.string(), email: z.string() }).optional(),
  /** Your answer when you're invited (undefined for your own events). */
  you: AttendeeStatus.optional(),
  /** The calendar's own page for the event. */
  link: z.string().optional(),
  /** One occurrence of a repeating event. */
  recurring: z.boolean().optional(),
  /**
   * Not from the provider's calendar (server/mail-calendar.ts): "mail" = built from invites in your
   * mail, "kite" = added in Kite and kept only here. Undefined for the account's own calendar.
   */
  source: z.enum(["mail", "kite"]).optional(),
  /** What the user wrote in "Add to calendar" (kept only for events saved in Kite). */
  notes: z.string().optional(),
});
export type CalendarEvent = z.infer<typeof CalendarEvent>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/**
 * What the "Add to calendar" form saves: dates and times as the user typed them, in their own time
 * zone (the provider places them), so the browser and the server never disagree about a day.
 */
export const NewEvent = z
  .object({
    accountId: z.string().min(1),
    summary: z.string().trim().min(1, "Give the event a title").max(500),
    /** First day ("YYYY-MM-DD"). */
    date: z.string().regex(DAY, "Pick a day"),
    /** Last day, for all-day events over several days (inclusive). */
    endDate: z.string().regex(DAY).optional(),
    allDay: z.boolean(),
    start: z.string().regex(TIME).optional(),
    end: z.string().regex(TIME).optional(),
    /** IANA zone of the browser ("Africa/Johannesburg"). */
    timeZone: z.string().min(1).max(64),
    location: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(5000).optional(),
  })
  .refine((e) => e.allDay || (e.start && e.end), { message: "Pick a start and end time" })
  .refine((e) => e.allDay || (e.start! < e.end!), { message: "The event ends before it starts" })
  .refine((e) => !e.endDate || e.endDate >= e.date, { message: "The last day is before the first" });
export type NewEvent = z.infer<typeof NewEvent>;

/** Local wall-clock times for the provider: "2026-10-20T15:00:00" (all-day: the days, end exclusive). */
export function eventTimes(event: NewEvent) {
  if (event.allDay) {
    const last = new Date(`${event.endDate ?? event.date}T00:00:00Z`);
    last.setUTCDate(last.getUTCDate() + 1);
    return { start: event.date, end: last.toISOString().slice(0, 10) };
  }
  return { start: `${event.date}T${event.start}:00`, end: `${event.date}T${event.end}:00` };
}
