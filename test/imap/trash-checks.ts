import { describe, expect, it } from "vitest";
import { TRASH } from "@/lib/mail/mailboxes";
import { previewMailBatch, executeMailBatch, undoMailBatch, refreshTrash } from "@/server/mail-batch";
import { mailOf } from "@/server/providers/registry";
import { queryThreads } from "@/server/store";
import { runOp } from "@/server/sync";
import { keyOf, sync, thread, type Mailbox } from "./harness";

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

    it("previews sender mail in the selected account and restores its original folder on Undo", async () => {
      const t = thread(box.account, "Contract draft");
      const message = t.messages[0];
      const mail = mailOf(box.account);
      const before = await mail.fetchMessage(box.account, message.id, false);
      const none = await previewMailBatch({ account: "another-account", action: "trash", senders: [message.from.email], inboxOnly: false });
      expect(none.count).toBe(0);
      const preview = await previewMailBatch({ account: box.account.id, action: "trash", senders: [message.from.email], inboxOnly: false });
      expect(preview.count).toBeGreaterThan(0);
      expect(preview.accounts).toEqual([{ email: box.account.email, count: preview.count }]);
      const result = await executeMailBatch(preview.token);
      expect(result.failed).toBe(0);
      expect(result.done).toBe(preview.count);
      expect((await mail.fetchMessage(box.account, message.id, false)).labels).toContain(TRASH);
      expect(result.undo).toBeTruthy();
      expect((await undoMailBatch(result.undo!)).failed).toBe(0);
      expect((await mail.fetchMessage(box.account, message.id, false)).labels?.sort()).toEqual(before.labels?.sort());
      await expect(executeMailBatch(preview.token)).rejects.toThrow(/expired/);
    });

    it("permanently deletes only confirmed Trash messages and skips a restored one", async () => {
      const mail = mailOf(box.account);
      const first = thread(box.account, "Invoice INV-2041");
      const other = thread(box.account, "Contract draft");
      for (const t of [first, other]) await runOp(box.account, keyOf(box.account, t), "trash");
      const selection = { account: box.account.id, action: "permanent" as const, threads: [{ account: box.account.id, id: keyOf(box.account, first) }] };
      const stale = await previewMailBatch(selection);
      await runOp(box.account, keyOf(box.account, first), "untrash");
      expect(await executeMailBatch(stale.token)).toMatchObject({ done: 0, skipped: stale.count, failed: 0 });
      await runOp(box.account, keyOf(box.account, first), "trash");
      const preview = await previewMailBatch(selection);
      const result = await executeMailBatch(preview.token);
      expect(result).toMatchObject({ done: preview.count, failed: 0, skipped: 0 });
      expect(result.undo).toBeUndefined();
      expect(await mail.fetchThread(box.account, first.remoteId!, false)).toBeNull();
      expect((await mail.fetchMessage(box.account, other.messages[0].id, false)).labels).toContain(TRASH);
    });
  });
}
