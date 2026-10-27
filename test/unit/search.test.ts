import { describe, expect, it } from "vitest";
import { contactToken, matchesSearch, parseSearch, toGmailQuery, type MatchFacts } from "@/lib/mail/search";
import type { Message, Thread } from "@/lib/mail/types";

const NOW = new Date(2026, 9, 16, 12, 0, 0);

describe("parseSearch", () => {
  it("splits operators, words and phrases, lower-cased", () => {
    expect(parseSearch('from:Thandi "Q3 Numbers" invoice', NOW)).toEqual([
      { field: "from", value: "thandi", negate: false },
      { field: "text", value: "q3 numbers", negate: false, phrase: true },
      { field: "text", value: "invoice", negate: false, phrase: undefined },
    ]);
  });

  it("negates with a leading dash", () => {
    expect(parseSearch("-from:digest -newsletter", NOW)).toEqual([
      { field: "from", value: "digest", negate: true },
      { field: "text", value: "newsletter", negate: true, phrase: undefined },
    ]);
  });

  it("reads quoted and hyphenated label names", () => {
    expect(parseSearch('label:"Align – Discovery Bank Ltd"', NOW)).toEqual([{ field: "label", value: "align – discovery bank ltd", negate: false }]);
    expect(parseSearch("label:work-clients label:Work/Clients", NOW)).toEqual([
      { field: "label", value: "work-clients", negate: false },
      { field: "label", value: "work/clients", negate: false },
    ]);
  });

  it("treats label:<mailbox> as in: and in:starred as is:", () => {
    expect(parseSearch("label:inbox in:starred", NOW)).toEqual([
      { field: "in", value: "inbox", negate: false },
      { field: "is", value: "starred", negate: false },
    ]);
  });

  it("aliases cc, older and newer", () => {
    expect(parseSearch("cc:lerato", NOW)[0]).toEqual({ field: "to", value: "lerato", negate: false });
    expect(parseSearch("older:2026/01/31", NOW)[0].field).toBe("before");
    expect(parseSearch("newer:2026/01/31", NOW)[0].field).toBe("after");
  });

  it("reads dates as the start of that local day", () => {
    expect(parseSearch("after:2026/01/31", NOW)[0].value).toBe(new Date(2026, 0, 31).toISOString());
    expect(parseSearch("before:2026-2-3", NOW)[0].value).toBe(new Date(2026, 1, 3).toISOString());
  });

  it("reads newer_than / older_than from now", () => {
    expect(parseSearch("newer_than:7d", NOW)[0]).toEqual({ field: "after", value: new Date(2026, 9, 9, 12).toISOString(), negate: false });
    expect(parseSearch("older_than:2w", NOW)[0]).toEqual({ field: "before", value: new Date(2026, 9, 2, 12).toISOString(), negate: false });
    expect(parseSearch("newer_than:1y", NOW)[0].value).toBe(new Date(2025, 9, 16, 12).toISOString());
  });

  it("searches unknown operators and bad values as text", () => {
    expect(parseSearch("deliveredto:me is:everything after:someday", NOW)).toEqual([
      { field: "text", value: "deliveredto:me", negate: false },
      { field: "text", value: "is:everything", negate: false },
      { field: "text", value: "after:someday", negate: false },
    ]);
  });

  it("has: accepts attachment, attachments and files only", () => {
    expect(parseSearch("has:files", NOW)[0]).toEqual({ field: "has", value: "attachment", negate: false });
    expect(parseSearch("has:drive", NOW)[0].field).toBe("text");
  });

  it("skips empty pieces", () => {
    expect(parseSearch('  ""  ', NOW)).toEqual([]);
    expect(parseSearch("", NOW)).toEqual([]);
  });
});

describe("toGmailQuery", () => {
  const q = (query: string) => toGmailQuery(parseSearch(query, NOW));

  it("keeps plain operators and words", () => {
    expect(q("from:thandi subject:invoice is:unread")).toBe("from:thandi subject:invoice is:unread");
  });

  it("quotes values with spaces and phrases", () => {
    expect(q('label:"Align – Discovery Bank Ltd" "q3 numbers"')).toBe('label:"align – discovery bank ltd" "q3 numbers"');
  });

  it("keeps hyphenated labels as one token", () => {
    expect(q("label:work-clients -label:receipts")).toBe("label:work-clients -label:receipts");
  });

  it("writes Kite's in:archive as out of the Inbox", () => {
    expect(q("in:archive")).toBe("-in:inbox -in:drafts -in:sent");
    expect(q("-in:archive")).toBe("in:inbox");
    expect(q("in:anywhere -in:spam")).toBe("in:anywhere -in:spam");
  });

  it("writes is:snoozed as in:snoozed and dates as y/m/d", () => {
    expect(q("is:snoozed")).toBe("in:snoozed");
    expect(q("after:2026/01/31 before:2026/02/03")).toBe("after:2026/1/31 before:2026/2/3");
  });
});

