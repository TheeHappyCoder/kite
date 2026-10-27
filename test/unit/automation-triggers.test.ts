import { describe, expect, it } from "vitest";
import { stepOf, type Expectation } from "@/lib/automations/expect";
import { companyOf, readField } from "@/lib/automations/fields";
import { matchesSearch, parseSearch, toGmailQuery } from "@/lib/mail/search";
import type { Thread } from "@/lib/mail/types";
import { gmailFilterFor } from "@/lib/rules/gmail";
import { describeSchedule, lastOccurrence, nextOccurrence, periodBefore, referenceProblem, RuleSchema } from "@/lib/rules/spec";

// Automations' new triggers and waits, without mail: when a schedule comes round, what an
// expectation does next, OR in searches, and the checks that keep an automation's parts consistent.

describe("schedules", () => {
  const monthly = { every: "month" as const, day: 1, time: "09:00" };

  it("finds the last and next time a monthly schedule came round", () => {
    expect(lastOccurrence(monthly, new Date(2026, 9, 26, 12)).getTime()).toBe(new Date(2026, 9, 1, 9).getTime());
    // Before 09:00 on the 1st, the last one was the month before.
    expect(lastOccurrence(monthly, new Date(2026, 10, 1, 8)).getTime()).toBe(new Date(2026, 9, 1, 9).getTime());
    expect(nextOccurrence(monthly, new Date(2026, 9, 26, 12)).getTime()).toBe(new Date(2026, 10, 1, 9).getTime());
    // January looks back to December.
    expect(lastOccurrence(monthly, new Date(2027, 0, 1, 8)).getTime()).toBe(new Date(2026, 11, 1, 9).getTime());
  });

  it("puts 'the last day' on the month's last day", () => {
    const last = { every: "month" as const, day: 31, time: "17:00" };
    expect(lastOccurrence(last, new Date(2026, 2, 5)).getTime()).toBe(new Date(2026, 1, 28, 17).getTime());
    expect(nextOccurrence(last, new Date(2026, 2, 5)).getTime()).toBe(new Date(2026, 2, 31, 17).getTime());
    expect(describeSchedule(last)).toBe("On the last day of every month at 17:00");
  });

  it("handles weekly schedules", () => {
    const monday = { every: "week" as const, day: 1, time: "08:30" };
    // Monday 26 October 2026, 08:00: last Monday's run.
    expect(lastOccurrence(monday, new Date(2026, 9, 26, 8)).getTime()).toBe(new Date(2026, 9, 19, 8, 30).getTime());
    expect(lastOccurrence(monday, new Date(2026, 9, 26, 9)).getTime()).toBe(new Date(2026, 9, 26, 8, 30).getTime());
    expect(nextOccurrence(monday, new Date(2026, 9, 26, 9)).getTime()).toBe(new Date(2026, 10, 2, 8, 30).getTime());
    expect(describeSchedule(monday)).toBe("Every Monday at 08:30");
  });

  it("looks back over last month early in a month, this month later on", () => {
    expect(periodBefore(monthly, new Date(2026, 10, 1, 9)).name).toBe("October 2026");
    expect(periodBefore({ every: "month", day: 25, time: "09:00" }, new Date(2026, 9, 25, 9)).name).toBe("October 2026");
    const week = periodBefore({ every: "week", day: 1, time: "09:00" }, new Date(2026, 9, 26, 9));
    expect(week.start.getTime()).toBe(new Date(2026, 9, 19).getTime());
    expect(week.end.getTime()).toBe(new Date(2026, 9, 26).getTime());
  });
});

describe("what an expectation does next", () => {
  const DAY = 86_400_000;
  const now = Date.parse("2026-10-26T10:00:00Z");
  const base: Pick<Expectation, "status" | "plan" | "askedAt" | "dueAt" | "nudged" | "nudgedAt"> = {
    status: "waiting",
    plan: { askSubject: "", ask: "", nudges: ["first", "second"], every: 7, auto: false },
    askedAt: null,
    dueAt: new Date(now + DAY).toISOString(),
    nudged: 0,
    nudgedAt: null,
  };

  it("waits until it's due, then the nudges come one at a time", () => {
    expect(stepOf(base, now)).toEqual({ kind: "waiting", overdue: false, next: base.dueAt });
    const due = { ...base, dueAt: new Date(now - DAY).toISOString() };
    expect(stepOf(due, now)).toEqual({ kind: "nudge", index: 0 });
    const once = { ...due, nudged: 1, nudgedAt: new Date(now - 2 * DAY).toISOString() };
    expect(stepOf(once, now)).toMatchObject({ kind: "waiting", overdue: true });
    expect(stepOf(once, now + 6 * DAY)).toEqual({ kind: "nudge", index: 1 });
    expect(stepOf({ ...once, nudged: 2 }, now + 30 * DAY)).toEqual({ kind: "waiting", overdue: true, next: null });
  });

  it("asks first when there's a request, and stops when answered", () => {
    const asking = { ...base, plan: { ...base.plan, ask: "Please send it" } };
    expect(stepOf(asking, now)).toEqual({ kind: "ask" });
    expect(stepOf({ ...asking, askedAt: new Date(now).toISOString() }, now).kind).toBe("waiting");
    expect(stepOf({ ...asking, status: "met" }, now)).toEqual({ kind: "met" });
    expect(stepOf({ ...asking, status: "stopped" }, now)).toEqual({ kind: "stopped" });
  });
});

