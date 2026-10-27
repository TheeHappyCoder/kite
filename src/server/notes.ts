import "server-only";

import type { NoteEntry } from "@/lib/mail/notes";
import { sortNotes } from "@/lib/mail/notes";
import { inScope, type AccountScope } from "@/lib/mail/scope";
import { getDb } from "./db";
import { threadsByIds } from "./store";

// The Notes view: every private note, read from thread_overrides and people (never logged).

/** Conversation notes for the accounts in scope, and every note on a person, newest first. */
export function listNotes(scope: AccountScope): NoteEntry[] {
  const db = getDb();
  const rows = (
    db.prepare("SELECT thread_id, note, note_at, subject FROM thread_overrides WHERE note IS NOT NULL").all() as {
      thread_id: string;
      note: string;
      note_at: string | null;
      subject: string | null;
    }[]
  ).filter((r) => inScope(scope, r.thread_id.split(":")[0]));
  const threads = new Map(threadsByIds(rows.map((r) => r.thread_id)).map((t) => [t.id, t]));
  const conversations: NoteEntry[] = rows.map((r) => {
    const thread = threads.get(r.thread_id) ?? null;
    return {
      kind: "conversation",
      id: r.thread_id,
      accountId: r.thread_id.split(":")[0],
      note: r.note,
      noteAt: r.note_at,
      thread,
      subject: r.subject ?? thread?.subject ?? "",
    };
  });

  const nameOf = db.prepare("SELECT sender_name FROM threads WHERE sender_email = ? AND sender_name != '' ORDER BY last_date DESC LIMIT 1");
  const people: NoteEntry[] = (db.prepare("SELECT email, note, note_at FROM people WHERE note IS NOT NULL").all() as {
    email: string;
    note: string;
    note_at: string | null;
  }[]).map((r) => ({
    kind: "person",
    id: r.email,
    note: r.note,
    noteAt: r.note_at,
    name: (nameOf.get(r.email) as { sender_name: string } | undefined)?.sender_name ?? null,
  }));
  return sortNotes([...conversations, ...people]);
}
