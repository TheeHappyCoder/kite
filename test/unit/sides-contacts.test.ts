import { describe, expect, it } from "vitest";
import { contactsFrom, letterOf, shownContacts, type ContactEntry } from "@/lib/mail/contacts";
import { inboxTabs, sideOf } from "@/lib/mail/sides";
import type { Message, Thread } from "@/lib/mail/types";

const message = (from: string, to: string[], date = "2026-10-20T10:00:00Z", name = ""): Message => ({
  id: `${from}-${date}`,
  from: { name: name || from, email: from },
  to: to.map((email) => ({ name: email, email })),
  date,
  body: [],
});
const thread = (messages: Message[], patch: Partial<Thread> = {}): Thread => ({
  id: messages[0].id,
  accountId: "a",
  subject: "Hello",
  messages,
  mailbox: "inbox",
  category: "important",
  unread: false,
  starred: false,
  ...patch,
});

describe("inbox tabs", () => {
  it("follow the provider's sorting, not the sender's address", () => {
    expect(sideOf(thread([message("no-reply@uber.com", ["me@x.test"])]))).toBe("important");
    expect(sideOf(thread([message("thandi@company.co.za", ["me@x.test"])], { category: "notifications" }))).toBe("notifications");
  });
  it("show Primary, then only the tabs that have mail, in Gmail's order", () => {
    expect(inboxTabs([], false).map((t) => t.label)).toEqual(["Primary"]);
    expect(inboxTabs(["notifications", "newsletters"], false).map((t) => t.label)).toEqual(["Primary", "Promotions", "Updates"]);
  });
  it("use Outlook's words when every account in view is Outlook", () => {
    expect(inboxTabs(["notifications"], true).map((t) => t.label)).toEqual(["Focused", "Other"]);
  });
});

describe("contacts", () => {
  const own = new Set(["me@x.test"]);
  const threads = [
    thread([message("pieter@gmail.com", ["me@x.test"], "2026-10-20T10:00:00Z", "Pieter van Wyk"), message("me@x.test", ["pieter@gmail.com"], "2026-10-20T11:00:00Z")]),
    thread([message("no-reply@uber.com", ["me@x.test"], "2026-10-21T08:00:00Z", "Uber")]),
    thread([message("me@x.test", ["anja@gmail.com"], "2026-10-19T08:00:00Z")]),
  ];
  const entries = contactsFrom(threads, own);

  it("counts what each side sent, without your own addresses", () => {
    const pieter = entries.find((e) => e.email === "pieter@gmail.com")!;
    expect(pieter).toMatchObject({ name: "Pieter van Wyk", sent: 1, seen: 1, last: "2026-10-20T11:00:00Z" });
    expect(entries.some((e) => e.email === "me@x.test")).toBe(false);
  });

  it("leaves machines out of People, keeps them in Everyone", () => {
    const people = shownContacts(entries, { filter: "people", sort: "frequent", query: "", vip: () => false });
    expect(people.map((e) => e.email)).toEqual(["pieter@gmail.com", "anja@gmail.com"]);
    expect(shownContacts(entries, { filter: "everyone", sort: "frequent", query: "", vip: () => false })).toHaveLength(3);
  });

  it("filters VIPs, searches names and addresses, sorts A to Z", () => {
    expect(shownContacts(entries, { filter: "vip", sort: "frequent", query: "", vip: (e) => e === "anja@gmail.com" }).map((e) => e.email)).toEqual(["anja@gmail.com"]);
    expect(shownContacts(entries, { filter: "everyone", sort: "frequent", query: "wyk", vip: () => false }).map((e) => e.email)).toEqual(["pieter@gmail.com"]);
    expect(shownContacts(entries, { filter: "everyone", sort: "name", query: "", vip: () => false }).map((e) => e.name || e.email)).toEqual(["anja@gmail.com", "Pieter van Wyk", "Uber"]);
  });

  it("files names under their first letter", () => {
    const entry = (name: string): ContactEntry => ({ email: "x@y.z", name, sent: 0, seen: 1, last: "" });
    expect(letterOf(entry("élodie"))).toBe("É");
    expect(letterOf(entry("42 Studio"))).toBe("#");
  });
});
