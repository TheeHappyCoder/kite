import * as z from "zod";
import type { Thread } from "./types";

// Per-conversation changes that live only in Kite's database (never in Gmail): the chat/email
// choice, mute, pin, a private note, a local subject and reply tracking's Done / Dismiss
// (lib/replies.ts). Keyed by Kite thread id, kept when
// the mail cache is reset and applied on top of whatever sync stores.

export type ThreadOverride = {
  /** Chat (true) or email (false) view; absent follows the Settings default. */
  chat?: boolean;
  muted?: boolean;
  /** When the thread was pinned. */
  pinnedAt?: string;
  /** Private note (markup, like message bodies). Never sent. */
  note?: string;
  /** Local subject shown instead of the original. */
  subject?: string;
  /** Reply tracking's Done: the newest message when it was marked (a newer one brings the conversation back). */
  replyDone?: string;
  /** Reply tracking's Dismiss: never in To reply or Waiting on. */
  replyOff?: boolean;
};

/** One change to a thread's overrides. null clears a field. */
export const OverridePatch = z.object({
  chat: z.boolean().nullable().optional(),
  muted: z.boolean().optional(),
  pinned: z.boolean().optional(),
  note: z.string().max(20_000).nullable().optional(),
  subject: z.string().trim().max(300).nullable().optional(),
  replyDone: z.string().max(300).nullable().optional(),
  replyOff: z.boolean().optional(),
});
export type OverridePatch = z.infer<typeof OverridePatch>;

/** The override after a patch, or null when nothing is left to keep. */
export function patchOverride(current: ThreadOverride | undefined, patch: OverridePatch, now = new Date().toISOString()): ThreadOverride | null {
  const next: ThreadOverride = { ...current };
  if (patch.chat !== undefined) {
    if (patch.chat === null) delete next.chat;
    else next.chat = patch.chat;
  }
  if (patch.muted !== undefined) {
    if (patch.muted) next.muted = true;
    else delete next.muted;
  }
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinnedAt = current?.pinnedAt ?? now;
    else delete next.pinnedAt;
  }
  if (patch.note !== undefined) {
    if (patch.note?.trim()) next.note = patch.note;
    else delete next.note;
  }
  if (patch.subject !== undefined) {
    if (patch.subject) next.subject = patch.subject;
    else delete next.subject;
  }
  if (patch.replyDone !== undefined) {
    if (patch.replyDone) next.replyDone = patch.replyDone;
    else delete next.replyDone;
  }
  if (patch.replyOff !== undefined) {
    if (patch.replyOff) next.replyOff = true;
    else delete next.replyOff;
  }
  return Object.keys(next).length ? next : null;
}

/** The last shown copy of each thread: the same thread and override give the same object, so memoised rows skip. */
const shownCache = new WeakMap<Thread, { override: ThreadOverride; shown: Thread }>();

/** The thread as shown: local subject, pin, mute and note applied. */
export function applyOverride(thread: Thread, override: ThreadOverride | undefined): Thread {
  if (!override) return thread;
  const cached = shownCache.get(thread);
  if (cached?.override === override) return cached.shown;
  const renamed = override.subject && override.subject !== thread.subject;
  const shown: Thread = {
    ...thread,
    subject: renamed ? override.subject! : thread.subject,
    originalSubject: renamed ? thread.subject : undefined,
    pinned: !!override.pinnedAt || undefined,
    muted: override.muted || undefined,
    note: override.note,
  };
  shownCache.set(thread, { override, shown });
  return shown;
}

/** Pinned threads first, otherwise keeping the list's order. */
export function pinnedFirst(threads: Thread[]) {
  if (!threads.some((t) => t.pinned)) return threads;
  return [...threads.filter((t) => t.pinned), ...threads.filter((t) => !t.pinned)];
}

/** The stored thread behind a shown one (for undo snapshots taken from the list). */
export function withoutOverride(thread: Thread): Thread {
  const rest = { ...thread, subject: thread.originalSubject ?? thread.subject };
  delete rest.originalSubject;
  delete rest.pinned;
  delete rest.muted;
  delete rest.note;
  return rest;
}
