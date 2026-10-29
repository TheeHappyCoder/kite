import { describe, expect, it } from "vitest";
import { TRASH } from "@/lib/mail/mailboxes";
import type { MailBatchJob, MailBatchRequest } from "@/lib/mail/batch";
import { previewMailBatch, executeMailBatch, undoMailBatch, refreshTrash, jobState } from "@/server/mail-batch";
import { mailOf } from "@/server/providers/registry";
import { queryThreads } from "@/server/store";
import { runMessageOp, runOp } from "@/server/sync";
import { keyOf, storedThreads, sync, thread, type Mailbox } from "./harness";

/** Waits for a job the way the window does, and answers with what it finished with. */
async function settled(started: MailBatchJob) {
  let job = started;
  while (!job.finished) {
    await new Promise((r) => setTimeout(r, 10));
    job = jobState(started.id)!;
  }
  if (job.error) throw new Error(job.error);
  return job;
}
const preview = async (input: MailBatchRequest) => (await settled(previewMailBatch(input))).preview!;
const execute = async (token: string) => (await settled(executeMailBatch(token))).result!;
const undo = async (token: string) => (await settled(undoMailBatch(token))).result!;

export function trashChecks(box: Mailbox) {
  describe("Trash and Cleanup", () => {
    it("loads provider Trash and restores a deleted conversation to inbox", async () => {
      await sync(box.account);
      const t = thread(box.account, "Invoice INV-2041");
      await runOp(box.account, keyOf(box.account, t), "trash");
      await refreshTrash(box.account.id);
      expect(queryThreads("trash", box.account.id).some((r) => r.id === t.id)).toBe(true);
      expect(queryThreads("inbox", box.account.id).some((r) => r.id === t.id)).toBe(false);
      expect(queryThreads("archive", box.account.id).some((r) => r.id === t.id)).toBe(false);
      await runOp(box.account, keyOf(box.account, t), "untrash");
      expect(queryThreads("inbox", box.account.id).some((r) => r.id === t.id)).toBe(true);
      expect(queryThreads("trash", box.account.id).some((r) => r.id === t.id)).toBe(false);
    });

    it("deletes one message of a conversation, leaves the rest, and Undo puts it back", async () => {
      await sync(box.account);
      const mail = mailOf(box.account);
      const t = storedThreads(box.account).find((c) => c.messages.length > 1 && !c.messages.some((m) => m.labels?.includes(TRASH)))!;
      expect(t).toBeTruthy();
      const [gone, ...kept] = t.messages;
      await runMessageOp(box.account, keyOf(box.account, t), "trash", [gone.id, "not-in-this-conversation"]);
      expect((await mail.fetchMessage(box.account, gone.id, false)).labels).toContain(TRASH);
      for (const m of kept) expect((await mail.fetchMessage(box.account, m.id, false)).labels ?? []).not.toContain(TRASH);
      await sync(box.account);
      // The conversation keeps its other messages where they were; Trash holds just the deleted one.
      const trashed = queryThreads("trash", box.account.id).find((r) => r.id === t.id);
      expect(trashed?.messages.map((m) => m.id)).toEqual([gone.id]);
      await runMessageOp(box.account, keyOf(box.account, t), "untrash", [gone.id]);
      expect((await mail.fetchMessage(box.account, gone.id, false)).labels ?? []).not.toContain(TRASH);
      await sync(box.account);
      expect(queryThreads("trash", box.account.id).some((r) => r.id === t.id)).toBe(false);
    });

    it("previews sender mail in the selected account and restores its original folder on Undo", async () => {
      const t = thread(box.account, "Contract draft");
      const message = t.messages[0];
      const mail = mailOf(box.account);
      const before = await mail.fetchMessage(box.account, message.id, false);
      const none = await preview({ account: "another-account", action: "trash", senders: [message.from.email], inboxOnly: false });
      expect(none.count).toBe(0);
      const reviewed = await preview({ account: box.account.id, action: "trash", senders: [message.from.email], inboxOnly: false });
      expect(reviewed.count).toBeGreaterThan(0);
      expect(reviewed.accounts).toEqual([{ id: box.account.id, email: box.account.email, count: reviewed.count }]);
      const result = await execute(reviewed.token);
      expect(result.failed).toBe(0);
      expect(result.done).toBe(reviewed.count);
      expect((await mail.fetchMessage(box.account, message.id, false)).labels).toContain(TRASH);
      expect(result.undo).toBeTruthy();
      expect((await undo(result.undo!)).failed).toBe(0);
      expect((await mail.fetchMessage(box.account, message.id, false)).labels?.sort()).toEqual(before.labels?.sort());
      expect(() => executeMailBatch(reviewed.token)).toThrow(/expired/);
    });

    it("permanently deletes only confirmed Trash messages and skips a restored one", async () => {
      const mail = mailOf(box.account);
      const first = thread(box.account, "Invoice INV-2041");
      const other = thread(box.account, "Contract draft");
      for (const t of [first, other]) await runOp(box.account, keyOf(box.account, t), "trash");
      const selection = { account: box.account.id, action: "permanent" as const, threads: [{ account: box.account.id, id: keyOf(box.account, first) }] };
      const stale = await preview(selection);
      await runOp(box.account, keyOf(box.account, first), "untrash");
      expect(await execute(stale.token)).toMatchObject({ done: 0, skipped: stale.count, failed: 0 });
      await runOp(box.account, keyOf(box.account, first), "trash");
      const reviewed = await preview(selection);
      const result = await execute(reviewed.token);
      expect(result).toMatchObject({ done: reviewed.count, failed: 0, skipped: 0 });
      expect(result.undo).toBeUndefined();
      expect(await mail.fetchThread(box.account, first.remoteId!, false)).toBeNull();
      expect((await mail.fetchMessage(box.account, other.messages[0].id, false)).labels).toContain(TRASH);
    });
  });
}