const message = (over: Partial<Message> = {}): Message => ({
  id: "m1",
  from: { name: "Thandi Nkosi", email: "thandi@company.co.za" },
  to: [{ name: "Kite", email: "kite@example.test" }],
  date: "2026-10-15T10:00:00.000Z",
  body: ["Hi, the Q3 numbers are attached."],
  ...over,
});

const thread = (over: Partial<Thread> = {}): Thread => ({
  id: "a:t1",
  accountId: "a",
  subject: "Quarterly numbers",
  messages: [message()],
  mailbox: "inbox",
  category: "important",
  unread: true,
  starred: false,
  ...over,
});

describe("matchesSearch", () => {
  const match = (t: Thread, query: string, facts?: MatchFacts) => matchesSearch(t, parseSearch(query, NOW), facts);

  it("matches words in the subject, body and people", () => {
    expect(match(thread(), "quarterly")).toBe(true);
    expect(match(thread(), "attached")).toBe(true);
    expect(match(thread(), "nkosi")).toBe(true);
    expect(match(thread(), "forecast")).toBe(false);
  });

  it("negation flips a term", () => {
    expect(match(thread(), "-from:thandi")).toBe(false);
    expect(match(thread(), "-from:lerato quarterly")).toBe(true);
  });

  it("finds files by name and has:attachment", () => {
    const withFile = thread({ messages: [message({ attachments: [{ name: "q3.pdf", size: "1 KB", kind: "pdf" }] })] });
    expect(match(withFile, "filename:q3 has:attachment")).toBe(true);
    expect(match(thread(), "has:attachment")).toBe(false);
    const inlineOnly = thread({ messages: [message({ attachments: [{ name: "logo.gif", size: "1 KB", kind: "image", inline: true }] })] });
    expect(match(inlineOnly, "has:attachment")).toBe(false);
  });

  it("reads is: and in: from the view without facts", () => {
    expect(match(thread(), "is:unread in:inbox")).toBe(true);
    expect(match(thread({ mailbox: "archive" }), "in:inbox")).toBe(false);
  });

  it("reads is: and in: from the labels with facts", () => {
    const facts = (labels: string[], labelNames: string[] = []): MatchFacts => ({ labels, labelNames });
    expect(match(thread(), "is:starred", facts(["INBOX", "STARRED"]))).toBe(true);
    expect(match(thread(), "is:read", facts(["INBOX", "UNREAD"]))).toBe(false);
    expect(match(thread(), "in:archive", facts(["SENT"]))).toBe(true);
    expect(match(thread(), "in:archive", facts(["INBOX"]))).toBe(false);
    expect(match(thread(), "in:archive", facts(["DRAFT"]))).toBe(false);
    expect(match(thread(), "in:trash", facts(["TRASH"]))).toBe(true);
  });

  it("matches label names quoted or hyphenated, any case", () => {
    const facts: MatchFacts = { labels: ["INBOX", "g-x"], labelNames: ["Align – Discovery Bank Ltd", "Work/Clients"] };
    expect(match(thread(), 'label:"Align – Discovery Bank Ltd"', facts)).toBe(true);
    expect(match(thread(), "label:align-–-discovery-bank-ltd", facts)).toBe(true);
    expect(match(thread(), "label:work-clients", facts)).toBe(true);
    expect(match(thread(), "label:work/clients", facts)).toBe(true);
    expect(match(thread(), "label:work", facts)).toBe(false);
  });

  it("compares dates with the last message", () => {
    expect(match(thread(), "after:2026/10/15")).toBe(true);
    expect(match(thread(), "before:2026/10/15")).toBe(false);
  });
});

describe("contactToken", () => {
  it("finds the from: or to: term at the caret", () => {
    expect(contactToken("from:tha", 8)).toEqual({ role: "from", value: "tha", start: 5, end: 8 });
    expect(contactToken("invoice to:", 11)).toEqual({ role: "to", value: "", start: 11, end: 11 });
    expect(contactToken("is:unread -FROM:digest", 22)).toEqual({ role: "from", value: "digest", start: 16, end: 22 });
  });

  it("covers the whole value when the caret is inside it", () => {
    expect(contactToken("from:thandi invoice", 7)).toEqual({ role: "from", value: "th", start: 5, end: 11 });
  });

  it("ignores other operators, words and quoted values", () => {
    expect(contactToken("subject:from", 12)).toBeNull();
    expect(contactToken("from:thandi invoice", 19)).toBeNull();
    expect(contactToken('from:"Thandi', 12)).toBeNull();
    expect(contactToken("refrom:x", 8)).toBeNull();
  });
});
