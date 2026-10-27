import { describe, expect, it } from "vitest";
import { buildReply, findJoinLink, parseEvents, parseIcs, stripPrefix, zonedInstant } from "@/lib/calendar/ics";
import { expandRule } from "@/lib/calendar/recur";

const ME = "kite@example.test";
const cal = (method: string, ...event: string[]) =>
  ["BEGIN:VCALENDAR", "VERSION:2.0", `METHOD:${method}`, "BEGIN:VEVENT", ...event, "END:VEVENT", "END:VCALENDAR", ""].join("\r\n");

describe("parseIcs", () => {
  it("reads an invite from your point of view", () => {
    const invite = parseIcs(
      cal(
        "REQUEST",
        "UID:abc-1",
        "SEQUENCE:2",
        "DTSTART;TZID=Africa/Johannesburg:20261020T150000",
        "DTEND;TZID=Africa/Johannesburg:20261020T160000",
        "SUMMARY:Design review\\, round 2",
        "LOCATION:Room 4",
        "DESCRIPTION:Join: https://meet.google.com/abc-defg-hij.",
        'ORGANIZER;CN="Nomsa Dlamini":mailto:nomsa@company.co.za',
        "ATTENDEE;CN=Kite;PARTSTAT=TENTATIVE:mailto:KITE@example.test",
        "ATTENDEE;CN=Sipho;ROLE=OPT-PARTICIPANT:mailto:sipho@example.org",
      ),
      ME,
    )!;
    expect(invite).toMatchObject({
      uid: "abc-1",
      method: "REQUEST",
      sequence: 2,
      summary: "Design review, round 2",
      start: "2026-10-20T13:00:00.000Z",
      end: "2026-10-20T14:00:00.000Z",
      allDay: false,
      timeZone: "Africa/Johannesburg",
      location: "Room 4",
      join: "https://meet.google.com/abc-defg-hij",
      organizer: { name: "Nomsa Dlamini", email: "nomsa@company.co.za" },
      you: "tentative",
    });
    expect(invite.attendees[1]).toMatchObject({ email: "sipho@example.org", status: "needs-action", optional: true });
  });

  it("unfolds long lines", () => {
    const invite = parseIcs(cal("REQUEST", "UID:x", "DTSTART:20261020T090000Z", "SUMMARY:A very long", "  title that wraps"))!;
    expect(invite.summary).toBe("A very long title that wraps");
  });

  it("reads all-day events and DURATION", () => {
    expect(parseIcs(cal("PUBLISH", "UID:d", "DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261226", "SUMMARY:Leave"))).toMatchObject({ allDay: true, start: "2026-12-24T00:00:00.000Z", end: "2026-12-26T00:00:00.000Z" });
    expect(parseIcs(cal("REQUEST", "UID:p", "DTSTART:20261020T090000Z", "DURATION:PT1H30M", "SUMMARY:Call"))?.end).toBe("2026-10-20T10:30:00.000Z");
  });

  it("uses the file's VTIMEZONE for Windows zone names", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VTIMEZONE",
      "TZID:South Africa Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16010101T000000",
      "TZOFFSETFROM:+0200",
      "TZOFFSETTO:+0200",
      "END:STANDARD",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:w",
      "DTSTART;TZID=South Africa Standard Time:20261020T090000",
      "SUMMARY:Standup",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    expect(parseIcs(text)?.start).toBe("2026-10-20T07:00:00.000Z");
  });

  it("reads cancellations and the recurrence summary", () => {
    expect(parseIcs(cal("CANCEL", "UID:c", "DTSTART:20261020T090000Z", "SUMMARY:Canceled: Lunch"))).toMatchObject({ cancelled: true, summary: "Lunch" });
    expect(parseIcs(cal("REQUEST", "UID:r", "DTSTART:20261020T090000Z", "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", "SUMMARY:Standup"))?.recurrence).toBe("Weekly on weekdays");
    expect(parseIcs(cal("REQUEST", "UID:r", "DTSTART:20261020T090000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=6", "SUMMARY:1:1"))?.recurrence).toBe("Every 2 weeks, 6 times");
  });

  it("is null without an event or a start", () => {
    expect(parseIcs("BEGIN:VCALENDAR\r\nEND:VCALENDAR")).toBeNull();
    expect(parseIcs(cal("REQUEST", "UID:n", "SUMMARY:No start"))).toBeNull();
    expect(parseIcs("not a calendar")).toBeNull();
  });
});

