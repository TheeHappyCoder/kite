import { describe, expect, it } from "vitest";
import { bytesOf, driveEntries, driveFolders, DrivePrefs, peopleGroups, previewTree, runnable, safeName, splitGroup, tidyLevels, type DriveFile } from "@/lib/drive";
import { getDb, type AccountRow } from "@/server/db";
import { drivePreview, driveTree } from "@/server/drive";
import { updatePreferences } from "@/server/settings";
import { upsertRecord } from "@/server/store";

const file = (over: Partial<DriveFile>): DriveFile => ({
  accountId: "a", threadId: "a:t", messageId: "m", partId: "p1", name: "Invoice.pdf", bytes: 100, date: "2026-10-12T10:00:00Z",
  people: [{ name: "Sam Jones", email: "sam@acme.test" }], sender: "Sam Jones", kind: "pdf", account: "Work", ...over,
});
const paths = (groups: { dir: string[]; files: DriveFile[] }[]) => groups.map((g) => `${g.dir.join("/")} (${g.files.length})`).sort();

describe("drive layout", () => {
  it("makes names Windows accepts", () => {
    expect(safeName('Q3: "final"/v2?.pdf')).toBe("Q3 final v2 .pdf");
    expect(safeName("CON.txt")).toBe("_CON.txt");
    expect(safeName("notes. ")).toBe("notes");
    expect(safeName("")).toBe("Untitled");
    expect(safeName("x".repeat(200) + ".docx").endsWith(".docx")).toBe(true);
  });
  it("keeps programs, scripts and shortcuts out", () => {
    for (const name of ["setup.exe", "invoice.pdf.exe", "run.BAT", "a.ps1", "x.js", "y.lnk", "z.iso", "w.msi", "v.vbs", "trick.exe. "]) expect(runnable(name), name).toBe(true);
    for (const name of ["Invoice.pdf", "photo.jpg", "notes.docx", "data.json", "archive.zip"]) expect(runnable(name), name).toBe(false);
  });
  it("reads sizes providers give as text", () => {
    expect(bytesOf("84 KB")).toBe(86016);
    expect(bytesOf("1,5 MB")).toBe(1572864);
    expect(bytesOf(undefined)).toBe(0);
  });
  it("tells same-named files apart by sender and date, and never repeats a name", () => {
    const entries = driveEntries([{ dir: ["People", "Sam"], files: [
      file({ messageId: "m1", date: "2026-10-12T10:00:00Z" }),
      file({ messageId: "m2", date: "2026-09-01T10:00:00Z", sender: "You" }),
      file({ messageId: "m3", name: "Other.pdf" }),
    ] }]);
    expect(entries.map((e) => e.name)).toEqual(["Invoice (Sam Jones, 12 Oct 2026).pdf", "Other.pdf", "Invoice (You, 1 Sep 2026).pdf"]);
    expect(entries[0].id).toBe("a\nm1\np1");
    expect(driveEntries([{ dir: ["Spaces", "Empty"], files: [] }])).toEqual([{ dir: ["Spaces", "Empty"], name: "", id: "", bytes: 0, time: 0 }]);
  });
  it("names people folders by name, adding the address only where names clash", () => {
    const groups = peopleGroups([
      file({ messageId: "1", people: [{ name: "Sam", email: "sam@a.test" }] }),
      file({ messageId: "2", people: [{ name: "Sam", email: "sam@b.test" }] }),
      file({ messageId: "3", people: [{ name: "Lisa", email: "lisa@a.test" }] }),
    ], () => true);
    expect(groups.map((g) => g.dir[0]).sort()).toEqual(["Lisa", "Sam (sam@a.test)", "Sam (sam@b.test)"]);
  });
  it("splits by any levels, dates named by what's above them", () => {
    const files = [
      file({ messageId: "1", date: "2026-10-03T10:00:00Z" }),
      file({ messageId: "2", date: "2026-10-30T10:00:00Z", kind: "image" }),
      file({ messageId: "3", date: "2025-02-14T10:00:00Z", people: [] }),
    ];
    expect(paths(splitGroup(["Sam"], files, ["year", "month", "week"], 0))).toEqual([
      "Sam/2025/02 February/Week 2 (8–14 Feb) (1)",
      "Sam/2026/10 October/Week 1 (1–7 Oct) (1)",
      "Sam/2026/10 October/Week 4 (22–31 Oct) (1)",
    ]);
    expect(paths(splitGroup(["By date"], files, ["month", "type"], 0, true))).toEqual(["By date/2025-02/PDFs (1)", "By date/2026-10/Images (1)", "By date/2026-10/PDFs (1)"]);
    expect(paths(splitGroup(["Work"], files, ["person"], 0))).toEqual(["Work/Just you (1)", "Work/Sam Jones (2)"]);
    expect(paths(splitGroup(["Sam"], files, ["week"], 0))).toContain("Sam/2026-10 Week 4 (22–31 Oct) (1)");
  });
  it("leaves small folders as one list, at every level", () => {
    const many = Array.from({ length: 25 }, (_, i) => file({ messageId: `big${i}`, date: `2026-10-${String((i % 20) + 1).padStart(2, "0")}T10:00:00Z` }));
    const few = [file({ messageId: "old", date: "2026-09-02T10:00:00Z" })];
    expect(paths(splitGroup(["Sam"], few, ["month"], 20))).toEqual(["Sam (1)"]);
    // 26 files split by month (more than 20); October's 25 split by week; September's one stays.
    expect(paths(splitGroup(["Sam"], [...many, ...few], ["month", "week"], 20))).toEqual(["Sam/2026-09 (1)", "Sam/2026-10/Week 1 (1–7 Oct) (12)", "Sam/2026-10/Week 2 (8–14 Oct) (7)", "Sam/2026-10/Week 3 (15–21 Oct) (6)"]);
    expect(paths(splitGroup(["By date"], few, ["month"], 20, true))).toEqual(["By date/2026-09 (1)"]);
  });
  it("keeps levels tidy: once each, dates in order, no person inside People, By date starting with a date", () => {
    expect(tidyLevels("spaces", ["week", "person", "year", "week"])).toEqual(["year", "person", "week"]);
    expect(tidyLevels("people", ["person", "month"])).toEqual(["month"]);
    expect(tidyLevels("months", ["person"])).toEqual(["month", "person"]);
    const prefs = DrivePrefs.parse({ folders: [{ kind: "months", on: true }, { kind: "people", on: false, levels: ["year"] }, { kind: "months", on: false }] });
    expect(driveFolders(prefs).map((f) => `${f.kind}:${f.on}:${f.levels.join(">")}`)).toEqual(["months:true:month", "people:false:year", "spaces:false:month", "labels:false:month", "searches:false:"]);
  });
  it("previews a few folders per level with counts", () => {
    const entries = driveEntries(splitGroup(["People", "Sam"], [file({ messageId: "1" }), file({ messageId: "2", date: "2026-09-01T10:00:00Z" })], ["month"], 0));
    const [people] = previewTree(entries);
    expect(people.name).toBe("People");
    expect(people.total).toBe(2);
    expect(people.folders[0].folders.map((f) => f.name)).toEqual(["2026-10", "2026-09"]);
  });
});

