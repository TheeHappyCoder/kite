import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { INBOX, SENT, STARRED, UNREAD } from "@/lib/mail/mailboxes";
import { getDb } from "@/server/db";
import { listStoredLabels } from "@/server/labels";
import { keywordId } from "@/server/providers/imap/folders";
import { createRule, deleteRule, listRuns, runOnExisting, undoRuns } from "@/server/rules";
import { cancelScheduled, scheduleMessage } from "@/server/scheduled";
import { deliver, holdMessage, runLabelChange, runOp, undoMove } from "@/server/sync";
import { keyOf, serverCopies, storedThreads, sync, thread, testMailbox, type Mailbox } from "./harness";

// What Kite does by itself: rules on arriving mail (with the activity log and Undo), sending now,
// later and with Undo send, follow-up nudges, and the way back from folder moves. Plain IMAP.

const box = testMailbox();
const FOLDERS = ["INBOX", "Sent", "Archive", "Receipts"];
const THANDI = "thandi@company.co.za";

const copies = async (id: string) => (await serverCopies(box, FOLDERS)).get(id) ?? [];
const sentWith = (subject: string) => storedThreads(box.account).filter((t) => t.subject === subject);

/** New mail from someone else, the way it lands in the Inbox (straight into INBOX, as delivery does). */
async function arrive(mailbox: Mailbox, { id, subject, from = `Thandi Nkosi <${THANDI}>` }: { id: string; subject: string; from?: string }) {
  const raw = [
    `From: ${from}`,
    `To: Kite Test <${mailbox.server.user}>`,
    `Subject: ${subject}`,
    `Message-ID: <${id}@test.example>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `${subject}, please.`,
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

const scheduledStatus = (id: string) => (getDb().prepare("SELECT status FROM scheduled WHERE id = ?").get(id) as { status: string }).status;

describe("rules, sending and undo", () => {
  it("first sync", async () => {
    await sync(box.account);
    expect(thread(box.account, "Quarterly numbers").messages).toHaveLength(3);
  });

  describe("marking unread", () => {
    it("marks only the newest message from someone else, never your own reply", async () => {
      const key = keyOf(box.account, thread(box.account, "Quarterly numbers"));
      await runOp(box.account, key, "read");
      await runOp(box.account, key, "unread");
      const local = thread(box.account, "Quarterly numbers").messages;
      expect(local.filter((m) => m.unread).map((m) => m.from.email)).toEqual([THANDI]);
      expect(local.find((m) => m.labels?.includes(SENT))?.unread).toBeFalsy();
      await sync(box.account);
      expect((await copies("q3-3"))[0].flags).not.toContain("\\Seen");
      expect((await copies("q3-2"))[0].flags).toContain("\\Seen");
      expect((await copies("q3-1"))[0].flags).toContain("\\Seen");
    });

    it("unarchive doesn't file your own sent reply in the Inbox locally", async () => {
      const key = keyOf(box.account, thread(box.account, "Quarterly numbers"));
      await runOp(box.account, key, "archive");
      await runOp(box.account, key, "unarchive");
      const local = thread(box.account, "Quarterly numbers").messages;
      expect(local.find((m) => m.labels?.includes(SENT))?.labels).not.toContain(INBOX);
      expect(local.filter((m) => !m.labels?.includes(SENT)).every((m) => m.labels?.includes(INBOX))).toBe(true);
    });
  });

  describe("rules on arriving mail", () => {
    it("run on new mail, log the run, and Undo puts everything back", async () => {
      const rule = createRule({ name: "Rule test", query: 'subject:"Rule test"', actions: [{ verb: "star" }, { verb: "mark_read" }, { verb: "label", label: "Invoices" }] });
      await arrive(box, { id: "rule-1", subject: "Rule test one" });
      await sync(box.account);

      const t = thread(box.account, "Rule test one");
      expect(t.rowLabels).toEqual(expect.arrayContaining([STARRED, keywordId("$Invoices")]));
      expect(t.rowLabels).not.toContain(UNREAD);
      const [copy] = await copies("rule-1");
      expect(copy.flags).toEqual(expect.arrayContaining(["\\Flagged", "\\Seen", "$Invoices"]));

      const run = listRuns().find((r) => r.ruleId === rule.id && r.threadId === t.id);
      expect(run?.trigger).toBe("new");
      expect(run?.undoable).toBe(true);

      await undoRuns([run!.id]);
      await sync(box.account);
      const [back] = await copies("rule-1");
      expect(back.flags).not.toContain("\\Flagged");
      expect(back.flags).not.toContain("\\Seen");
      expect(back.flags).not.toContain("$Invoices");
      expect(listRuns().find((r) => r.id === run!.id)?.undoneAt).toBeTruthy();
      deleteRule(rule.id);
    });

    it("don't touch mail that doesn't match", async () => {
      const rule = createRule({ name: "Only invoices", query: 'subject:"Invoice INV-9"', actions: [{ verb: "star" }] });
      await arrive(box, { id: "nomatch-1", subject: "Something else" });
      await sync(box.account);
      expect(thread(box.account, "Something else").rowLabels).not.toContain(STARRED);
      expect(listRuns().some((r) => r.ruleId === rule.id)).toBe(false);
      deleteRule(rule.id);
    });

    it("Stop here keeps the rules below off that mail", async () => {
      const first = createRule({ name: "First", query: 'subject:"Stop test"', actions: [{ verb: "star" }], stop: true });
      const second = createRule({ name: "Second", query: 'subject:"Stop test"', actions: [{ verb: "mark_read" }] });
      await arrive(box, { id: "stop-1", subject: "Stop test" });
      await sync(box.account);
      const t = thread(box.account, "Stop test");
      expect(t.rowLabels).toContain(STARRED);
      expect(t.rowLabels).toContain(UNREAD);
      expect(listRuns().some((r) => r.ruleId === second.id)).toBe(false);
      deleteRule(first.id);
      deleteRule(second.id);
    });

    it("Run on existing mail changes matching conversations as one batch, and Undo reverses it", async () => {
      const rule = createRule({ name: "Digest", query: 'subject:"Your weekly digest"', actions: [{ verb: "star" }] });
      expect(thread(box.account, "Your weekly digest").rowLabels).not.toContain(STARRED);
      const { batchId, changed } = await runOnExisting(rule.id);
      expect(changed).toBe(1);
      expect(thread(box.account, "Your weekly digest").rowLabels).toContain(STARRED);
      const runs = listRuns().filter((r) => r.batchId === batchId);
      expect(runs.map((r) => r.trigger)).toEqual(["existing"]);
      await undoRuns(runs.map((r) => r.id));
      await sync(box.account);
      expect((await copies("digest-1"))[0].flags).not.toContain("\\Flagged");
      deleteRule(rule.id);
    });
  });

  describe("sending", () => {
    it("sends now: the copy lands in Sent and the conversation is stored", async () => {
      await deliver(box.account, { to: [{ email: THANDI }], subject: "Sent now", body: "Hello **there**." }, null);
      await sync(box.account);
      const [t] = sentWith("Sent now");
      expect(t.rowLabels).toContain(SENT);
      const folders = [...(await serverCopies(box, FOLDERS)).values()].flat().filter((c) => c.subject === "Sent now").map((c) => c.folder);
      expect(folders).toContain("Sent");
    });

    it("sends a scheduled message once it's due, and never a cancelled one", async () => {
      const due = scheduleMessage(box.account.id, { to: [{ email: THANDI }], subject: "Sent later", body: "Later." }, new Date(Date.now() - 1000).toISOString(), null);
      const cancelled = scheduleMessage(box.account.id, { to: [{ email: THANDI }], subject: "Never sent", body: "No." }, new Date(Date.now() - 1000).toISOString(), null);
      const future = scheduleMessage(box.account.id, { to: [{ email: THANDI }], subject: "Not yet", body: "Soon." }, new Date(Date.now() + 3_600_000).toISOString(), null);
      expect(cancelScheduled(cancelled)).toBe(true);
      await sync(box.account);
      expect(scheduledStatus(due)).toBe("sent");
      expect(scheduledStatus(cancelled)).toBe("cancelled");
      expect(scheduledStatus(future)).toBe("pending");
      expect(sentWith("Sent later")).toHaveLength(1);
      expect(sentWith("Never sent")).toHaveLength(0);
      expect(sentWith("Not yet")).toHaveLength(0);
      // A second pass doesn't send it again.
      await sync(box.account);
      expect([...(await serverCopies(box, ["Sent"])).values()].flat().filter((c) => c.subject === "Sent later")).toHaveLength(1);
      cancelScheduled(future);
    });

    it("Undo send: a held message goes by itself after the wait, unless it's cancelled first", async () => {
      const sent = holdMessage(box.account, { to: [{ email: THANDI }], subject: "Held then sent", body: "Go." }, 0.2, null);
      const undone = holdMessage(box.account, { to: [{ email: THANDI }], subject: "Held then undone", body: "Stop." }, 0.4, null);
      expect(cancelScheduled(undone.id)).toBe(true);
      await expect.poll(() => scheduledStatus(sent.id), { timeout: 10_000 }).toBe("sent");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(scheduledStatus(undone.id)).toBe("cancelled");
      await sync(box.account);
      expect(sentWith("Held then sent")).toHaveLength(1);
      expect(sentWith("Held then undone")).toHaveLength(0);
    });

    it("a follow-up with no reply brings the conversation back to the Inbox, unread", async () => {
      const sent = await deliver(box.account, { to: [{ email: THANDI }], subject: "Nudge me", body: "Any news?" }, 3);
      const row = getDb().prepare("SELECT id FROM followups WHERE thread_remote_id = ?").get(sent.threadId) as { id: string };
      getDb().prepare("UPDATE followups SET due_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), row.id);
      await sync(box.account);
      expect((getDb().prepare("SELECT status FROM followups WHERE id = ?").get(row.id) as { status: string }).status).toBe("nudged");
      const [t] = sentWith("Nudge me");
      expect(t.rowLabels).toEqual(expect.arrayContaining([INBOX, UNREAD]));
    });
  });

  it("folder-move Undo is kept in the database, so it survives a restart", async () => {
    const receipts = listStoredLabels(box.account.id).find((l) => l.name === "Receipts")!;
    const key = keyOf(box.account, thread(box.account, "Something else"));
    const { undo } = await runLabelChange([{ account: box.account, key }], [receipts.id], []);
    expect(undo).toBeTruthy();
    expect(getDb().prepare("SELECT kind FROM undos WHERE id = ?").get(undo!)).toEqual(expect.objectContaining({ kind: "move" }));
    expect((await copies("nomatch-1")).map((c) => c.folder)).toEqual(["Receipts"]);
    await undoMove(undo!);
    expect((await copies("nomatch-1")).map((c) => c.folder)).toEqual(["INBOX"]);
    await expect(undoMove(undo!)).rejects.toThrow(/can't be undone/);
  });
});
