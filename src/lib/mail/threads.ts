import type { Thread } from "./types";

// Kite thread ids are `${accountId}:${key}`. For a conversation as the provider groups it, the
// key is the provider's thread id (Gmail thread id, Outlook conversationId). A conversation split
// off locally gets `${remoteThreadId}~${firstMessageId}`, and a merged one keeps the key of the
// conversation it was merged into. The provider's own threading is never changed: see server/regroup.ts.

/**
 * A provider's id for a thread, message, draft or attachment part: Gmail's hex ids, Graph's
 * URL-safe base64 (with = padding), IMAP numbers. Never contains `:`, `~` or `/`.
 */
const ID = "[A-Za-z0-9_=-]{1,512}";
export const REMOTE_ID = new RegExp(`^${ID}$`);
/** An attachment's part id (Gmail "1.2", a Graph attachment id). */
export const PART_ID = /^[A-Za-z0-9._=-]{1,512}$/;

/** A thread key in URLs and requests. */
export const THREAD_KEY = new RegExp(`^${ID}(~${ID})?$`);

/** The id part after the account, used in API paths. */
export function threadKey(thread: Pick<Thread, "id" | "accountId">) {
  return thread.id.startsWith(`${thread.accountId}:`) ? thread.id.slice(thread.accountId.length + 1) : thread.id;
}

/** The Gmail thread a key belongs to (a split conversation lives inside its original Gmail thread). */
export function homeRemote(key: string) {
  return key.split("~")[0];
}

/** Every Gmail thread whose messages appear in this conversation (two or more once merged). */
export function remotesOf(thread: Pick<Thread, "messages" | "remoteId">) {
  const ids = new Set(thread.messages.map((m) => m.remoteThread ?? thread.remoteId).filter((id): id is string => !!id));
  return [...ids];
}
