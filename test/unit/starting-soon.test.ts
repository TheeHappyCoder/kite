import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@/lib/calendar/event";
import { startingSoon } from "@/lib/calendar/soon";

const now = Date.parse("2026-10-23T10:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
const event = (id: string, start: string, more: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  accountId: "a",
  summary: id,
  start,
  allDay: false,
  ...more,
});

describe("startingSoon", () => {
  it("takes meetings starting within two minutes or a moment ago", () => {
    const events = [
      event("in-1", at(1)),
      event("in-2", at(2)),
      event("in-3", at(3)),
      event("started-4", at(-4)),
      event("started-6", at(-6)),
    ];
    expect(startingSoon(events, now).map((e) => e.id)).toEqual(["in-1", "in-2", "started-4"]);
  });

  it("leaves out all-day events and meetings you declined", () => {
    const events = [
      event("all-day", "2026-10-23", { allDay: true }),
      event("declined", at(1), { you: "declined" }),
      event("maybe", at(1), { you: "tentative" }),
      event("unanswered", at(1), { you: "needs-action" }),
    ];
    expect(startingSoon(events, now).map((e) => e.id)).toEqual(["maybe", "unanswered"]);
  });
});
