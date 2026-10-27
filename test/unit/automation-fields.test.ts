import { describe, expect, it } from "vitest";
import { blankValues, checkHolds, keyFor, readField, readFields, type EmailFacts, type FieldSpec } from "@/lib/automations/fields";

const bill: EmailFacts = {
  senderName: "Vodacom",
  senderEmail: "billing@vodacom.co.za",
  subject: "Your October bill is ready",
  date: "2026-10-20T08:00:00.000Z",
  text: "Hi Mark,\n\nAccount number: 4410 2231\nAmount due: R 349.00\nDue date: 3 November 2026\n\nView it at https://my.vodacom.co.za/bill/123\n",
};
const field = (key: string, type: FieldSpec["type"], from: FieldSpec["from"]): FieldSpec => ({ key, name: key, type, from });

describe("readField", () => {
  it("reads what every email has", () => {
    expect(readField(field("who", "text", { kind: "builtin", builtin: "sender_name" }), bill)?.text).toBe("Vodacom");
    expect(readField(field("when", "date", { kind: "builtin", builtin: "received" }), bill)?.date).toBe(bill.date);
  });

  it("reads the value after a label, typed", () => {
    const amount = readField(field("amount", "money", { kind: "after", label: "Amount due" }), bill);
    expect(amount).toMatchObject({ number: 349 });
    const due = readField(field("due", "date", { kind: "after", label: "Due date:" }), bill);
    expect(due?.date && new Date(due.date).getDate()).toBe(3);
    expect(due?.text).toBe("3 Nov 2026");
    expect(readField(field("acct", "text", { kind: "after", label: "Account number" }), bill)?.text).toBe("4410 2231");
  });

  it("reads the first value of a type, and a pattern", () => {
    expect(readField(field("link", "link", { kind: "first" }), bill)?.text).toBe("https://my.vodacom.co.za/bill/123");
    expect(readField(field("n", "text", { kind: "pattern", pattern: "bill/(\\d+)" }), bill)?.text).toBe("123");
    expect(readField(field("x", "money", { kind: "after", label: "Nothing like this" }), bill)).toBeNull();
  });
});

describe("checks and blanks", () => {
  const values = readFields(
    [field("amount", "money", { kind: "after", label: "Amount due" }), field("due", "date", { kind: "after", label: "Due date" })],
    bill,
  );

  it("compares amounts and dates", () => {
    expect(checkHolds({ field: "amount", op: "more", value: "300" }, values)).toBe(true);
    expect(checkHolds({ field: "amount", op: "less", value: "300" }, values)).toBe(false);
    const now = Date.parse("2026-10-30T00:00:00Z");
    expect(checkHolds({ field: "due", op: "within_days", value: "7" }, values, now)).toBe(true);
    expect(checkHolds({ field: "due", op: "within_days", value: "1" }, values, now)).toBe(false);
    expect(checkHolds({ field: "missing_field", op: "missing", value: "" }, values)).toBe(true);
  });

  it("turns values into blanks and names into keys", () => {
    expect(blankValues(values).amount).toBe("R 349.00");
    expect(keyFor("Due date")).toBe("due_date");
    expect(keyFor("Due date", ["due_date"])).toBe("due_date_2");
  });
});