describe("OR in searches", () => {
  const thread = (subject: string) => ({ subject, messages: [{ id: "m", from: { name: "A", email: "a@x.example" }, to: [], date: "", body: [subject] }] }) as unknown as Thread;

  it("joins the terms on either side, like Gmail", () => {
    const terms = parseSearch("subject:paid OR subject:payment from:bank");
    expect(terms.map((t) => t.field)).toEqual(["any", "from"]);
    expect(terms[0].any?.map((t) => t.value)).toEqual(["paid", "payment"]);
    expect(matchesSearch(thread("Payment received"), parseSearch("subject:paid OR subject:payment"))).toBe(true);
    expect(matchesSearch(thread("Invoice"), parseSearch("subject:paid OR subject:payment"))).toBe(false);
    expect(parseSearch("a OR b OR c")[0].any).toHaveLength(3);
    // Lower-case "or" is a word, as in Gmail.
    expect(parseSearch("this or that").map((t) => t.value)).toEqual(["this", "or", "that"]);
    expect(toGmailQuery(parseSearch("subject:paid OR invoice"))).toBe("{subject:paid invoice}");
  });

  it("stays a Gmail filter when every side can be one", () => {
    const base = { conditions: [], actions: [{ verb: "archive" as const }], stop: false };
    expect(gmailFilterFor({ ...base, query: "from:a.example OR from:b.example" }).ok).toBe(true);
    expect(gmailFilterFor({ ...base, query: "from:a.example OR is:unread" }).ok).toBe(false);
    expect(gmailFilterFor({ ...base, query: "from:a.example", when: "sent" }).ok).toBe(false);
    expect(gmailFilterFor({ ...base, query: "from:a.example", delay: 60 }).ok).toBe(false);
  });
});

describe("reading who and what", () => {
  it("names the company from the address, not a free mail service", () => {
    expect(companyOf("jobs@careers.acme-build.co.za")).toBe("Acme Build");
    expect(companyOf("talent@globex.example")).toBe("Globex");
    expect(companyOf("hi@x.ai")).toBe("X");
    expect(companyOf("bob@mail.bbc.co.uk")).toBe("Bbc");
    expect(companyOf("thandi@gmail.com", "Thandi Nkosi")).toBe("Thandi Nkosi");
    expect(companyOf("thandi@gmail.com")).toBeNull();
  });

  it("reads a fixed value on every email", () => {
    const email = { senderName: "", senderEmail: "a@b.example", subject: "Hi", date: new Date().toISOString(), text: "" };
    expect(readField({ key: "status", name: "Status", type: "text", from: { kind: "fixed", value: "Applied" } }, email)).toEqual({ text: "Applied" });
  });
});

describe("an automation's parts fit its trigger", () => {
  const rule = (extra: object) => RuleSchema.parse({ id: "r", name: "R", enabled: true, actions: [{ verb: "archive" }], ...extra });

  it("allows only the steps a trigger can run", () => {
    expect(referenceProblem(rule({ when: "sent", actions: [{ verb: "notify", mode: "now" }] }))).toMatch(/can't run on mail you send/);
    expect(referenceProblem(rule({ when: "schedule", schedule: { every: "month", day: 1 }, actions: [{ verb: "archive" }] }))).toMatch(/can't run on a schedule/);
    expect(referenceProblem(rule({ when: "sent", delay: 60 }))).toMatch(/wait before acting/);
  });

  it("needs people for a scheduled wait, and a schedule's request only on a schedule", () => {
    const expect_ = { verb: "expect", days: 7, nudges: [] };
    expect(referenceProblem(rule({ when: "schedule", schedule: { every: "month", day: 1 }, actions: [expect_] }))).toMatch(/people/);
    expect(
      referenceProblem(rule({ when: "schedule", schedule: { every: "month", day: 1 }, conditions: [{ kind: "senders", emails: ["a@b.example"] }], actions: [{ ...expect_, ask: "Send it", askSubject: "Docs" }] })),
    ).toBeNull();
    expect(referenceProblem(rule({ when: "sent", actions: [{ ...expect_, ask: "Send it", askSubject: "Docs" }] }))).toMatch(/Only a schedule asks first/);
  });

  it("keeps one row per a field the automation reads", () => {
    const fields = [{ key: "company", name: "Company", type: "text", from: { kind: "builtin", builtin: "company" } }];
    expect(referenceProblem(rule({ fields, actions: [{ verb: "collect", collection: "c", match: "company" }] }))).toBeNull();
    expect(referenceProblem(rule({ fields, actions: [{ verb: "collect", collection: "c", match: "nope" }] }))).toMatch(/one row per thing/);
  });
});
