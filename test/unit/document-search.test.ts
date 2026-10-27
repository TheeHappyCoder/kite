import { describe, expect, it } from "vitest";
import { getDb, type AccountRow } from "@/server/db";
import { upsertRecord, removeRemote, searchThreads, listFiles } from "@/server/store";
import { indexDocument } from "@/server/document-text";

const account = (id: string): AccountRow => ({ id, provider: "gmail", email: id + "@example.test", name: id, color: "blue", created_at: "2026-10-01", picture: null, nickname: null, face: null });
function seed(id: string, count: number) {
  const a = account(id);
  getDb().prepare("INSERT OR IGNORE INTO accounts (id, provider, email, name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(a.id, a.provider, a.email, a.name, a.color, a.created_at);
  for (let n = 0; n < count; n++) {
    const remoteId = id + n;
    upsertRecord(a, { labels: ["INBOX"], sender: { name: "Sender", email: "sender@example.test" }, recipients: [a.email], unsubscribe: null,
      thread: { id: id + ":" + remoteId, accountId: id, remoteId, subject: "Pagination fixture", mailbox: "inbox", category: "important", unread: false, starred: false, messages: [{ id: remoteId, from: { name: "Sender", email: "sender@example.test" }, to: [{ name: a.name, email: a.email }], date: "2026-10-01T12:00:00Z", body: ["Common fixture text"], labels: ["INBOX"], attachments: [{ name: "notes.txt", kind: "doc", size: "20 B", partId: "p1" }] }] } });
  }
}

describe("local search pagination and documents", () => {
  it("pages tied dates without repeating or losing conversations", () => {
    seed("pages", 107);
    const first = searchThreads("Pagination", "pages", 100);
    const next = searchThreads("Pagination", "pages", 100, 100);
    expect(first).toHaveLength(100);
    expect(next).toHaveLength(7);
    expect(new Set([...first, ...next].map((t) => t.id)).size).toBe(107);
  });
  it("finds document text in its account and honours negative terms", async () => {
    seed("docs", 1);
    await indexDocument("docs", "docs0", "p1", { name: "notes.txt", data: Buffer.from("RareDocumentNeedle ÉCHÉANCE") });
    expect(searchThreads("RareDocumentNeedle", "docs").map((t) => t.id)).toEqual(["docs:docs0"]);
    expect(searchThreads("RareDocumentNeedle", "pages")).toEqual([]);
    expect(searchThreads("Pagination -RareDocumentNeedle", "docs")).toEqual([]);
    expect(listFiles({ accountId: "docs", query: "RareDocumentNeedle", kind: null })).toHaveLength(1);
    expect(searchThreads("échéance", "docs")).toHaveLength(1);
    removeRemote(account("docs"), "docs0");
    expect(getDb().prepare("SELECT 1 FROM document_text WHERE account_id = ?").get("docs")).toBeUndefined();
  });
  it("does not restore extracted text when a reset removes the mail during extraction", async () => {
    seed("erased", 1);
    const pending = indexDocument("erased", "erased0", "p1", { name: "notes.txt", data: Buffer.from("Do not restore") });
    getDb().prepare("DELETE FROM threads WHERE account_id = ?").run("erased");
    await pending;
    expect(getDb().prepare("SELECT 1 FROM document_text WHERE account_id = ?").get("erased")).toBeUndefined();
  });
});
