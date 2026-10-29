import { describe, expect, it } from "vitest";
import { deleteAccount, getDb, type AccountRow } from "@/server/db";
import { upsertRecord } from "@/server/store";
import { createSpace, deleteSpace, listSpaces, logoInUse, moveItems, restoreSpace, senderToSuggest, spaceThreads, threadSpaces, updateSpace } from "@/server/spaces";
import { spaceLabel, spacePath, spaceTree, within } from "@/lib/spaces";

const account = (id: string): AccountRow => ({ id, provider: "gmail", email: `${id}@example.test`, name: id, color: "blue", created_at: "2026-10-01", picture: null, nickname: null, face: null });

/** One stored conversation from `from` in account `id` (Kite thread id `${id}:${key}`). */
function seed(id: string, key: string, from: string, mailbox: "inbox" | "trash" = "inbox") {
  const a = account(id);
  getDb().prepare("INSERT OR IGNORE INTO accounts (id, provider, email, name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(a.id, a.provider, a.email, a.name, a.color, a.created_at);
  const labels = mailbox === "trash" ? ["TRASH"] : ["INBOX"];
  upsertRecord(a, {
    labels,
    sender: { name: from, email: from },
    recipients: [a.email],
    unsubscribe: null,
    thread: {
      id: `${id}:${key}`,
      accountId: id,
      remoteId: key,
      subject: `About ${key}`,
      mailbox,
      category: "important",
      unread: false,
      starred: false,
      messages: [{ id: key, from: { name: from, email: from }, to: [{ name: a.name, email: a.email }], date: "2026-10-01T12:00:00Z", body: ["Hello"], labels }],
    },
  });
  return `${id}:${key}`;
}

describe("spaces", () => {
  it("nests pockets four levels deep, no deeper, and never inside themselves", () => {
    const client = createSpace({ name: "Acme" });
    const job = createSpace({ name: "Website", parentId: client.id });
    const phase = createSpace({ name: "Phase 1", parentId: job.id });
    const task = createSpace({ name: "Copy", parentId: phase.id });
    expect(job.color).toBe(client.color);
    expect(() => createSpace({ name: "Too deep", parentId: task.id })).toThrow(/four levels/);
    expect(() => updateSpace(client.id, { parentId: phase.id })).toThrow(/own pockets/);
    const spaces = listSpaces();
    expect(spaceLabel(spaces, task.id)).toBe("Acme / Website / Phase 1 / Copy");
    expect(spacePath(spaces, phase.id).map((s) => s.name)).toEqual(["Acme", "Website", "Phase 1"]);
    expect([...within(spaces, job.id)].sort()).toEqual([job.id, phase.id, task.id].sort());
    expect(spaceTree(spaces).filter((t) => [client.id, job.id, phase.id, task.id].includes(t.space.id)).map((t) => t.depth)).toEqual([0, 1, 2, 3]);
  });

  it("holds conversations from several accounts, lists a space with its pockets, and leaves Trash out", () => {
    const space = createSpace({ name: "House move" });
    const pocket = createSpace({ name: "Lawyer", parentId: space.id });
    const a = seed("gm", "t1", "agent@estate.test");
    const b = seed("ol", "t2", "lawyer@law.test");
    const gone = seed("gm", "t3", "agent@estate.test", "trash");
    moveItems({ to: space.id, from: [], threads: [a, gone] });
    moveItems({ to: pocket.id, from: [], threads: [b] });
    expect(spaceThreads(space.id, "all").map((t) => t.id).sort()).toEqual([a, b].sort());
    expect(spaceThreads(pocket.id, "all").map((t) => t.id)).toEqual([b]);
    expect(spaceThreads(space.id, "ol").map((t) => t.id)).toEqual([b]);
    // Moving between pockets: into the pocket, out of the space.
    expect(moveItems({ to: pocket.id, from: [space.id], threads: [a] })[a]).toEqual([pocket.id]);
    expect(listSpaces().find((s) => s.id === pocket.id)?.threads).toBe(2);
  });

  it("deletes a space with its pockets and puts both back on Undo", () => {
    const space = createSpace({ name: "Trip" });
    const pocket = createSpace({ name: "Flights", parentId: space.id });
    const t = seed("gm", "t4", "airline@fly.test");
    moveItems({ to: pocket.id, from: [], threads: [t] });
    const saved = deleteSpace(space.id);
    expect(listSpaces().some((s) => s.id === space.id || s.id === pocket.id)).toBe(false);
    expect(threadSpaces([t])[t]).toEqual([]);
    restoreSpace(saved);
    expect(threadSpaces([t])[t]).toEqual([pocket.id]);
    expect(listSpaces().find((s) => s.id === pocket.id)?.parentId).toBe(space.id);
  });

  it("offers 'Always' once a sender has three conversations in a space, never for your own address", () => {
    const space = createSpace({ name: "Bank" });
    const ids = ["b1", "b2", "b3"].map((k) => seed("gm", k, "statements@bank.test"));
    moveItems({ to: space.id, from: [], threads: ids.slice(0, 2) });
    expect(senderToSuggest(space.id, [ids[1]])).toBeNull();
    moveItems({ to: space.id, from: [], threads: [ids[2]] });
    expect(senderToSuggest(space.id, [ids[2]])?.email).toBe("statements@bank.test");
    const mine = ["m1", "m2", "m3"].map((k) => seed("gm", k, "gm@example.test"));
    moveItems({ to: space.id, from: [], threads: mine });
    expect(senderToSuggest(space.id, mine)).toBeNull();
  });

  it("Disconnect takes an account's conversations out of every space, and the spaces stay", () => {
    const space = createSpace({ name: "Shared" });
    const t = seed("gone", "t9", "x@y.test");
    moveItems({ to: space.id, from: [], threads: [t] });
    deleteAccount("gone");
    expect(threadSpaces([t])[t]).toEqual([]);
    expect(listSpaces().some((s) => s.id === space.id)).toBe(true);
  });

  it("wears a logo, keeps it through delete and Undo, and knows when nothing wears it", () => {
    const logo = "0123456789abcdef01234567";
    const space = createSpace({ name: "Logo Co" });
    updateSpace(space.id, { logo });
    expect(listSpaces().find((s) => s.id === space.id)?.logo).toBe(logo);
    expect(logoInUse(logo)).toBe(true);
    const saved = deleteSpace(space.id);
    expect(logoInUse(logo)).toBe(false);
    restoreSpace(saved);
    expect(listSpaces().find((s) => s.id === space.id)?.logo).toBe(logo);
    updateSpace(space.id, { logo: null });
    expect(logoInUse(logo)).toBe(false);
  });
});
