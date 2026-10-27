import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";
import { CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_UPDATES, INBOX, SPAM, STARRED, TRASH, UNREAD } from "@/lib/mail/mailboxes";
import { parseSearch } from "@/lib/mail/search";
import { getDb } from "@/server/db";
import { listStoredLabels } from "@/server/labels";
import { renderOutgoing } from "@/server/outgoing";
import { labelId } from "@/server/providers/imap/gmail";
import { messageRow } from "@/server/providers/imap/mirror";
import { presetOf } from "@/server/providers/imap/servers";
import { mailOf } from "@/server/providers/registry";
import { updatePreferences } from "@/server/settings";
import { queryThreads, searchThreads } from "@/server/store";
import { resetMailCache, runOp, searchRemote, syncIdle } from "@/server/sync";
import { LABELS } from "../../scripts/imap-test-server.mjs";
import { calendarChecks } from "./calendar-checks";
import { keyOf, serverCopies, storedThreads, sync, thread, testMailbox } from "./harness";

// Gmail over IMAP against the test server's `--gmail` mode: what the live Gmail check covered by hand.

const box = testMailbox({ gmail: true });
const ALL = "[Gmail]/All Mail";
const TRASH_BOX = "[Gmail]/Trash";
const SPAM_BOX = "[Gmail]/Spam";
const FOLDERS = [ALL, TRASH_BOX, SPAM_BOX];

const subjects = (threads: { subject: string }[]) => threads.map((t) => t.subject).sort();

