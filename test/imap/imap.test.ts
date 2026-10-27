import { describe, expect, it } from "vitest";
import { INBOX, SPAM, STARRED, TRASH, UNREAD } from "@/lib/mail/mailboxes";
import { parseSearch } from "@/lib/mail/search";
import { getDb } from "@/server/db";
import { SignInError } from "@/server/mail/errors";
import { listStoredLabels } from "@/server/labels";
import { renderOutgoing } from "@/server/outgoing";
import { imapAuth } from "@/server/providers/imap/auth";
import { keywordId } from "@/server/providers/imap/folders";
import { messageRow } from "@/server/providers/imap/mirror";
import { presetOf } from "@/server/providers/imap/servers";
import { mailOf } from "@/server/providers/registry";
import { updatePreferences } from "@/server/settings";
import { queryThreads, searchThreads } from "@/server/store";
import { resetMailCache, runOp, searchRemote, syncIdle } from "@/server/sync";
import { LABELS } from "../../scripts/imap-test-server.mjs";
import { calendarChecks } from "./calendar-checks";
import { keyOf, serverCopies, storedThreads, sync, thread, testMailbox } from "./harness";

// Plain IMAP (folders are labels, keywords are tags) against the test server's default mode.

// An app password the way Gmail and others show it: four groups of four, pasted with the spaces.
const box = testMailbox({ password: "abcdefghijklmnop", typed: "abcd efgh ijkl mnop" });
const FOLDERS = ["INBOX", "Sent", "Drafts", "Trash", "Junk", "Archive", "Receipts", LABELS.align, LABELS.dues, "Work/Clients"];

const subjects = (threads: { subject: string }[]) => threads.map((t) => t.subject).sort();
const folderLabel = (name: string) => listStoredLabels(box.account.id).find((l) => l.name === name)!;

