import type { Invite } from "../calendar/invite";

export type Provider = "gmail" | "outlook" | "imap";

export type Account = {
  id: string;
  name: string;
  /** What the user calls this account in Kite ("Work"); local only. */
  nickname?: string | null;
  email: string;
  provider: Provider;
  color: string;
  /** The picture to show: the user's pick (`face`), else the provider's photo, or null for the initials avatar. */
  photo?: string | null;
  /** The picture the user picked in Settings → Accounts (AccountFaceChoice in lib/mail/account-face.ts); null = the provider's. */
  face?: string | null;
  /** The provider's photo from Kite's avatar cache, shown when `face` is null. */
  providerPhoto?: string | null;
  /** The sign-in allows looking up sender photos in Google contacts (undefined: the provider has none). */
  contactPhotos?: boolean;
  /** The account has events Kite can show and add to (undefined: none): its calendar's sign-in allows it, or the mail calendar. */
  calendar?: boolean;
  /** No provider calendar Kite can reach: events come from invites in its mail, and ones added in Kite stay in Kite. */
  mailCalendar?: boolean;
  /** Why reconnecting would help (an optional permission the sign-in lacks), or null. */
  reconnectFor?: string | null;
  /** The mail service behind the account when the provider name says too little ("iCloud Mail" for IMAP); see `serviceName`. */
  service?: string | null;
  /** The provider whose words and nesting this account's labels follow, when not its own (Gmail over IMAP: "gmail"); see `accountSpec`. */
  organisesLike?: Provider | null;
  /** Gmail over IMAP: whether its optional Google sign-in (calendar, contact photos, profile photo) is connected; undefined elsewhere. */
  googleLink?: boolean;
};

/** The name Kite shows for an account: the user's nickname, else the Google name, else the address. */
export function accountName(account: Pick<Account, "nickname" | "name" | "email">) {
  return account.nickname?.trim() || account.name?.trim() || account.email;
}

export type Contact = { name: string; email: string };

export type Attachment = {
  name: string;
  /** Human size, e.g. "84 KB". */
  size: string;
  kind: "pdf" | "doc" | "sheet" | "image" | "other";
  /** Gmail part id inside the message (stable, unlike attachment ids). Absent for demo mail. */
  partId?: string;
  mimeType?: string;
  bytes?: number;
  /** Content-ID without brackets, for images the HTML shows as cid:… */
  contentId?: string;
  /** Shown inside the body, so not listed as a file. */
  inline?: boolean;
};

/** One file in the All files view: an attachment plus where it came from. */
export type FileItem = Attachment & {
  accountId: string;
  threadId: string;
  messageId: string;
  subject: string;
  from: Contact;
  date: string;
};

export type Message = {
  id: string;
  from: Contact;
  to: Contact[];
  cc?: Contact[];
  /** Reply-To header, when the sender asked for replies to go elsewhere. */
  replyTo?: Contact[];
  /** An unsent draft (Gmail's DRAFT label). */
  draft?: boolean;
  date: string;
  /** Plain-text paragraphs. Empty until a live message's full body is loaded. */
  body: string[];
  /** Sanitised-at-render HTML body for live messages. */
  html?: string;
  snippet?: string;
  /** New text only (quotes and signature removed), for list rows. Set when the body is stored. */
  preview?: string;
  messageIdHeader?: string;
  /** In-Reply-To header: the Message-ID this one answers. */
  inReplyTo?: string;
  references?: string;
  /** Gmail's UNREAD label on this message (the label is per message; Thread.unread is any of them). */
  unread?: boolean;
  attachments?: Attachment[];
  trackersBlocked?: string[];
  remoteImages?: boolean;
  /** Whether the sender's domain vouched for this message (Gmail's Authentication-Results: DMARC, else aligned DKIM). */
  auth?: { result: "pass" | "fail" | "none"; domain?: string };
  /** The Gmail thread this message is in (differs from Thread.remoteId once threads are merged). */
  remoteThread?: string;
  /** Gmail labels on this message (stored copy; lists leave them out). */
  labels?: string[];
  /** This message's Subject header. */
  subject?: string;
  /** Carries a meeting invite, update or answer (a calendar part, or an Outlook event message). */
  calendar?: boolean;
  /** The invite itself, added when the conversation is opened (lib/calendar/invite.ts). */
  invite?: Invite;
};

export type Mailbox = "inbox" | "screener" | "snoozed" | "scheduled" | "starred" | "sent" | "drafts" | "archive" | "trash";

export type Category = "important" | "other" | "newsletters" | "notifications";

/** An amount an automation read from a conversation (server/collections.ts amountsByThread). */
export type ThreadAmount = { value: number; currency: string };

export type Thread = {
  id: string;
  accountId: string;
  subject: string;
  messages: Message[];
  mailbox: Mailbox;
  category: Category;
  /** From a mailing list (List-Unsubscribe): it goes on the inbox's Everything else side (lib/mail/sides.ts). */
  list?: boolean;
  /** Inbox lists: the amount an automation collected from it. */
  amount?: ThreadAmount;
  unread: boolean;
  starred: boolean;
  snoozedUntil?: string;
  /** The user's own labels/folders (provider ids; built-in mailboxes left out). Demo labels use their name. */
  labels?: string[];
  /** Provider thread id for live accounts; absent for demo threads. */
  remoteId?: string;
  /** False while only list metadata has been fetched. */
  loaded?: boolean;
  /** Set when a follow-up reminder fired because nobody replied. */
  reminder?: { sentAt: string };
  /** Set for messages waiting in the send-later queue. */
  scheduled?: { id: string; sendAt: string; remindDays: number | null };
  /** Local overrides (see lib/mail/overrides.ts), applied on the client. */
  pinned?: boolean;
  muted?: boolean;
  note?: string;
  /** Gmail's subject when the user renamed the thread locally. */
  originalSubject?: string;
  /** The latest local split or merge that made this conversation (undoable). */
  regroup?: Regroup;
};

/** A local split or merge. Gmail's threading is untouched. */
export type Regroup = {
  id: string;
  kind: "split" | "merge";
  /** Split: the conversation it came from. Merge: the one joined into this. */
  sourceId: string;
  sourceSubject: string;
  createdAt: string;
};