describe("Gmail over IMAP", () => {
  it("signs in as Gmail when the server speaks X-GM-EXT-1", () => {
    expect(presetOf(box.account.id)).toBe("gmail");
  });

  it("first sync lands conversations, labels and clean snippets", async () => {
    // "Use your calendar" on from the start, as a user who turned it on before connecting.
    updatePreferences({ calendar: true });
    await sync(box.account);
    const q3 = thread(box.account, "Quarterly numbers");
    expect(q3.messages).toHaveLength(3);
    expect(q3.rowLabels).toEqual(expect.arrayContaining([INBOX, "SENT"]));

    // Labels are read in the same pass, so the sidebar has them before bodies prefetch.
    const names = listStoredLabels(box.account.id).map((l) => l.name);
    expect(names).toEqual(expect.arrayContaining([LABELS.align, LABELS.clients, LABELS.dues, "Receipts"]));
    expect(thread(box.account, "Contract draft").rowLabels).toContain(labelId(LABELS.clients));
    expect(thread(box.account, "Your September statement").rowLabels).toContain(labelId(LABELS.align));
    expect(thread(box.account, "Invoice INV-2041").rowLabels).toEqual(expect.arrayContaining([labelId("Receipts"), labelId(LABELS.dues)]));

    // The statement's first 2 KB are all styles (cut inside an Outlook comment): the snippet comes from the bigger read.
    const statement = thread(box.account, "Your September statement").messages[0];
    expect(messageRow(box.account.id, statement.id)?.parsed.snippet).toMatch(/^Your September statement is ready/);
    expect(statement.snippet).not.toMatch(/[{}]|mso-|font-family/);
  });

  it("first sync sorts the Inbox into tabs, Primary winning", () => {
    expect(thread(box.account, "Your weekly digest").rowLabels).toContain(CATEGORY_PROMOTIONS);
    expect(thread(box.account, "Invoice INV-2041").rowLabels).toContain(CATEGORY_UPDATES);
    // Sorted into Social, but Gmail shows it in Primary (the Social tab is turned off).
    const social = thread(box.account, "Sipho tagged you in a photo").rowLabels;
    expect(social).not.toContain(CATEGORY_SOCIAL);
    expect(social.filter((l) => l.startsWith("CATEGORY_"))).toEqual([]);
    expect(thread(box.account, "Contract draft").rowLabels.filter((l) => l.startsWith("CATEGORY_"))).toEqual([]);
  });

  it("drops Gmail's system labels and keeps a draft saved twice as one draft", async () => {
    const lunch = thread(box.account, "Lunch on Friday?");
    expect(lunch.messages).toHaveLength(1);
    expect(lunch.rowLabels).toContain("DRAFT");
    expect(storedThreads(box.account).flatMap((t) => t.rowLabels).some((l) => l.startsWith("\\"))).toBe(false);
    expect(await mailOf(box.account).listDrafts(box.account)).toHaveLength(1);
  });

  describe("label: search", () => {
    const local = (q: string) => subjects(searchThreads(q, box.account.id));

    it.each([
      ['label:"Align – Discovery Bank Ltd"', ["Your September statement"]],
      ["label:align-–-discovery-bank-ltd", ["Your September statement"]],
      ["label:work-clients", ["Contract draft"]],
      ['label:"Work/Clients"', ["Contract draft"]],
      ["label:Échéances", ["Invoice INV-2041"]],
      ["label:échéances", ["Invoice INV-2041"]],
      ["label:receipts", ["Invoice INV-2041", "Order 7781 shipped"]],
      ["label:nothing-here", []],
    ])("locally: %s", (q, expected) => {
      expect(local(q)).toEqual(expected);
    });

    it.each([
      ['label:"Align – Discovery Bank Ltd"', ["Your September statement"]],
      ["label:align-–-discovery-bank-ltd", ["Your September statement"]],
      ["label:work-clients", ["Contract draft"]],
      ["label:Échéances", ["Invoice INV-2041"]],
      ["label:receipts subject:order", ["Order 7781 shipped"]],
      ["label:nothing-here", []],
    ])("as X-GM-RAW: %s", async (q, expected) => {
      const ids = await searchRemote(box.account, parseSearch(q));
      expect(subjects(storedThreads(box.account).filter((t) => ids.includes(t.id)))).toEqual(expected);
    });
  });

  it("All mail is everything but Trash, Spam and drafts; in:archive is out of the Inbox", () => {
    const all = subjects(queryThreads("archive", box.account.id));
    expect(all).toEqual(expect.arrayContaining(["Quarterly numbers", "Long time", "Order 7781 shipped", "Your weekly digest"]));
    expect(all).not.toContain("You won!");
    expect(all).not.toContain("Lunch on Friday?");
    expect(subjects(searchThreads("in:archive", box.account.id))).toEqual(["Long time", "Order 7781 shipped"]);
    // The first sync reads All Mail only (like the Gmail API's lists): Spam comes as it arrives.
    expect(subjects(searchThreads("in:spam", box.account.id))).toEqual([]);
  });

  calendarChecks(box);

  describe("ops and their undos", () => {
    const at = async (id: string) => (await serverCopies(box, FOLDERS)).get(id) ?? [];
    const op = async (subject: string, name: Parameters<typeof runOp>[2]) => {
      await runOp(box.account, keyOf(box.account, thread(box.account, subject)), name);
      // The next check reads the server back: Kite's copy must agree with it.
      await sync(box.account);
      return thread(box.account, subject).rowLabels;
    };

    it("archive removes \\Inbox; unarchive puts it back", async () => {
      expect(await op("Contract draft", "archive")).not.toContain(INBOX);
      expect((await at("contract-1"))[0].labels).not.toContain("\\Inbox");
      expect(subjects(searchThreads("in:archive", box.account.id))).toContain("Contract draft");
      const back = await op("Contract draft", "unarchive");
      expect(back).toContain(INBOX);
      expect(back).toContain(labelId(LABELS.clients));
      expect((await at("contract-1"))[0].labels).toEqual(expect.arrayContaining(["\\Inbox", LABELS.clients]));
    });

    it("star and read are flags", async () => {
      expect(await op("Long time", "star")).toContain(STARRED);
      expect((await at("old-1"))[0].flags).toContain("\\Flagged");
      expect(await op("Long time", "unstar")).not.toContain(STARRED);
      expect((await at("old-1"))[0].flags).not.toContain("\\Flagged");

      expect(await op("Your weekly digest", "read")).not.toContain(UNREAD);
      expect((await at("digest-1"))[0].flags).toContain("\\Seen");
      expect(await op("Your weekly digest", "unread")).toContain(UNREAD);
      expect((await at("digest-1"))[0].flags).not.toContain("\\Seen");
    });

    it("trash moves to Trash and back, the user's labels kept", async () => {
      const trashed = await op("Invoice INV-2041", "trash");
      expect(trashed).toContain(TRASH);
      expect(trashed).not.toContain(INBOX);
      expect((await at("inv-2041")).map((c) => c.folder)).toEqual([TRASH_BOX]);
      expect(subjects(queryThreads("inbox", box.account.id))).not.toContain("Invoice INV-2041");

      const back = await op("Invoice INV-2041", "untrash");
      expect(back).toEqual(expect.arrayContaining([INBOX, labelId("Receipts"), labelId(LABELS.dues)]));
      expect(back).not.toContain(TRASH);
      const copies = await at("inv-2041");
      expect(copies.map((c) => c.folder)).toEqual([ALL]);
      expect(copies[0].labels).toEqual(expect.arrayContaining(["\\Inbox", "Receipts", LABELS.dues]));
    });

    it("spam moves to Spam and back", async () => {
      const spam = await op("Your weekly digest", "spam");
      expect(spam).toContain(SPAM);
      expect((await at("digest-1")).map((c) => c.folder)).toEqual([SPAM_BOX]);
      expect(subjects(searchThreads("in:spam", box.account.id))).toEqual(["Your weekly digest"]);
      expect(subjects(queryThreads("archive", box.account.id))).not.toContain("Your weekly digest");
      const back = await op("Your weekly digest", "unspam");
      expect(back).toContain(INBOX);
      expect(back).not.toContain(SPAM);
      expect((await at("digest-1")).map((c) => c.folder)).toEqual([ALL]);
      expect((await at("digest-1"))[0].labels).toContain("\\Inbox");
    });
  });

  describe("drafts", () => {
    const draftMessage = (body: string) => ({ to: [{ name: "Thandi Nkosi", email: "thandi@company.co.za" }], subject: "Kite draft", body });
    const messageIdOf = (id: string) => (messageRow(box.account.id, id)?.parsed.messageId ?? "").replace(/^<|@.*$/g, "");

    it("two saves leave one draft; Discard leaves none and nothing in Trash", async () => {
      const mail = mailOf(box.account);
      const first = draftMessage("First save");
      const saved = await mail.saveDraft(box.account, first, await renderOutgoing(box.account, first));
      const second = draftMessage("Second save");
      const again = await mail.saveDraft(box.account, second, await renderOutgoing(box.account, second), saved.id);
      expect(again.id).toBe(saved.id);
      const header = messageIdOf(saved.id);
      const copies = (await serverCopies(box, FOLDERS)).get(header) ?? [];
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({ folder: ALL });
      expect(copies[0].labels).toContain("\\Draft");
      expect((await mail.getDraft(box.account, saved.id)).text).toContain("Second save");
      expect((await mail.listDrafts(box.account)).filter((d) => d.id === saved.id)).toHaveLength(1);

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
      const copies = (await serverCopies(box, FOLDERS)).get("twice-1") ?? [];
      expect(copies).toHaveLength(1);
      expect(copies[0].folder).toBe(ALL);
      expect((await mail.getDraft(box.account, twice.id)).text).toContain("Third version.");
    });
  });

  it("Reset local copy empties imap_messages and rebuilds", async () => {
    const db = getDb();
    const count = () => (db.prepare("SELECT COUNT(*) AS n FROM imap_messages WHERE account_id = ?").get(box.account.id) as { n: number }).n;
    const before = count();
    const threads = storedThreads(box.account).length;
    // A stale row only the reset can clear (sync would keep a stored snippet).
    db.prepare("UPDATE imap_messages SET meta = json_set(meta, '$.snippet', 'STALE') WHERE account_id = ?").run(box.account.id);
    await resetMailCache();
    await syncIdle(box.account.id);
    expect(count()).toBe(before);
    expect(storedThreads(box.account)).toHaveLength(threads);
    const stale = db.prepare("SELECT COUNT(*) AS n FROM imap_messages WHERE account_id = ? AND meta LIKE '%\"snippet\":\"STALE\"%'").get(box.account.id) as { n: number };
    expect(stale.n).toBe(0);
    expect(thread(box.account, "Your weekly digest").rowLabels).toContain(CATEGORY_PROMOTIONS);
  });

  it("peek says whether new mail waits, and the next check lands it in Primary", async () => {
    const mail = mailOf(box.account);
    const cursor = () => (getDb().prepare("SELECT history_id FROM sync_state WHERE account_id = ?").get(box.account.id) as { history_id: string }).history_id;
    await sync(box.account);
    expect(await mail.peek!(box.account, cursor())).toBe(false);
    const client = new ImapFlow({ host: "127.0.0.1", port: box.server.imapPort, secure: false, auth: { user: box.server.user, pass: box.server.password }, logger: false });
    client.on("error", () => {});
    await client.connect();
    const raw = [
      "From: Login Service <no-reply@login.example>",
      `To: Kite Test <${box.server.user}>`,
      "Subject: Your sign-in code",
      "Message-ID: <peek-1@test.example>",
      `Date: ${new Date().toUTCString()}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Your code is 482913.",
      "",
    ].join("\r\n");
    try {
      await client.append("INBOX", raw, []);
    } finally {
      await client.logout().catch(() => client.close());
    }
    expect(await mail.peek!(box.account, cursor())).toBe(true);
    await sync(box.account);
    expect(await mail.peek!(box.account, cursor())).toBe(false);
    const arrived = thread(box.account, "Your sign-in code");
    expect(arrived.rowLabels).toContain(INBOX);
    expect(arrived.rowLabels).not.toContain(CATEGORY_PROMOTIONS);
  });
});
