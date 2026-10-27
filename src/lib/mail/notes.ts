import { bodyToText } from "./body";
import type { ThreadOverride } from "./overrides";
import type { PersonPrefs } from "./person-prefs";
import type { Thread } from "./types";

// The Notes view (components/notes/notes-view.tsx): every private note in one list, on
// conversations (thread_overrides.note, markup) and on people (people.note, plain text).

export type ConversationNote = {
  kind: "conversation";
  /** Kite thread id. */
  id: string;
  accountId: string;
  note: string;
  /** When the note was last written; null when Kite doesn't know (sorted by the conversation's date). */
  noteAt: string | null;
  /** The conversation's slim copy, or null when it isn't on this device (yet). */
  thread: Thread | null;
  /** The local subject when it was renamed, else the conversation's own. */
  subject: string;
};

export type PersonNote = {
  kind: "person";
  /** Lower-cased address. */
  id: string;
  note: string;
  noteAt: string | null;
  /** The name they last wrote under, when Kite has seen one. */
  name: string | null;
};

export type NoteEntry = ConversationNote | PersonNote;
export type NoteFilter = "all" | "conversation" | "person";

/** The time a note sorts by: when it was written, else (conversations) when the conversation last moved. */
function noteTime(entry: NoteEntry) {
  const thread = entry.kind === "conversation" ? entry.thread : null;
  return entry.noteAt ?? thread?.messages[thread.messages.length - 1]?.date ?? "";
}

export function sortNotes(entries: NoteEntry[]) {
  return [...entries].sort((a, b) => noteTime(b).localeCompare(noteTime(a)));
}

/** Every word of the search in the note, the subject, the person or the sender (any case). */
export function noteMatches(entry: NoteEntry, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = (
    entry.kind === "conversation"
      ? [bodyToText(entry.note), entry.subject, ...(entry.thread?.messages.flatMap((m) => [m.from.name, m.from.email]) ?? [])]
      : [entry.note, entry.name ?? "", entry.id]
  )
    .join(" ")
    .toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Demo mode: the notes on the sample conversations and people, from the app's own state. */
export function demoNotes(threads: Thread[], overrides: Record<string, ThreadOverride>, people: Record<string, PersonPrefs>): NoteEntry[] {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const conversations: NoteEntry[] = Object.entries(overrides).flatMap(([id, o]) => {
    if (!o.note) return [];
    const thread = byId.get(id) ?? null;
    return [{ kind: "conversation", id, accountId: thread?.accountId ?? id.split(":")[0], note: o.note, noteAt: null, thread, subject: o.subject ?? thread?.subject ?? "" }];
  });
  const names = new Map(threads.flatMap((t) => t.messages.map((m) => [m.from.email.toLowerCase(), m.from.name] as const)));
  const persons: NoteEntry[] = Object.entries(people).flatMap(([email, p]) =>
    p.note ? [{ kind: "person" as const, id: email, note: p.note, noteAt: null, name: names.get(email) ?? null }] : [],
  );
  return sortNotes([...conversations, ...persons]);
}
