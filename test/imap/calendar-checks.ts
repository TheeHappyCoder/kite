import { expect, it } from "vitest";
import { listEvents, syncCalendar, usesMailCalendar } from "@/server/events";
import type { Mailbox } from "./harness";

// The mail calendar from the fixtures' invites (scripts/imap-test-server.mjs calendarMail): shared by
// the plain IMAP and Gmail suites. Needs the `calendar` preference on and a first sync done.

const DAY = 86_400_000;
const at = (days: number, hours: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + days * DAY + hours * 3_600_000).toISOString();
};

export function calendarChecks(box: Mailbox) {
  it("the mail calendar: answers, SEQUENCE, RRULE with EXDATE, cancellations", async () => {
    expect(usesMailCalendar(box.account)).toBe(true);
    await syncCalendar(box.account, true);
    const events = listEvents([box.account.id], new Date(Date.now() - 3 * DAY).toISOString(), new Date(Date.now() + 35 * DAY).toISOString());
    const seen = events.map((e) => ({ summary: e.summary, start: e.start, you: e.you, recurring: !!e.recurring }));
    expect(seen).toEqual([
      // Weekly, four times, the second week left out; not answered.
      { summary: "Weekly stand-up", start: at(1, 9), you: "needs-action", recurring: true },
      // SEQUENCE 2 wins over the SEQUENCE 1 resent after it; answered Yes in another app (a REPLY in Sent).
      { summary: "Design review", start: at(3, 14), you: "accepted", recurring: false },
      // Answered Maybe.
      { summary: "Budget sync", start: at(5, 11), you: "tentative", recurring: false },
      { summary: "Weekly stand-up", start: at(15, 9), you: "needs-action", recurring: true },
      { summary: "Weekly stand-up", start: at(22, 9), you: "needs-action", recurring: true },
      // Not here: Team offsite (answered No) and Team lunch (cancelled).
    ]);
    expect(events.every((e) => e.source === "mail")).toBe(true);
  });
}
