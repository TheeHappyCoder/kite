import { addDays, startOfWeek } from "date-fns";
import { demoCalendar } from "../mail/demo-data";
import type { Thread } from "../mail/types";
import type { CalendarEvent } from "./event";

// The Calendar view's week: which days it shows, where timed events sit in the day columns (side by
// side when they overlap) and which days all-day events span. Pure, local time, no network.

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
/** Events without an end (or ending at their start) still get a block this long. */
const MIN_MINUTES = 30;

/** Monday of the week holding `date`, at local midnight. */
export const weekStart = (date: Date) => startOfWeek(date, { weekStartsOn: 1 });

export const weekDays = (start: Date) => Array.from({ length: 7 }, (_, i) => addDays(start, i));

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An event's start or end as a Date: all-day events' days are local midnights. */
function eventDate(value: string) {
  const day = DAY.exec(value);
  return day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
}

/** Where an event starts and ends ([start, end), end at least MIN_MINUTES after a timed start). */
export function eventSpan(event: CalendarEvent) {
  const start = eventDate(event.start);
  const end = event.end ? eventDate(event.end) : null;
  if (event.allDay) return { start, end: end && end > start ? end : addDays(start, 1) };
  return { start, end: end && end.getTime() > start.getTime() ? end : new Date(start.getTime() + MIN_MINUTES * MINUTE) };
}

/** A timed event's block in one day column: minutes from midnight, and its lane among overlapping ones. */
type PlacedEvent = { event: CalendarEvent; top: number; height: number; lane: number; lanes: number; continues: boolean };

/** Timed events on `day` (clipped to it), laid out in lanes so overlapping ones sit side by side. */
export function placeTimed(events: CalendarEvent[], day: Date): PlacedEvent[] {
  const dayStart = day.getTime();
  const dayEnd = addDays(day, 1).getTime();
  const blocks = events
    .filter((e) => !e.allDay && e.you !== "declined")
    .map((event) => ({ event, ...eventSpan(event) }))
    .filter((b) => b.start.getTime() < dayEnd && b.end.getTime() > dayStart)
    .map((b) => {
      const from = Math.max(b.start.getTime(), dayStart);
      const to = Math.min(b.end.getTime(), dayEnd);
      const top = (from - dayStart) / MINUTE;
      return { event: b.event, top, height: Math.max(MIN_MINUTES, Math.min(DAY_MINUTES - top, (to - from) / MINUTE)), continues: b.end.getTime() > dayEnd };
    })
    .sort((a, b) => a.top - b.top || b.height - a.height);

  const placed: PlacedEvent[] = [];
  let cluster: PlacedEvent[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;
  const close = () => {
    for (const p of cluster) p.lanes = laneEnds.length;
    cluster = [];
    laneEnds = [];
  };
  for (const block of blocks) {
    if (block.top >= clusterEnd) {
      close();
      clusterEnd = 0;
    }
    let lane = laneEnds.findIndex((end) => end <= block.top);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = block.top + block.height;
    clusterEnd = Math.max(clusterEnd, block.top + block.height);
    const p = { ...block, lane, lanes: 1 };
    cluster.push(p);
    placed.push(p);
  }
  close();
  return placed;
}

/** An all-day event's bar across the week: first column, columns covered, and its row. */
type AllDayBar = { event: CalendarEvent; column: number; span: number; row: number };

/** All-day events in the week starting `start`, as bars stacked in rows that don't overlap. */
export function placeAllDay(events: CalendarEvent[], start: Date): AllDayBar[] {
  const days = weekDays(start).map((d) => d.getTime());
  const weekEnd = addDays(start, 7).getTime();
  const rows: number[] = [];
  return events
    .filter((e) => e.allDay && e.you !== "declined")
    .map((event) => ({ event, ...eventSpan(event) }))
    .filter((b) => b.start.getTime() < weekEnd && b.end.getTime() > days[0])
    .sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime())
    .map((b) => {
      const column = Math.max(0, days.findLastIndex((d) => d <= b.start.getTime()));
      const last = days.findLastIndex((d) => d < b.end.getTime());
      const span = Math.max(1, last - column + 1);
      let row = rows.findIndex((free) => free <= column);
      if (row === -1) row = rows.length;
      rows[row] = column + span;
      return { event: b.event, column, span, row };
    });
}

/** Events on one local day, all-day ones first then by start (declined ones left out). */
export function eventsOn(events: CalendarEvent[], day: Date) {
  const from = day.getTime();
  const to = addDays(day, 1).getTime();
  return events
    .filter((e) => e.you !== "declined")
    .filter((e) => {
      const { start, end } = eventSpan(e);
      return start.getTime() < to && end.getTime() > from;
    })
    .sort((a, b) => Number(b.allDay) - Number(a.allDay) || eventDate(a.start).getTime() - eventDate(b.start).getTime() || a.summary.localeCompare(b.summary));
}

/** Demo mode: the demo calendar plus the sample mail's invites, standing in for the calendar they would be in. */
export function demoEvents(threads: Thread[]): CalendarEvent[] {
  return [...demoCalendar(), ...inviteEvents(threads)];
}

function inviteEvents(threads: Thread[]): CalendarEvent[] {
  return threads.flatMap((thread) =>
    thread.messages.flatMap((message) => {
      const invite = message.invite;
      if (!invite || invite.method !== "REQUEST" || invite.cancelled) return [];
      return [
        {
          id: `${thread.accountId}:${invite.uid}`,
          accountId: thread.accountId,
          uid: invite.uid,
          summary: invite.summary,
          start: invite.start,
          ...(invite.end ? { end: invite.end } : {}),
          allDay: invite.allDay,
          ...(invite.location ? { location: invite.location } : {}),
          ...(invite.join ? { join: invite.join } : {}),
          ...(invite.organizer ? { organizer: invite.organizer } : {}),
          ...(invite.you ? { you: invite.you } : {}),
          ...(invite.recurrence ? { recurring: true } : {}),
        } satisfies CalendarEvent,
      ];
    }),
  );
}