describe("drive tree from the local copy", () => {
  it("lists people and dates from stored mail, inline images left out", () => {
    const a: AccountRow = { id: "acc", provider: "gmail", email: "me@example.test", name: "Me", color: "blue", created_at: "2026-10-01", picture: null, nickname: null, face: null };
    getDb().prepare("INSERT OR IGNORE INTO accounts (id, provider, email, name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(a.id, a.provider, a.email, a.name, a.color, a.created_at);
    const stored = (remoteId: string, from: { name: string; email: string }, to: { name: string; email: string }, name: string) =>
      upsertRecord(a, { labels: ["INBOX"], sender: from, recipients: [to.email], unsubscribe: null,
        thread: { id: `acc:${remoteId}`, accountId: "acc", remoteId, subject: "Files", mailbox: "inbox", category: "important", unread: false, starred: false,
          messages: [{ id: remoteId, from, to: [to], date: "2026-10-12T12:00:00Z", body: ["x"], labels: ["INBOX"], attachments: [{ name, kind: "doc", size: "1 KB", partId: "p1" }, { name: "logo.png", kind: "image", size: "1 KB", partId: "p2", inline: true }] }] } });
    stored("t1", { name: "Sam", email: "sam@acme.test" }, { name: "Me", email: "me@example.test" }, "Quote.pdf");
    stored("t2", { name: "Me", email: "me@example.test" }, { name: "Lisa", email: "lisa@acme.test" }, "Signed.pdf");
    updatePreferences({ drive: { on: true } });
    const { entries, version } = driveTree();
    // Two files each: under 30, so people stay one list each; By date always splits.
    expect(entries.map((e) => [...e.dir, e.name].join("/")).sort()).toEqual(["By date/2026-10/Quote.pdf", "By date/2026-10/Signed.pdf", "People/Lisa/Signed.pdf", "People/Sam/Quote.pdf"]);
    expect(driveTree().version).toBe(version);
    updatePreferences({ drive: { splitOver: 0, folders: [{ kind: "people", on: true, levels: ["type"] }] } });
    expect(driveTree().entries.map((e) => [...e.dir, e.name].join("/")).sort()).toEqual(["People/Lisa/PDFs/Signed.pdf", "People/Sam/PDFs/Quote.pdf"]);
    expect(drivePreview().map((n) => n.name)).toEqual(["People"]);
  });
});
