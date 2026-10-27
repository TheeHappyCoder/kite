import { describe, expect, it } from "vitest";
import { readField, type EmailFacts } from "@/lib/automations/fields";
import { fieldFromPick, fieldFromSelection, pickables } from "@/lib/automations/pick";

const text = "Hi Mark,\n\nCard purchase at Woolworths Cape Quarter\nAmount: R 842.50\nDue date: 3 November 2026\nTotal\nR 1,200.00\nTrack it: https://track.example.com/abc\n";
const email: EmailFacts = { senderName: "Bank", senderEmail: "alerts@bank.example", subject: "Card purchase", date: "2026-10-20T08:00:00.000Z", text };

describe("pickables", () => {
  const picks = pickables(text);

  it("finds amounts, dates, links with the words in front of them", () => {
    const amount = picks.find((p) => p.text.includes("842.50"))!;
    expect(amount).toMatchObject({ type: "money", label: "Amount:" });
    const due = picks.find((p) => p.type === "date")!;
    expect(due.text).toBe("3 November 2026");
    expect(due.label).toBe("Due date:");
    expect(picks.find((p) => p.type === "link")?.label).toBe("Track it:");
    // A value on its own line takes the short line above as its words.
    expect(picks.find((p) => p.text.includes("1,200.00"))?.label).toBe("Total");
  });

  it("makes fields that read the same value back", () => {
    const amount = picks.find((p) => p.text.includes("842.50"))!;
    const field = fieldFromPick(amount, []);
    expect(field).toMatchObject({ key: "amount", name: "Amount", type: "money", from: { kind: "after", label: "Amount:" } });
    expect(readField(field, email)?.number).toBe(842.5);
    const due = fieldFromPick(picks.find((p) => p.type === "date")!, ["amount"]);
    expect(new Date(readField(due, email)!.date!).getDate()).toBe(3);
  });

  it("reads selected text after the words before it", () => {
    const shop = fieldFromSelection(text, "Woolworths Cape Quarter", [], "Shop")!;
    expect(shop).toMatchObject({ key: "shop", type: "text", from: { kind: "after", label: "Card purchase at" } });
    expect(readField(shop, email)?.text).toBe("Woolworths Cape Quarter");
  });
});
