import { describe, expect, it } from "vitest";
import { INBOX, TRASH } from "@/lib/mail/mailboxes";
import { keywordId } from "@/server/providers/imap/folders";
import { copiesOf } from "@/server/providers/imap/mirror";
import { runOp } from "@/server/sync";
import { mailOf } from "@/server/providers/registry";
import { keyOf, serverCopies, sync, thread, testMailbox } from "./harness";

// A server that doesn't say where moved messages went (no UIDPLUS, so no COPYUID): Kite reads the
// destination back, so the index knows the new copies before the next check and Undo finds them.

const box = testMailbox({ uidplus: false });

describe("IMAP without UIDPLUS", () => {
  it("does not offer permanent deletion without targeted expunge", async () => {
    const mail = mailOf(box.account);
    expect(await mail.canDeletePermanently!(box.account)).toBe(false);
    await expect(mail.deletePermanently!(box.account, ["anything"])).rejects.toThrow(/cannot safely delete/);
  });
  it("moves and moves back without waiting for a check", async () => {
    await sync(box.account);
    const key = keyOf(box.account, thread(box.account, "Invoice INV-2041"));
    const id = thread(box.account, "Invoice INV-2041").messages[0].id;

    await runOp(box.account, key, "trash");
    expect(copiesOf(box.account.id, id).map((c) => c.folder)).toEqual(["Trash"]);
    // Undo straight away, before any sync pass.
    await runOp(box.account, key, "untrash");
    expect(copiesOf(box.account.id, id).map((c) => c.folder)).toEqual(["INBOX"]);
    expect((await serverCopies(box, ["INBOX", "Trash"])).get("inv-2041")?.map((c) => c.folder)).toEqual(["INBOX"]);

    await sync(box.account);
    const labels = thread(box.account, "Invoice INV-2041").rowLabels;
    expect(labels).toEqual(expect.arrayContaining([INBOX, keywordId("$Invoices")]));
    expect(labels).not.toContain(TRASH);
  });

  it("archives into Archive and back", async () => {
    const key = keyOf(box.account, thread(box.account, "Contract draft"));
    await runOp(box.account, key, "archive");
    await runOp(box.account, key, "unarchive");
    expect((await serverCopies(box, ["INBOX", "Archive"])).get("contract-1")?.map((c) => c.folder)).toEqual(["INBOX"]);
  });
});
