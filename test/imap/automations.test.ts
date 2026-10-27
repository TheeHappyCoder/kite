import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { getCollection, createCollection } from "@/server/collections";
import { getDb } from "@/server/db";
import { listEvents } from "@/server/events";
import { createRule, listRuns, previewRule, runOnExisting, undoRuns } from "@/server/rules";
import { sync, testMailbox, thread, type Mailbox } from "./harness";

// Automations: an automation reads values from arriving mail (Read), checks them (Check) and uses
// them in its steps: a collection row, a reminder (a snooze until a date the email names) and an
// event on Kite's own calendar. Undo takes all three back. Plain IMAP against the test server.

const box = testMailbox();

/** A bill arriving in the Inbox, due `due` days from now. */
async function bill(mailbox: Mailbox, { id, amount, due }: { id: string; amount: string; due: number }) {
  const date = new Date(Date.now() + due * 86_400_000);
  const dueText = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  const raw = [
    "From: Vodacom Billing <billing@vodacom.example>",
    `To: Kite Test <${mailbox.server.user}>`,
    `Subject: Your bill ${id} is ready`,
    `Message-ID: <${id}@test.example>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Hi there,",
    "",
    `Amount due: ${amount}`,
    `Due date: ${dueText}`,
    "",
  ].join("\r\n");
  const client = new ImapFlow({ host: "127.0.0.1", port: mailbox.server.imapPort, secure: false, auth: { user: mailbox.server.user, pass: mailbox.server.password }, logger: false });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.append("INBOX", raw, []);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

const snoozed = (threadId: string) => {
  const key = threadId.slice(box.account.id.length + 1);
  return getDb().prepare("SELECT until FROM snoozes WHERE account_id = ? AND thread_id = ?").get(box.account.id, key) as { until: string } | undefined;
};

describe("automations", () => {
  const bills = createCollection("Bills");
  const automation = () =>
    createRule({
      name: "Bills",
      query: "from:vodacom.example",
      fields: [
        { key: "amount", name: "Amount", type: "money", from: { kind: "after", label: "Amount due" } },
        { key: "due", name: "Due date", type: "date", from: { kind: "after", label: "Due date" } },
      ],
      checks: [{ field: "amount", op: "more", value: "100" }],
      actions: [
        { verb: "collect", collection: bills.id },
        { verb: "remind", field: "due", daysBefore: 2, time: "09:00" },
        { verb: "calendar", field: "due", title: "Pay Vodacom {amount}" },
      ],
    });

  it("first sync", async () => {
    await sync(box.account);
  });

  it("reads, checks and acts on new mail; Undo takes it all back", async () => {
    const rule = automation();
    await bill(box, { id: "bill-1", amount: "R 349.00", due: 10 });
    await bill(box, { id: "bill-2", amount: "R 49.00", due: 10 });
    await sync(box.account);

    // Only the bill over R 100 passed the check.
    const rows = getCollection(bills.id).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].values.amount).toMatchObject({ number: 349 });
    expect(rows[0].columns.map((c) => c.key)).toEqual(["amount", "due"]);

    const first = thread(box.account, "Your bill bill-1 is ready");
    const until = snoozed(first.id)?.until;
    expect(until).toBeTruthy();
    const days = (Date.parse(until!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.5);
    expect(days).toBeLessThan(8.5);
    expect(snoozed(thread(box.account, "Your bill bill-2 is ready").id)).toBeUndefined();

    const soon = listEvents([box.account.id], new Date().toISOString(), new Date(Date.now() + 30 * 86_400_000).toISOString());
    expect(soon.map((e) => e.summary)).toContain("Pay Vodacom R 349.00");

    const runs = listRuns().filter((r) => r.ruleId === rule.id);
    expect(runs).toHaveLength(1);
    await undoRuns(runs.map((r) => r.id));
    expect(getCollection(bills.id).rows).toHaveLength(0);
    expect(snoozed(first.id)).toBeUndefined();
    expect(listEvents([box.account.id], new Date().toISOString(), new Date(Date.now() + 30 * 86_400_000).toISOString()).map((e) => e.summary)).not.toContain("Pay Vodacom R 349.00");
  });

  it("previews what it reads, and runs on existing mail with the same checks", async () => {
    const rule = createRule({
      name: "Big bills",
      query: "from:vodacom.example",
      fields: [{ key: "amount", name: "Amount", type: "money", from: { kind: "after", label: "Amount due" } }],
      checks: [{ field: "amount", op: "less", value: "100" }],
      actions: [{ verb: "collect", collection: bills.id }],
    });
    const preview = previewRule({ ...rule });
    expect(preview.count).toBe(1);
    expect(preview.samples[0].values.amount?.number).toBe(49);
    const { changed } = await runOnExisting(rule.id);
    expect(changed).toBe(1);
    expect(getCollection(bills.id).rows.map((r) => r.values.amount?.number)).toEqual([49]);
  });

  it("keeps to the senders it was built for", async () => {
    const elsewhere = createCollection("Only Vodacom");
    const rule = createRule({
      name: "Only Vodacom",
      query: "",
      conditions: [{ kind: "senders", emails: ["billing@vodacom.example"], negate: false }],
      fields: [{ key: "amount", name: "Amount", type: "money", from: { kind: "after", label: "Amount due" } }],
      actions: [{ verb: "collect", collection: elsewhere.id }],
    });
    expect(previewRule({ ...rule }).count).toBe(2);
    await runOnExisting(rule.id);
    expect(getCollection(elsewhere.id).rows.map((r) => r.values.amount?.number).sort()).toEqual([349, 49].sort());
    const other = createRule({ ...rule, name: "Nobody", conditions: [{ kind: "senders", emails: ["nobody@example.test"], negate: false }] });
    expect(previewRule({ ...other }).count).toBe(0);
  });
});