describe("plain IMAP", () => {
  describe("sign-in", () => {
    it("joins an app password pasted with spaces and keeps no preset", () => {
      expect(box.account).toBeDefined();
      expect(presetOf(box.account.id)).toBeNull();
    });

    it("explains a refused password plainly", async () => {
      const attempt = imapAuth.signIn({ email: box.server.user, password: "wrong password", servers: box.servers });
      await expect(attempt).rejects.toBeInstanceOf(SignInError);
      await expect(attempt).rejects.toThrow(/didn't accept that address and password/);
    });

    it("explains a server that isn't there", async () => {
      const attempt = imapAuth.signIn({ email: box.server.user, password: "x", servers: { ...box.servers, imap: { host: "127.0.0.1", port: 1, secure: false } } });
      await expect(attempt).rejects.toThrow(/couldn't reach 127\.0\.0\.1/);
    });
  });

  it("first sync lands conversations, folders, keywords and clean snippets", async () => {
    updatePreferences({ calendar: true });
    await sync(box.account);
    // Threaded from References across Inbox and Sent.
    const q3 = thread(box.account, "Quarterly numbers");
    expect(q3.messages).toHaveLength(3);
    expect(q3.rowLabels).toEqual(expect.arrayContaining([INBOX, "SENT"]));

    const labels = listStoredLabels(box.account.id);
    for (const name of [LABELS.align, LABELS.clients, LABELS.dues, "Receipts"]) expect(folderLabel(name)?.kind).toBe("folder");
    expect(labels.find((l) => l.name === "Invoices")?.kind).toBe("tag");
    expect(thread(box.account, "Invoice INV-2041").rowLabels).toContain(keywordId("$Invoices"));
    expect(thread(box.account, "Retainer renewal").rowLabels).toContain(folderLabel(LABELS.clients).id);

    const statement = thread(box.account, "Your September statement");
    expect(statement.rowLabels).toContain(folderLabel(LABELS.align).id);
    expect(messageRow(box.account.id, statement.messages[0].id)?.parsed.snippet).toMatch(/^Your September statement is ready/);
    expect(statement.messages[0].snippet).not.toMatch(/[{}]|mso-|font-family/);
  });

  it("keeps a draft saved twice as one draft", async () => {
    expect(thread(box.account, "Lunch on Friday?").messages).toHaveLength(1);
    expect(await mailOf(box.account).listDrafts(box.account)).toHaveLength(1);
  });

  describe("label: search", () => {
    it.each([
      ['label:"Align – Discovery Bank Ltd"', ["Your September statement"]],
      ["label:align-–-discovery-bank-ltd", ["Your September statement"]],
      ["label:work-clients", ["Retainer renewal"]],
      ['label:"Work/Clients"', ["Retainer renewal"]],
      ["label:Échéances", ["Rates account due"]],
      ["label:invoices", ["Invoice INV-2041"]],
      ["label:nothing-here", []],
    ])("locally and at the server: %s", async (q, expected) => {
      expect(subjects(searchThreads(q, box.account.id))).toEqual(expected);
      const ids = await searchRemote(box.account, parseSearch(q));
      expect(subjects(storedThreads(box.account).filter((t) => ids.includes(t.id)))).toEqual(expected);
    });
  });

  it("All mail is everything but Trash, Spam and drafts; in:archive is out of the Inbox", () => {
    const all = subjects(queryThreads("archive", box.account.id));
    expect(all).toEqual(expect.arrayContaining(["Quarterly numbers", "Long time", "Order 7781 shipped", "Retainer renewal", "Your weekly digest"]));
    expect(all).not.toContain("Lunch on Friday?");
    expect(subjects(searchThreads("in:archive", box.account.id))).toEqual(["Long time", "Order 7781 shipped", "Rates account due", "Retainer renewal", "Your September statement"]);
  });

  calendarChecks(box);

  describe("ops and their undos", () => {
    const at = async (id: string) => (await serverCopies(box, FOLDERS)).get(id) ?? [];
    const op = async (subject: string, name: Parameters<typeof runOp>[2]) => {
      await runOp(box.account, keyOf(box.account, thread(box.account, subject)), name);
      await sync(box.account);
      return thread(box.account, subject).rowLabels;
    };

    it("archive moves to Archive; unarchive moves back", async () => {
      expect(await op("Contract draft", "archive")).not.toContain(INBOX);
      expect((await at("contract-1")).map((c) => c.folder)).toEqual(["Archive"]);
      const back = await op("Contract draft", "unarchive");
      expect(back).toEqual(expect.arrayContaining([INBOX, STARRED]));
      expect((await at("contract-1")).map((c) => c.folder)).toEqual(["INBOX"]);
    });

    it("star and read are flags", async () => {
      expect(await op("Long time", "star")).toContain(STARRED);
      expect((await at("old-1"))[0].flags).toContain("\\Flagged");
      expect(await op("Long time", "unstar")).not.toContain(STARRED);
      expect(await op("Your weekly digest", "read")).not.toContain(UNREAD);
      expect((await at("digest-1"))[0].flags).toContain("\\Seen");
      expect(await op("Your weekly digest", "unread")).toContain(UNREAD);
      expect((await at("digest-1"))[0].flags).not.toContain("\\Seen");
    });

    it("trash moves to Trash and back, the keyword kept", async () => {
      const trashed = await op("Invoice INV-2041", "trash");
      expect(trashed).toContain(TRASH);
      expect((await at("inv-2041")).map((c) => c.folder)).toEqual(["Trash"]);
      const back = await op("Invoice INV-2041", "untrash");
      expect(back).toEqual(expect.arrayContaining([INBOX, keywordId("$Invoices")]));
      expect(back).not.toContain(TRASH);
      const copies = await at("inv-2041");
      expect(copies.map((c) => c.folder)).toEqual(["INBOX"]);
      expect(copies[0].flags).toContain("$Invoices");
    });

    it("trash from one of the user's folders comes back to the Inbox", async () => {
      // A folder is where the message is: trashing takes it out, and IMAP keeps no note of where it was.
      const trashed = await op("Retainer renewal", "trash");
      expect(trashed).toContain(TRASH);
      expect(trashed).not.toContain(folderLabel(LABELS.clients).id);
      expect((await at("retainer-1")).map((c) => c.folder)).toEqual(["Trash"]);
      await op("Retainer renewal", "untrash");
      expect((await at("retainer-1")).map((c) => c.folder)).toEqual(["INBOX"]);
    });

    it("spam moves to Junk and back", async () => {
      expect(await op("Your weekly digest", "spam")).toContain(SPAM);
      expect((await at("digest-1")).map((c) => c.folder)).toEqual(["Junk"]);
      expect(subjects(queryThreads("archive", box.account.id))).not.toContain("Your weekly digest");
      expect(subjects(searchThreads("in:spam", box.account.id))).toContain("Your weekly digest");
      const back = await op("Your weekly digest", "unspam");
      expect(back).toContain(INBOX);
      expect(back).not.toContain(SPAM);
      expect((await at("digest-1")).map((c) => c.folder)).toEqual(["INBOX"]);
    });
  });

  describe("drafts", () => {
    const messageIdOf = (id: string) => (messageRow(box.account.id, id)?.parsed.messageId ?? "").replace(/^<|@.*$/g, "");

    it("two saves leave one draft; Discard leaves none and nothing in Trash", async () => {
      const mail = mailOf(box.account);
      const first = { to: [{ email: "thandi@company.co.za" }], subject: "Kite draft", body: "First save" };
      const saved = await mail.saveDraft(box.account, first, await renderOutgoing(box.account, first));
      const second = { ...first, body: "Second save" };
      const again = await mail.saveDraft(box.account, second, await renderOutgoing(box.account, second), saved.id);
      expect(again.id).toBe(saved.id);
      const header = messageIdOf(saved.id);
      const copies = (await serverCopies(box, FOLDERS)).get(header) ?? [];
      expect(copies.map((c) => c.folder)).toEqual(["Drafts"]);
      expect(copies[0].flags).toContain("\\Draft");
      expect((await mail.getDraft(box.account, saved.id)).text).toContain("Second save");

      await mail.deleteDraft(box.account, saved.id);
      expect((await serverCopies(box, FOLDERS)).get(header)).toBeUndefined();
      expect((await mail.listDrafts(box.account)).map((d) => d.id)).not.toContain(saved.id);
    });

    it("saving a draft another app saved twice leaves one copy", async () => {
      const mail = mailOf(box.account);
      const [twice] = await mail.listDrafts(box.account);
      expect((await serverCopies(box, FOLDERS)).get("twice-1")).toHaveLength(2);
      const next = { to: [{ email: "thandi@company.co.za" }], subject: "Lunch on Friday?", body: "Third version." };
      await mail.saveDraft(box.account, next, await renderOutgoing(box.account, next), twice.id);
      expect((await serverCopies(box, FOLDERS)).get("twice-1")?.map((c) => c.folder)).toEqual(["Drafts"]);
      expect((await mail.getDraft(box.account, twice.id)).text).toContain("Third version.");
    });
  });

  it("Reset local copy empties imap_messages and rebuilds", async () => {
    const db = getDb();
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM imap_messages WHERE account_id = ?").get(box.account.id) as { n: number }).n;
    const before = count();
    const threads = storedThreads(box.account).length;
    db.prepare("UPDATE imap_messages SET meta = json_set(meta, '$.snippet', 'STALE') WHERE account_id = ?").run(box.account.id);
    await resetMailCache();
    await syncIdle(box.account.id);
    expect(count()).toBe(before);
    expect(storedThreads(box.account)).toHaveLength(threads);
    expect((db.prepare("SELECT COUNT(*) AS n FROM imap_messages WHERE meta LIKE '%\"snippet\":\"STALE\"%'").get() as { n: number }).n).toBe(0);
  });
});
