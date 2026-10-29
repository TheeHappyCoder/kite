import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getDb, deleteAccount, type AccountRow } from "@/server/db";
import { upsertRecord, removeRemote } from "@/server/store";
import { findOrigin, rememberPrint } from "@/server/file-origin";

const account = (id: string): AccountRow => ({ id, provider: "gmail", email: id + "@example.test", name: id, color: "blue", created_at: "2026-10-01", picture: null, nickname: null, face: null });
function seed(id: string, subject: string, file: string) {
  const a = account(id);
  getDb().prepare("INSERT OR IGNORE INTO accounts (id, provider, email, name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(a.id, a.provider, a.email, a.name, a.color, a.created_at);
  const remoteId = id + "0";
  upsertRecord(a, { labels: ["INBOX"], sender: { name: "Sam", email: "sam@example.test" }, recipients: [a.email], unsubscribe: null,
    thread: { id: id + ":" + remoteId, accountId: id, remoteId, subject, mailbox: "inbox", category: "important", unread: false, starred: false, messages: [{ id: remoteId, from: { name: "Sam", email: "sam@example.test" }, to: [{ name: a.name, email: a.email }], date: "2026-10-12T12:00:00Z", body: ["Attached"], labels: ["INBOX"], attachments: [{ name: file, kind: "doc", size: "1 KB", partId: "p1" }] }] } });
  return a;
}
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("where a file came from", () => {
  it("finds the email by the file's bytes, whatever it's called now", () => {
    seed("prints", "Contract v3", "Contract.docx");
    rememberPrint("prints", "prints0", "p1", Buffer.from("contract bytes"));
    const { exact, named } = findOrigin(sha("contract bytes"), "renamed copy.docx");
    expect(exact.map((f) => [f.threadId, f.subject, f.name])).toEqual([["prints:prints0", "Contract v3", "Contract.docx"]]);
    expect(named).toEqual([]);
  });
  it("offers a same-named file as a guess when the bytes changed", () => {
    seed("guess", "Budget", "Budget Q3.xlsx");
    const { exact, named } = findOrigin(sha("edited since"), "budget q3.xlsx");
    expect(exact).toEqual([]);
    expect(named.map((f) => f.threadId)).toEqual(["guess:guess0"]);
    expect(findOrigin(sha("edited since"), "something else.xlsx")).toEqual({ exact: [], named: [] });
  });
  it("forgets fingerprints with the message and the account, and never keeps one for erased mail", () => {
    const a = seed("gone", "Invoice", "invoice.pdf");
    rememberPrint("gone", "gone0", "p1", Buffer.from("invoice"));
    removeRemote(a, "gone0");
    expect(getDb().prepare("SELECT 1 FROM file_prints WHERE account_id = ?").get("gone")).toBeUndefined();
    seed("gone", "Invoice", "invoice.pdf");
    rememberPrint("gone", "gone0", "p1", Buffer.from("invoice"));
    deleteAccount("gone");
    expect(getDb().prepare("SELECT 1 FROM file_prints WHERE account_id = ?").get("gone")).toBeUndefined();
    rememberPrint("gone", "gone0", "p1", Buffer.from("invoice"));
    expect(getDb().prepare("SELECT 1 FROM file_prints WHERE account_id = ?").get("gone")).toBeUndefined();
  });
});