describe("parseEvents", () => {
  it("keeps the series with its EXDATEs and changed occurrences apart", () => {
    const text = [
      "BEGIN:VCALENDAR",
      "METHOD:REQUEST",
      "BEGIN:VEVENT",
      "UID:s",
      "DTSTART;TZID=Africa/Johannesburg:20261019T090000",
      "DTEND;TZID=Africa/Johannesburg:20261019T093000",
      "RRULE:FREQ=WEEKLY;UNTIL=20261116T070000Z",
      "EXDATE;TZID=Africa/Johannesburg:20261026T090000,20261102T090000",
      "SUMMARY:Standup",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:s",
      "RECURRENCE-ID;TZID=Africa/Johannesburg:20261109T090000",
      "DTSTART;TZID=Africa/Johannesburg:20261109T110000",
      "DTEND;TZID=Africa/Johannesburg:20261109T113000",
      "SUMMARY:Standup (moved)",
      "END:VEVENT",
      "END:VCALENDAR",
    ].join("\r\n");
    const parsed = parseEvents(text, ME)!;
    expect(parsed.method).toBe("REQUEST");
    const [series, moved] = parsed.events;
    expect(series.rule).toBe("FREQ=WEEKLY;UNTIL=20261116T070000Z");
    expect(series.exdates).toEqual(["2026-10-26T07:00:00.000Z", "2026-11-02T07:00:00.000Z"]);
    expect(moved.occurrence).toBe("2026-11-09T07:00:00.000Z");
    expect(moved.start).toBe("2026-11-09T09:00:00.000Z");

    const walls = expandRule(series.rule!, series.wallStart, Date.UTC(2027, 0, 1), series.pastUntil)!;
    const starts = walls.map((w) => series.instantAt(w));
    // UNTIL is 09:00 local on 16 Nov, so that occurrence is the last.
    expect(starts).toEqual(["2026-10-19T07:00:00.000Z", "2026-10-26T07:00:00.000Z", "2026-11-02T07:00:00.000Z", "2026-11-09T07:00:00.000Z", "2026-11-16T07:00:00.000Z"]);
    expect(starts.filter((s) => !series.exdates.includes(s))).toHaveLength(3);
  });

  it("keeps wall-clock time across daylight saving", () => {
    const parsed = parseEvents(cal("REQUEST", "UID:dst", "DTSTART;TZID=Europe/London:20261019T100000", "RRULE:FREQ=WEEKLY;COUNT=3", "SUMMARY:Call"))!;
    const [e] = parsed.events;
    const starts = expandRule(e.rule!, e.wallStart, Date.UTC(2027, 0, 1), e.pastUntil)!.map((w) => e.instantAt(w));
    // British Summer Time ends on 25 October: 10:00 local is 09:00 UTC before, 10:00 UTC after.
    expect(starts).toEqual(["2026-10-19T09:00:00.000Z", "2026-10-26T10:00:00.000Z", "2026-11-02T10:00:00.000Z"]);
  });
});

