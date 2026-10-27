import type { Category } from "./types";

// Kite's own names for built-in mailboxes and flags in `Message.labels`. They're spelled like
// Gmail's system labels because Gmail came first; each provider adapter translates its own model
// to these (Outlook: folders, isRead, flag; IMAP: folders and \Seen, \Flagged). Everything above
// the adapters (store, rules, search, the client) only ever sees these names plus the account's
// own label/folder ids.

export const INBOX = "INBOX";
export const SENT = "SENT";
export const DRAFT = "DRAFT";
export const TRASH = "TRASH";
export const SPAM = "SPAM";
export const UNREAD = "UNREAD";
export const STARRED = "STARRED";
export const IMPORTANT = "IMPORTANT";

/** Category tabs. A provider without categories leaves them off (everything is "important"). */
export const CATEGORY_PROMOTIONS = "CATEGORY_PROMOTIONS";
export const CATEGORY_UPDATES = "CATEGORY_UPDATES";
export const CATEGORY_SOCIAL = "CATEGORY_SOCIAL";
export const CATEGORY_FORUMS = "CATEGORY_FORUMS";

/** Every built-in name above: never one of the user's own labels/folders. */
export const SYSTEM_LABELS: ReadonlySet<string> = new Set([
  INBOX, SENT, DRAFT, TRASH, SPAM, UNREAD, STARRED, IMPORTANT,
  CATEGORY_PROMOTIONS, CATEGORY_UPDATES, CATEGORY_SOCIAL, CATEGORY_FORUMS, "CATEGORY_PERSONAL",
]);

export function categoryFrom(labels: string[]): Category {
  if (labels.includes(CATEGORY_PROMOTIONS)) return "newsletters";
  if (labels.includes(CATEGORY_UPDATES)) return "notifications";
  if (labels.includes(CATEGORY_SOCIAL) || labels.includes(CATEGORY_FORUMS)) return "other";
  return "important";
}
