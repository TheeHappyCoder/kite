import "server-only";

import type { DesktopMeeting } from "@/lib/desktop";
import { SOON_LATE_MS, SOON_LEAD_MS, startingSoon } from "@/lib/calendar/soon";
import { listAccounts } from "./db";
import { listEvents } from "./events";

// Meetings about to start, from the local copy of the accounts' calendars (server/events.ts), for the
// desktop app's Kite bar. Each occurrence is announced once; read on the sync tick, never from the network.

type Announced = Map<string, number>;
const g = globalThis as unknown as { __kiteMeetingsAnnounced?: Announced };
/** Announced occurrences (`${event id}@${start}`) -> their start, on globalThis so hot reloads don't announce twice. */
const announced = (g.__kiteMeetingsAnnounced ??= new Map());

/** Meetings to announce now: starting within 2 minutes and not announced before. */
export function dueMeetings(now = Date.now()): DesktopMeeting[] {
  for (const [id, start] of announced) if (now - start > SOON_LATE_MS) announced.delete(id);
  const from = new Date(now - SOON_LATE_MS).toISOString();
  const to = new Date(now + SOON_LEAD_MS + 60_000).toISOString();
  const events = listEvents(
    listAccounts().map((a) => a.id),
    from,
    to,
  );
  const due: DesktopMeeting[] = [];
  for (const event of startingSoon(events, now)) {
    const id = `${event.id}@${event.start}`;
    if (announced.has(id)) continue;
    announced.set(id, new Date(event.start).getTime());
    due.push({
      id,
      title: event.summary || "Meeting",
      start: event.start,
      end: event.end,
      join: event.join?.startsWith("https://") ? event.join : undefined,
      place: event.location,
    });
  }
  return due;
}
