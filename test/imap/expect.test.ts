import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { stepOf } from "@/lib/automations/expect";
import { INBOX, UNREAD } from "@/lib/mail/mailboxes";
import { NUDGES, type Rule } from "@/lib/rules/spec";
import { createCollection, getCollection } from "@/server/collections";
import { getDb } from "@/server/db";
import { listExpectations, stepDraft, tickExpectations } from "@/server/expectations";
import { buildPack } from "@/server/packs";
import { getPrepared } from "@/server/prepared";
import { createRule, deleteRule, listRuns, runDelayed, undoRuns } from "@/server/rules";
import { runSchedule } from "@/server/schedules";
import { deliver } from "@/server/sync";
import { outgoingFromDraft } from "@/server/drafts";
import { storedThreads, sync, testMailbox, thread, type Mailbox } from "./harness";

// Automations that wait (the expect verb), run on mail you send, run on a schedule, keep one row
// per thing, pack a month for the accountant, and wait before acting. Plain IMAP against the
// test server; mail from others is appended to the Inbox as delivery would.

const box = testMailbox();
const CLIENT = "accounts@acme-build.co.za";
const DAY = 86_400_000;

/** Mail from someone else landing in the Inbox. `inReplyTo`: the Message-ID it answers (with brackets). */
async function arrive(mailbox: Mailbox, m: { id: string; from: string; subject: string; text?: string; inReplyTo?: string; attachment?: { name: string; body: string } }) {
  const head = [
    `From: ${m.from}`,
    `To: Kite Test <${mailbox.server.user}>`,
    `Subject: ${m.subject}`,
    `Message-ID: <${m.id}@test.example>`,
    ...(m.inReplyTo ? [`In-Reply-To: ${m.inReplyTo}`, `References: ${m.inReplyTo}`] : []),
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];
  const text = m.text ?? `${m.subject}.`;
  const raw = m.attachment
    ? [
        ...head,
        'Content-Type: multipart/mixed; boundary="b1"',
        "",
        "--b1",
        "Content-Type: text/plain; charset=utf-8",
        "",
        text,
        "--b1",
        `Content-Type: application/pdf; name="${m.attachment.name}"`,
        `Content-Disposition: attachment; filename="${m.attachment.name}"`,
        "Content-Transfer-Encoding: base64",
        "",
        Buffer.from(m.attachment.body).toString("base64"),
        "--b1--",
        "",
      ]
    : [...head, "Content-Type: text/plain; charset=utf-8", "", text, ""];
  const client = new ImapFlow({ host: "127.0.0.1", port: mailbox.server.imapPort, secure: false, auth: { user: mailbox.server.user, pass: mailbox.server.password }, logger: false });
  client.on("error", () => {});
  await client.connect();
  try {
    await client.append("INBOX", raw.join("\r\n"), []);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** The sync tick's sends and nudges, with the real send path. */
const hooks = (surfaced: string[] = []) => ({
  send: (account: typeof box.account, draft: Parameters<typeof outgoingFromDraft>[1]) => deliver(account, outgoingFromDraft(account, draft), null),
  surface: async (_account: typeof box.account, threadId: string) => void surfaced.push(threadId),
  saveDraft: async () => ({}),
});

const expectationsOf = (ruleId: string) => listExpectations("all").filter((e) => e.ruleId === ruleId);
const overdue = (id: string, days = 1) => getDb().prepare("UPDATE expectations SET due_at = ? WHERE id = ?").run(new Date(Date.now() - days * DAY).toISOString(), id);

describe("automations that wait, send and schedule", () => {
  it("first sync", async () => {
    await sync(box.account);
  });

  describe("Get paid (mail you send, expect an answer)", () => {
    let rule: Rule;
    const invoices = createCollection("Invoices sent");

    it("starts waiting when you send an invoice, reading who it went to", async () => {
      rule = createRule({
        name: "Get paid",
        when: "sent",
        query: "invoice",
        fields: [
          { key: "company", name: "Company", type: "text", from: { kind: "builtin", builtin: "company" } },
          { key: "amount", name: "Amount", type: "money", from: { kind: "after", label: "Total" } },
        ],
        actions: [
          { verb: "collect", collection: invoices.id, match: null },
          { verb: "expect", days: 14, answer: "", askSubject: "", ask: "", nudges: NUDGES.slice(0, 2), every: 7, auto: false },
        ],
      });
      await deliver(box.account, { to: [{ email: CLIENT, name: "Acme Accounts" }], subject: "Invoice INV-7 for October", body: "Hi,\n\nTotal: R 12 500.00\n\nThanks" }, null);
      const [waiting] = expectationsOf(rule.id);
      expect(waiting).toMatchObject({ status: "waiting", who: [{ email: CLIENT, name: "Acme Accounts" }], subject: "Invoice INV-7 for October" });
      expect(stepOf(waiting).kind).toBe("waiting");
      const [row] = getCollection(invoices.id).rows;
      expect(row.values.company?.text).toBe("Acme Build");
      expect(row.values.amount?.number).toBe(12500);
      // Mail that doesn't match the search starts nothing.
      await deliver(box.account, { to: [{ email: CLIENT }], subject: "Lunch on Friday?", body: "Hi" }, null);
      expect(expectationsOf(rule.id)).toHaveLength(1);
    });

    it("when it's overdue, the first nudge waits in the conversation's quick reply and it comes back to the inbox", async () => {
      const [waiting] = expectationsOf(rule.id);
      overdue(waiting.id);
      const surfaced: string[] = [];
      await tickExpectations(hooks(surfaced));
      expect(surfaced).toEqual([waiting.threadId]);
      const prepared = getPrepared(waiting.threadId!);
      expect(prepared?.ruleName).toBe("Get paid");
      expect(prepared?.body).toContain("Hi Acme,");
      expect(stepOf(expectationsOf(rule.id)[0]).kind).toBe("nudge");
      // A second tick doesn't put it there again.
      await tickExpectations(hooks(surfaced));
      expect(surfaced).toHaveLength(1);
      // The nudge is a reply in the conversation, to the client.
      const made = stepDraft(waiting.id)!;
      expect(made.draft.to).toEqual([{ name: "Acme Accounts", email: CLIENT }]);
      expect(made.draft.subject).toBe("Re: Invoice INV-7 for October");
      expect(made.draft.inReplyTo).toBeTruthy();
    });

    it("your nudge counts when it goes; their reply settles it and clears the quick reply", async () => {
      const [waiting] = expectationsOf(rule.id);
      const made = stepDraft(waiting.id)!;
      await deliver(box.account, outgoingFromDraft(box.account, made.draft), null);
      const after = expectationsOf(rule.id)[0];
      expect(after.nudged).toBe(1);
      expect(stepOf(after).kind).toBe("waiting");
      const mine = thread(box.account, "Invoice INV-7 for October").messages[0];
      await arrive(box, { id: "acme-paid", from: `Acme Accounts <${CLIENT}>`, subject: "Re: Invoice INV-7 for October", text: "Paid this morning.", inReplyTo: mine.messageIdHeader });
      await sync(box.account);
      expect(expectationsOf(rule.id)[0]).toMatchObject({ status: "met" });
      expect(getPrepared(waiting.threadId!)).toBeNull();
    });

    it("sends the nudge by itself when the automation is allowed to, once", async () => {
      const auto = createRule({
        name: "Chase quotes",
        when: "sent",
        query: "quote",
        actions: [{ verb: "expect", days: 3, answer: "", askSubject: "", ask: "", nudges: ["Hi {first_name},\n\nAny news on this?"], every: 7, auto: true }],
      });
      await deliver(box.account, { to: [{ email: "sam@buildco.example", name: "Sam Dlamini" }], subject: "Quote for the roof", body: "Here it is." }, null);
      const [waiting] = expectationsOf(auto.id);
      overdue(waiting.id);
      await tickExpectations(hooks());
      await tickExpectations(hooks());
      const sent = thread(box.account, "Quote for the roof").messages.filter((m) => m.from.email === box.account.email);
      expect(sent.map((m) => m.body.join(" "))).toEqual([expect.stringContaining("Here it is"), expect.stringContaining("Hi Sam,")]);
      expect(expectationsOf(auto.id)[0]).toMatchObject({ nudged: 1 });
      deleteRule(auto.id);
    });

    it("Undo of the run that started waiting stops it", async () => {
      const once = createRule({ name: "Wait once", when: "sent", query: "proposal", actions: [{ verb: "expect", days: 5, answer: "", askSubject: "", ask: "", nudges: [], every: 7, auto: false }] });
      await deliver(box.account, { to: [{ email: CLIENT }], subject: "Proposal", body: "Attached." }, null);
      expect(expectationsOf(once.id)).toHaveLength(1);
      await undoRuns(listRuns().filter((r) => r.ruleId === once.id).map((r) => r.id));
      expect(expectationsOf(once.id)).toHaveLength(0);
      deleteRule(once.id);
    });
  });

  describe("Client documents (a schedule that asks each person)", () => {
    it("asks everyone on its day, and each one's email settles their own", async () => {
      const people = ["thandi@mokoena.example", "pieter@vanwyk.example"];
      const rule = createRule({
        name: "Client documents",
        when: "schedule",
        schedule: { every: "month", day: 1, time: "09:00" },
        conditions: [{ kind: "senders", emails: people, negate: false }],
        actions: [{ verb: "expect", days: 7, answer: "", askSubject: "Documents for {period}", ask: "Hi {first_name},\n\nYour statements for {period}, please.", nudges: [NUDGES[0]], every: 4, auto: false }],
      });
      const at = new Date(2026, 9, 1, 9, 0);
      const result = await runSchedule(rule, at, hooks(), new Date());
      expect(result.waiting).toBe(2);
      // The same occurrence again asks nobody twice.
      expect((await runSchedule(rule, at, hooks(), new Date())).waiting).toBe(0);
      const list = expectationsOf(rule.id);
      expect(list.map((e) => e.subject)).toEqual(["Documents for September 2026", "Documents for September 2026"]);
      expect(list.every((e) => stepOf(e).kind === "ask")).toBe(true);

      // The request goes (as the user's Send does), and counts as asked.
      const thandi = list.find((e) => e.who[0].email === people[0])!;
      const made = stepDraft(thandi.id)!;
      expect(made.draft.subject).toBe("Documents for September 2026");
      expect(made.draft.body).toContain("for September 2026");
      await deliver(box.account, outgoingFromDraft(box.account, made.draft), null);
      expect(expectationsOf(rule.id).find((e) => e.id === thandi.id)).toMatchObject({ status: "waiting" });
      expect(expectationsOf(rule.id).find((e) => e.id === thandi.id)!.askedAt).toBeTruthy();

      // Her statements arrive in a new email: hers is in, Pieter's still waits.
      await arrive(box, { id: "thandi-docs", from: `Thandi Mokoena <${people[0]}>`, subject: "September statements", text: "Here you go." });
      await sync(box.account);
      const after = expectationsOf(rule.id);
      expect(after.find((e) => e.who[0].email === people[0])?.status).toBe("met");
      expect(after.find((e) => e.who[0].email === people[1])?.status).toBe("waiting");
      deleteRule(rule.id);
    });
  });

  describe("One row per thing", () => {
    it("a reply from the same company updates its row; Undo puts it back", async () => {
      const applications = createCollection("Applications");
      const applied = createRule({
        name: "Job applications",
        when: "sent",
        query: "subject:application OR subject:applying",
        fields: [
          { key: "company", name: "Company", type: "text", from: { kind: "builtin", builtin: "company" } },
          { key: "status", name: "Status", type: "text", from: { kind: "fixed", value: "Applied" } },
        ],
        actions: [{ verb: "collect", collection: applications.id, match: "company" }],
      });
      const replies = createRule({
        name: "Job replies",
        query: "application",
        fields: [
          { key: "company", name: "Company", type: "text", from: { kind: "builtin", builtin: "company" } },
          { key: "status", name: "Status", type: "text", from: { kind: "fixed", value: "Rejected" } },
        ],
        actions: [{ verb: "collect", collection: applications.id, match: "company" }],
      });
      await deliver(box.account, { to: [{ email: "jobs@globex.example" }], subject: "Application: Designer", body: "CV attached." }, null);
      await deliver(box.account, { to: [{ email: "careers@initech.example" }], subject: "Applying for the analyst role", body: "Hello." }, null);
      expect(getCollection(applications.id).rows.map((r) => [r.values.company?.text, r.values.status?.text]).sort()).toEqual([
        ["Globex", "Applied"],
        ["Initech", "Applied"],
      ]);
      await arrive(box, { id: "globex-no", from: "Globex Talent <talent@globex.example>", subject: "Your application", text: "Unfortunately we won't be going ahead." });
      await sync(box.account);
      const rows = getCollection(applications.id).rows;
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.values.company?.text === "Globex")?.values.status?.text).toBe("Rejected");
      await undoRuns(listRuns().filter((r) => r.ruleId === replies.id).map((r) => r.id));
      expect(getCollection(applications.id).rows.find((r) => r.values.company?.text === "Globex")?.values.status?.text).toBe("Applied");
      deleteRule(applied.id);
      deleteRule(replies.id);
    });
  });

  describe("Month-end pack", () => {
    it("attaches every file, lists emails that only had a link", async () => {
      const receipts = createCollection("Receipts");
      const rule = createRule({
        name: "Receipts",
        conditions: [{ kind: "senders", emails: ["billing@supplier.example", "noreply@portal.example"], negate: false }],
        fields: [
          { key: "total", name: "Total", type: "money", from: { kind: "after", label: "Total" } },
          { key: "link", name: "Download", type: "link", from: { kind: "first" } },
        ],
        actions: [{ verb: "collect", collection: receipts.id, match: null }],
      });
      await arrive(box, { id: "rcpt-1", from: "Supplier <billing@supplier.example>", subject: "Your receipt", text: "Total: R 349.00", attachment: { name: "receipt.pdf", body: "%PDF-1.4 receipt" } });
      await arrive(box, { id: "rcpt-2", from: "Portal <noreply@portal.example>", subject: "Your invoice is ready", text: "Total: R 99.00\nDownload it at https://portal.example/inv/22" });
      await sync(box.account);
      expect(getCollection(receipts.id).rows).toHaveLength(2);
      const now = new Date();
      const { draft, summary } = buildPack({
        collectionId: receipts.id,
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
        periodName: "this month",
        to: "accountant@example.com",
        subject: "{collection} for {period}",
      });
      expect(summary).toMatchObject({ rows: 2, files: 1, links: 1, missing: 0 });
      expect(draft.subject).toBe("Receipts for this month");
      expect(draft.to).toEqual([{ email: "accountant@example.com" }]);
      expect(draft.attachments.map((a) => a.name)).toEqual(["receipt.pdf"]);
      expect(draft.body).toContain("[download](https://portal.example/inv/22)");
      deleteRule(rule.id);
    });
  });

  describe("Wait before acting", () => {
    it("leaves the alert in the inbox until the wait is over, then files it", async () => {
      const rule = createRule({ name: "Alerts later", delay: 60, query: "from:monitor.example", actions: [{ verb: "archive" }, { verb: "notify", mode: "now" }] });
      await arrive(box, { id: "alert-1", from: "Monitor <alerts@monitor.example>", subject: "Disk 91% full" });
      await sync(box.account);
      expect(thread(box.account, "Disk 91% full").rowLabels).toEqual(expect.arrayContaining([INBOX, UNREAD]));
      getDb().prepare("UPDATE rule_delays SET run_at = ? WHERE rule_id = ?").run(new Date(Date.now() - 1000).toISOString(), rule.id);
      expect(await runDelayed()).toEqual([box.account.id]);
      expect(thread(box.account, "Disk 91% full").rowLabels).not.toContain(INBOX);
      expect(listRuns().filter((r) => r.ruleId === rule.id).map((r) => r.done)).toEqual([["archived"]]);
      // Nothing waits any more.
      expect(await runDelayed()).toEqual([]);
      deleteRule(rule.id);
      expect(storedThreads(box.account).length).toBeGreaterThan(0);
    });
  });
});
