import * as z from "zod";
import type { Attachment, Message, Thread } from "../mail/types";

// A meeting invite, update, cancellation or answer carried by an email, in one typed record
// whatever sent it: a text/calendar part or .ics file (Gmail, IMAP; parsed by ics.ts) or Outlook's
// event messages (Graph). Kite answers only when the user clicks Accept / Maybe / Decline.

export const RESPONSES = ["accepted", "tentative", "declined"] as const;
export const InviteResponse = z.enum(RESPONSES);
export type InviteResponse = z.infer<typeof InviteResponse>;

export const AttendeeStatus = z.enum(["accepted", "tentative", "declined", "needs-action", "delegated"]);
export type AttendeeStatus = z.infer<typeof AttendeeStatus>;

const Person = z.object({ name: z.string(), email: z.string() });

export const Invite = z.object({
  uid: z.string(),
  /** iTIP method: REQUEST (an invite or update), CANCEL, REPLY (someone answered yours), PUBLISH (just an event). */
  method: z.enum(["REQUEST", "CANCEL", "REPLY", "PUBLISH", "COUNTER", "OTHER"]),
  /** Bumped by the organiser on every change; the highest one is current. */
  sequence: z.number().int().default(0),
  summary: z.string(),
  /** ISO instant (all-day events: midnight UTC of the first day). */
  start: z.string(),
  end: z.string().optional(),
  allDay: z.boolean().default(false),
  /** The organiser's time zone as given (IANA or a Windows name), for "10:00 in New York". */
  timeZone: z.string().optional(),
  /** "Weekly on Tuesday", when it repeats. */
  recurrence: z.string().optional(),
  /** One occurrence of a repeating event: the raw RECURRENCE-ID parameters and value (";TZID=…:2026…", echoed back in replies)… */
  recurrenceId: z.string().optional(),
  /** …and when that occurrence was meant to start (ISO). */
  occurrence: z.string().optional(),
  location: z.string().optional(),
  /** A video call link (Meet, Teams, Zoom, Webex). */
  join: z.string().optional(),
  organizer: Person.optional(),
  attendees: z.array(Person.extend({ status: AttendeeStatus, optional: z.boolean().optional() })).default([]),
  cancelled: z.boolean().optional(),
  /** Your answer as the invite has it (PARTSTAT for your address). */
  you: AttendeeStatus.optional(),
  /** The answer you sent from Kite (kept locally, so the card shows it before the organiser's update arrives). */
  replied: z.object({ response: InviteResponse, at: z.string(), via: z.enum(["calendar", "email"]), note: z.string().optional() }).optional(),
  /** A later email in another conversation updated or cancelled this event (the Kite thread id that has it). */
  later: z.object({ threadId: z.string(), cancelled: z.boolean() }).optional(),
});
export type Invite = z.infer<typeof Invite>;

const CALENDAR_TYPES = new Set(["text/calendar", "application/ics", "text/x-vcalendar", "application/x-ics"]);

/** A calendar file (an invite's text/calendar part or an attached .ics). */
export function isCalendarFile(attachment: Pick<Attachment, "name" | "mimeType">) {
  return CALENDAR_TYPES.has((attachment.mimeType ?? "").toLowerCase().split(";")[0].trim()) || /\.ics$/i.test(attachment.name);
}

/** The message carries an invite (or answer) Kite can show as a card. */
export function hasInvite(message: Pick<Message, "calendar" | "attachments" | "invite">) {
  return !!message.invite || !!message.calendar || !!message.attachments?.some(isCalendarFile);
}

export const threadHasInvite = (thread: Pick<Thread, "messages">) => thread.messages.some(hasInvite);

/** The answer that counts: what you sent from Kite, else what the invite says. */
export function yourAnswer(invite: Invite): AttendeeStatus | undefined {
  return invite.replied?.response ?? invite.you;
}

export const RESPONSE_LABEL: Record<InviteResponse, string> = { accepted: "Yes", tentative: "Maybe", declined: "No" };
export const STATUS_WORD: Record<AttendeeStatus, string> = {
  accepted: "accepted",
  tentative: "said maybe",
  declined: "declined",
  "needs-action": "hasn't answered",
  delegated: "delegated",
};
