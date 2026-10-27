import "server-only";

import { INBOX, SPAM, STARRED, TRASH, UNREAD } from "@/lib/mail/mailboxes";
import type { LabelChange } from "./types";

// Thread operations as label changes in Kite's names. Every provider adapter applies the change
// its own way (Gmail: labels; Outlook: moves between folders, isRead, flags).

export type ThreadOp =
  | "archive"
  | "unarchive"
  | "star"
  | "unstar"
  | "read"
  | "unread"
  | "spam"
  | "unspam"
  | "trash"
  | "untrash"
  | "snooze"
  | "unsnooze";

export const LABEL_OPS: Record<ThreadOp, LabelChange> = {
  archive: { add: [], remove: [INBOX] },
  unarchive: { add: [INBOX], remove: [] },
  star: { add: [STARRED], remove: [] },
  unstar: { add: [], remove: [STARRED] },
  read: { add: [], remove: [UNREAD] },
  unread: { add: [UNREAD], remove: [] },
  spam: { add: [SPAM], remove: [INBOX] },
  unspam: { add: [INBOX], remove: [SPAM] },
  trash: { add: [TRASH], remove: [INBOX] },
  untrash: { add: [INBOX], remove: [TRASH] },
  snooze: { add: [], remove: [INBOX] },
  unsnooze: { add: [INBOX], remove: [] },
};
