import "server-only";

import type { Design } from "@/lib/design/spec";
import type { AttachmentRef, Quote, Recipient } from "@/lib/mail/compose";
import type { LabelKind } from "@/lib/mail/providers";
import type { SearchTerm } from "@/lib/mail/search";
import type { Attachment, Contact, Thread } from "@/lib/mail/types";

// Provider-neutral shapes the adapters (server/providers/*) produce and take. Labels in them are
// Kite's names (lib/mail/mailboxes.ts) plus the account's own label/folder ids.

export type Unsubscribe = { http?: string; mailto?: string; oneClick: boolean };

/** One provider thread in Kite's model, plus the fields the local store indexes. */
export type ThreadRecord = {
  thread: Thread;
  labels: string[];
  sender: Contact | null;
  unsubscribe: Unsubscribe | null;
  recipients: string[];
};

/** A change to labels on threads or messages, in Kite's names (adding TRASH trashes, removing INBOX archives). */
export type LabelChange = { add: string[]; remove: string[] };

/** Lists of threads (or messages) the engine asks a provider for. Each adapter translates them to its own query. */
export type ThreadList =
  | { kind: "mailbox"; mailbox: "inbox" | "sent" | "starred" | "drafts" }
  /** Everything from the last `days` days, spam and trash left out. */
  | { kind: "recent"; days: number }
  /** Conversations with attachments, spam and trash left out. */
  | { kind: "attachments" }
  | { kind: "label"; id: string }
  | { kind: "search"; terms: SearchTerm[] }
  /** Inbox mail from one sender (Cleanup's "Archive all"). */
  | { kind: "inboxFrom"; email: string };

export type OutgoingMessage = {
  to: Recipient[];
  cc?: Recipient[];
  bcc?: Recipient[];
  subject: string;
  /** Markup (lib/mail/body.ts). */
  body: string;
  /** The provider thread a reply belongs to. */
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** Snapshot of the signature when the message was written (scheduled sends keep it). */
  signature?: Design;
  /** A designed email: rendered instead of `body`. */
  design?: Design;
  attachments?: AttachmentRef[];
  /** The message being replied to or forwarded; its content is added when sending. */
  quote?: Quote;
  /**
   * Undo send: held for a few seconds as a scheduled row. Held rows stay out of Scheduled and
   * Today, and the provider draft (kept so Undo can reopen it) is removed once the message goes.
   */
  held?: { draftId?: string };
};

export type Sent = { id: string; threadId: string };

/** A draft as saved at the provider. Some providers give each save a new id. */
export type SavedDraft = { id: string; messageId: string; threadId: string };

/** A draft read back from the provider (written in another app). */
export type DraftContent = {
  messageId: string;
  threadId: string;
  to: Contact[];
  cc: Contact[];
  bcc: Contact[];
  subject: string;
  html: string | null;
  text: string | null;
  inReplyTo?: string;
  references?: string;
  /** Attached files (inline images left out), addressed by part id. */
  files: Attachment[];
};

/** One of the user's own labels/folders as an adapter reports it. */
/** A user label as a provider reports it. `kind`: a tag stays with the message, a folder is where it is (lib/mail/providers.ts). */
export type RemoteLabel = { id: string; name: string; kind: LabelKind; color: string | null; hidden: boolean };

export type AttachmentFile = { name: string; mimeType: string; data: Buffer };
