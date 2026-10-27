import type { CalendarEvent } from "./event";

// Which events are "about to start", for the desktop app's Kite bar (server/meetings.ts). Pure, so the
// window is tested without a clock.

/** How early a meeting shows. */
export const SOON_LEAD_MS = 2 * 60_000;
/** A meeting that already started still shows this long (Kite opened late, or a sync came late). */
export const SOON_LATE_MS = 5 * 60_000;

/** Timed events you haven't declined that start within the lead, or started a moment ago. */
export function startingSoon(events: CalendarEvent[], now: number): CalendarEvent[] {
  return events.filter((event) => {
    if (event.allDay || event.you === "declined") return false;
    const start = new Date(event.start).getTime();
    return Number.isFinite(start) && start - now <= SOON_LEAD_MS && now - start < SOON_LATE_MS;
  });
}
