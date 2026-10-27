import { describe, expect, it } from "vitest";
import { listNotes } from "@/server/notes";
import { updateOverride } from "@/server/overrides";
import { updatePerson } from "@/server/people";
import { getDb } from "@/server/db";
import { ALL_ACCOUNTS } from "@/lib/mail/scope";
import { noteMatches, sortNotes, type NoteEntry } from "@/lib/mail/notes";

const noteAt = (table: "thread_overrides" | "people", key: string) =>
  (
    getDb()
      .prepare(`SELECT note_at FROM ${table} WHERE ${table === "people" ? "email" : "thread_id"} = ?`)
      .get(key) as { note_at: string | null } | undefined
  )?.note_at;

describe("notes", () => {
  it("lists conversation and person notes, newest first, scoped by account", async () => {
    updateOverride("acc1:t1", { note: "Call **Thandi** back" });
    await new Promise((r) => setTimeout(r, 5));
    updatePerson({ email: "Sam@Example.com", note: "Prefers mornings" });
    await new Promise((r) => setTimeout(r, 5));
    updateOverride("acc2:t2", { note: "Second account" });

    const all = listNotes(ALL_ACCOUNTS);
    expect(all.map((n) => `${n.kind}:${n.id}`)).toEqual(["conversation:acc2:t2", "person:sam@example.com", "conversation:acc1:t1"]);
    const first = all[2];
    expect(first.kind === "conversation" && first.thread).toBe(null);

    expect(listNotes("acc1").map((n) => n.id)).toEqual(["sam@example.com", "acc1:t1"]);
  });

  it("dates a note when its text changes, not when other things about it do", async () => {
    updateOverride("acc1:t3", { note: "First" });
    const written = noteAt("thread_overrides", "acc1:t3");
    expect(written).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    updateOverride("acc1:t3", { muted: true });
    expect(noteAt("thread_overrides", "acc1:t3")).toBe(written);
    updateOverride("acc1:t3", { note: "Changed" });
    expect(noteAt("thread_overrides", "acc1:t3")).not.toBe(written);
    updateOverride("acc1:t3", { note: null });
    expect(noteAt("thread_overrides", "acc1:t3")).toBe(null);

    updatePerson({ email: "lee@example.com", note: "Hi" });
    const personWritten = noteAt("people", "lee@example.com");
    await new Promise((r) => setTimeout(r, 5));
    updatePerson({ email: "lee@example.com", vip: true });
    expect(noteAt("people", "lee@example.com")).toBe(personWritten);
  });

  it("searches every word across note, subject and person", () => {
    const person: NoteEntry = { kind: "person", id: "sam@example.com", note: "Prefers mornings", noteAt: null, name: "Sam Lee" };
    const convo: NoteEntry = { kind: "conversation", id: "a:t", accountId: "a", note: "Ask about **invoice**", noteAt: "2026-01-02", thread: null, subject: "Q3 plan" };
    expect(noteMatches(person, "sam mornings")).toBe(true);
    expect(noteMatches(person, "evenings")).toBe(false);
    expect(noteMatches(convo, "invoice q3")).toBe(true);
    expect(sortNotes([person, convo])[0]).toBe(convo);
  });
});