describe("expandRule", () => {
  const start = Date.UTC(2026, 9, 1, 9); // Thursday 1 October 2026, 09:00 wall-clock
  const until = Date.UTC(2027, 11, 31);
  const days = (rule: string, before = until) => expandRule(rule, start, before)?.map((w) => new Date(w).toISOString().slice(0, 10));

  it("daily with INTERVAL and COUNT", () => {
    expect(days("FREQ=DAILY;INTERVAL=2;COUNT=3")).toEqual(["2026-10-01", "2026-10-03", "2026-10-05"]);
  });

  it("weekly on named days", () => {
    expect(days("FREQ=WEEKLY;BYDAY=TU,TH;COUNT=4")).toEqual(["2026-10-01", "2026-10-06", "2026-10-08", "2026-10-13"]);
  });

  it("monthly on the second Tuesday and the last Friday", () => {
    expect(days("FREQ=MONTHLY;BYDAY=2TU;COUNT=3")).toEqual(["2026-10-01", "2026-10-13", "2026-11-10"]);
    expect(days("FREQ=MONTHLY;BYDAY=-1FR;COUNT=3")).toEqual(["2026-10-01", "2026-10-30", "2026-11-27"]);
  });

  it("monthly on the last weekday (BYSETPOS)", () => {
    expect(days("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3")).toEqual(["2026-10-01", "2026-10-30", "2026-11-30"]);
  });

  it("monthly on the 31st skips short months", () => {
    const s = Date.UTC(2026, 0, 31, 9);
    expect(expandRule("FREQ=MONTHLY;COUNT=3", s, until)?.map((w) => new Date(w).toISOString().slice(0, 10))).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
  });

  it("yearly by month", () => {
    expect(days("FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=1")).toEqual(["2026-10-01", "2027-10-01"]);
  });

  it("stops before `before` and at UNTIL", () => {
    expect(days("FREQ=WEEKLY", Date.UTC(2026, 9, 20))).toEqual(["2026-10-01", "2026-10-08", "2026-10-15"]);
    expect(expandRule("FREQ=DAILY", start, until, (w) => w > Date.UTC(2026, 9, 3, 9))?.length).toBe(3);
  });

  it("returns null for parts it doesn't read, [] past the window", () => {
    expect(expandRule("FREQ=WEEKLY;BYWEEKNO=20", start, until)).toBeNull();
    expect(expandRule("FREQ=HOURLY", start, until)).toBeNull();
    expect(expandRule("FREQ=DAILY", start, start)).toEqual([]);
  });
});

describe("helpers", () => {
  it("zonedInstant reads a wall-clock time in a zone", () => {
    expect(zonedInstant("2026-10-20T15:00:00", "Africa/Johannesburg")).toBe("2026-10-20T13:00:00.000Z");
  });

  it("findJoinLink and stripPrefix", () => {
    expect(findJoinLink(undefined, "Teams: https://teams.microsoft.com/l/meetup-join/19%3a123/0?context=x).")).toBe("https://teams.microsoft.com/l/meetup-join/19%3a123/0?context=x");
    expect(findJoinLink("Room 4")).toBeUndefined();
    expect(stripPrefix("Updated invitation: Design review")).toBe("Design review");
  });

  it("buildReply answers with your PARTSTAT, folded and escaped", () => {
    const invite = parseIcs(cal("REQUEST", "UID:abc-1", "SEQUENCE:3", "DTSTART:20261020T090000Z", "SUMMARY:Review; then lunch", "ORGANIZER;CN=Nomsa:mailto:nomsa@company.co.za"), ME)!;
    const reply = buildReply(invite, { name: "Kite Test", email: ME }, "accepted", "See you there", new Date(Date.UTC(2026, 9, 16)));
    expect(reply).toContain("METHOD:REPLY");
    expect(reply).toContain("SEQUENCE:3");
    expect(reply).toContain(`ATTENDEE;CN="Kite Test";PARTSTAT=ACCEPTED:mailto:${ME}`);
    expect(reply).toContain("SUMMARY:Review\\; then lunch");
    expect(reply.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75)).toBe(true);
    expect(reply).toContain("DTSTART:20261020T090000Z");
    // Read back like an answer found in Sent (the mail calendar).
    expect(parseEvents(reply, ME)?.events[0]).toMatchObject({ uid: "abc-1", method: "REPLY", you: "accepted" });
    const allDay = parseIcs(cal("REQUEST", "UID:d", "DTSTART;VALUE=DATE:20261224", "DTEND;VALUE=DATE:20261226", "SUMMARY:Leave"), ME)!;
    expect(buildReply(allDay, { name: "Kite", email: ME }, "declined")).toContain("DTSTART;VALUE=DATE:20261224\r\nDTEND;VALUE=DATE:20261226");
  });
});
