import "server-only";

import type { SearchObject } from "imapflow";
import { CATEGORY_FORUMS, CATEGORY_PROMOTIONS, CATEGORY_SOCIAL, CATEGORY_UPDATES, DRAFT, IMPORTANT, INBOX, SENT } from "@/lib/mail/mailboxes";
import { presetOf } from "./servers";

// Gmail over IMAP (an app password instead of the Gmail API, so no CASA review). Gmail keeps every
// message once, in All Mail (plus Trash and Spam), and shows its labels as folders: reading those
// would repeat each message per label. So in Gmail mode (preset "gmail", set when the server speaks
// X-GM-EXT-1) Kite reads only All Mail, Trash and Spam (`Folders.scan`) and takes the rest from
// Gmail's extensions: X-GM-LABELS are the message's labels (tags), X-GM-THRID its conversation,
// X-GM-RAW Gmail's own search for lists. Label changes are STOREs of X-GM-LABELS, so archiving is
// removing \Inbox, exactly like Gmail.

/** Whether an IMAP account is Gmail (set at sign-in from the server's capabilities). */
export const isGmail = (accountId: string) => presetOf(accountId) === "gmail";

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** A Gmail label's Kite id (a tag), from its name as IMAP writes it ("Work/Clients"). */
export const labelId = (name: string) => `g-${encode(name)}`;
export const labelOf = (id: string) => (id.startsWith("g-") ? Buffer.from(id.slice(2), "base64url").toString("utf8") : null);

/** Gmail's system labels as Kite's mailboxes. \Starred isn't one: Gmail mirrors it as the \Flagged flag, which Kite reads. */
const SYSTEM: Record<string, string> = {
  "\\Inbox": INBOX,
  "\\Sent": SENT,
  "\\Draft": DRAFT,
  "\\Important": IMPORTANT,
};
const FROM_KITE = Object.fromEntries(Object.entries(SYSTEM).map(([gmail, kite]) => [kite, gmail]));

/** Kite labels for a message's X-GM-LABELS: system ones as mailboxes, the user's as tags; other system labels are dropped. */
export function kiteLabels(labels: string[]): string[] {
  return labels.flatMap((label) => (SYSTEM[label] ? [SYSTEM[label]] : label.startsWith("\\") ? [] : [labelId(label)]));
}

/** The X-GM-LABELS value for a Kite label, or null when it isn't one (UNREAD, STARRED, TRASH: flags and moves). */
export function gmailLabel(id: string): string | null {
  return FROM_KITE[id] ?? labelOf(id);
}

/** X-GM-RAW for Kite's built-in lists. */
export const RAW = {
  inbox: "in:inbox",
  sent: "in:sent",
  drafts: "in:drafts",
  starred: "is:starred",
} as const;

/** A search in All Mail for one label. */
export const withLabel = (name: string): SearchObject => ({ labels: { has: [name] } });

/** Gmail's Inbox tabs by their `category:` name, as Kite's category labels (Primary has none). */
export const TABS: Record<string, string> = {
  social: CATEGORY_SOCIAL,
  promotions: CATEGORY_PROMOTIONS,
  updates: CATEGORY_UPDATES,
  forums: CATEGORY_FORUMS,
};

/** How often the whole Inbox is sorted into tabs again (new mail is sorted as it arrives). */
export const TABS_EVERY_MS = 30 * 60_000;
