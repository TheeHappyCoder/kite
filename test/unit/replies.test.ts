import { describe, expect, it } from "vitest";
import type { Message, Thread } from "@/lib/mail/types";
import { acquaintances, findReplies, IGNORED_AFTER, looksPersonal, replyStanding, type ReplyCandidate } from "@/lib/replies";

const ME = "me@x.test";
const NOW = Date.parse("2026-10-27T12:00:00Z");
let n = 0;
const message = (from: string, name: string, to: string[], date = "2026-10-26T10:00:00Z"): Message => ({
  id: `m${n++}`,
  from: { name, email: from },
  to: to.map((email) => ({ name: email, email })),
  date,
  body: [],
});
const thread = (messages: Message[]): Thread => ({
  id: `t${n++}`,
  accountId: "a",
  subject: "Hello",
  messages,
  mailbox: "inbox",
  category: "important",
  unread: false,
  starred: false,
});
const candidate = (t: Thread): ReplyCandidate => ({ thread: t, inbox: true, bulk: false });
const stranger = { sent: 0, seen: 1, started: 1, answered: 0 };

describe("looksPersonal", () => {
  it("knows a person's own address", () => {
    expect(looksPersonal({ name: "Thandi Mokoena", email: "thandi@studio.test" })).toBe(true);
    expect(looksPersonal({ name: "sam.lee", email: "sam.lee@hosting.test" })).toBe(true);
  });
  it("turns down companies, desks and mailings", () => {
    expect(looksPersonal({ name: "Deployco", email: "system@deployco.test" })).toBe(false);
    expect(looksPersonal({ name: "Domainly Renewals", email: "renewals@domainly.test" })).toBe(false);
    expect(looksPersonal({ name: "Medical Aid Admin (Jo Smith)", email: "admin@medicalaid.test" })).toBe(false);
    expect(looksPersonal({ name: "Alex from Bookit", email: "alex@bookit.test" })).toBe(false);
    expect(looksPersonal({ name: "Gigly", email: "hello@gigly.test" })).toBe(false);
    expect(looksPersonal({ name: "", email: "jane@x.test" })).toBe(false);
  });
});

describe("replyStanding", () => {
  const thandi = { name: "Thandi Mokoena", email: "thandi@studio.test" };
  it("keeps anyone you've written to or answered", () => {
    expect(replyStanding({ name: "Telco", email: "bill@telco.test" }, { ...stranger, sent: 1 }, 0)).toBe("known");
    expect(replyStanding(thandi, { ...stranger, answered: 1 }, 0)).toBe("known");
  });
  it("offers a stranger who looks like a person, until you've ignored or dismissed them", () => {
    expect(replyStanding(thandi, stranger, 0)).toBe("new");
    expect(replyStanding(thandi, { ...stranger, started: IGNORED_AFTER }, 0)).toBeNull();
    expect(replyStanding(thandi, stranger, 1)).toBeNull();
  });
  it("leaves out companies you've never written to", () => {
    expect(replyStanding({ name: "Telco", email: "telcobill@telco.test" }, stranger, 0)).toBeNull();
  });
});

describe("findReplies", () => {
  it("learns who you answer from your own mail", () => {
    const lerato = (date: string) => message("lerato@firm.test", "Lerato Dube", [ME], date);
    const answered = thread([lerato("2026-10-01T09:00:00Z"), message(ME, "Pat Owner", ["lerato@firm.test"], "2026-10-01T10:00:00Z")]);
    const owed = thread([lerato("2026-10-26T09:00:00Z")]);
    const bill = thread([message("telcobill@telco.test", "Telco", [ME])]);
    const forwarded = thread([message("pat@work.test", "Pat Owner", [ME])]);
    const threads = [answered, owed, bill, forwarded];
    const found = findReplies(threads.map(candidate), {
      me: () => ME,
      people: acquaintances(threads, new Set([ME])),
      ownNames: new Set(["pat owner"]),
      waitDays: 3,
      now: NOW,
    });
    expect(found.toReply.map((i) => i.threadId)).toEqual([owed.id]);
    expect(found.toReply[0].known).toBe(true);
  });

  it("counts conversations started and answered", () => {
    const a = thread([message("jo@x.test", "Jo Smith", [ME]), message(ME, "Pat", ["jo@x.test"])]);
    const b = thread([message("jo@x.test", "Jo Smith", [ME])]);
    expect(acquaintances([a, b], new Set([ME]))("jo@x.test")).toEqual({ sent: 1, seen: 2, started: 2, answered: 1 });
  });
});

describe("Waiting on", () => {
  it("skips unsubscribe requests and addresses that never write back", () => {
    const sent = (to: string, name = to) => thread([{ ...message(ME, "Pat", [to], "2026-10-10T10:00:00Z"), to: [{ name, email: to }] }]);
    const unsubscribe = sent("32.ABCDEF@unsubscribe.mailer.test");
    const desk = sent("applications@bank.test", "Applications");
    const person = sent("nomsa@agency.test", "Nomsa Khumalo");
    const threads = [unsubscribe, desk, person];
    const found = findReplies(threads.map(candidate), { me: () => ME, people: acquaintances(threads, new Set([ME])), waitDays: 3, now: NOW });
    expect(found.waiting.map((i) => i.threadId)).toEqual([person.id]);
  });
});
