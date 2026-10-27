import type { Category, Thread } from "./types";

// The inbox's tabs follow the provider's own sorting, never a guess of Kite's: Gmail's Primary,
// Promotions, Social (with Forums) and Updates, Outlook's Focused and Other. A tab shows only when
// some inbox mail is in it, so tabs the user turned off at the provider (their mail stays in
// Primary) don't appear, and accounts without tabs (plain IMAP) get one list.

export type InboxSide = Category;

export type InboxTab = { id: InboxSide; label: string };

/** Gmail's order. */
const ORDER: InboxSide[] = ["important", "newsletters", "other", "notifications"];

const GMAIL: Record<InboxSide, string> = { important: "Primary", newsletters: "Promotions", other: "Social", notifications: "Updates" };
/** Outlook's Focused Inbox: its Other is stored as Updates (lib/mail/mailboxes.ts). */
const OUTLOOK: Partial<Record<InboxSide, string>> = { important: "Focused", notifications: "Other" };

/** Which tab a conversation is in. */
export const sideOf = (thread: Pick<Thread, "category">): InboxSide => thread.category;

/**
 * The tabs to show: Primary, then each tab some inbox mail is in. `focusedInbox`: every account in
 * view is Outlook, so the tabs use its words.
 */
export function inboxTabs(present: Iterable<InboxSide>, focusedInbox: boolean): InboxTab[] {
  const has = new Set(present);
  return ORDER.filter((id) => id === "important" || has.has(id)).map((id) => ({
    id,
    label: (focusedInbox ? OUTLOOK[id] : undefined) ?? GMAIL[id],
  }));
}
