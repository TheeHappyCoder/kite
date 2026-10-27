import "server-only";

import { attachmentKind, inferMimeType, isInlineIn } from "@/lib/mail/attachments";
import { CATEGORY_UPDATES, categoryFrom, DRAFT, STARRED, SYSTEM_LABELS, UNREAD } from "@/lib/mail/mailboxes";
import { senderAuth } from "@/lib/mail/privacy";
import type { Attachment, Contact, Message } from "@/lib/mail/types";
import type { AccountRow } from "../../db";
import { formatSize, parseUnsubscribe, stripTrackers, toParagraphs } from "../../mail/parse";
import type { ThreadRecord } from "../../mail/types";
import { folderLabel, type Folders } from "./folders";

// Graph's message format to Kite's: the folder becomes a mailbox label (folders.ts), categories
// are tags by name, isRead and the flag become UNREAD and STARRED, Focused Inbox's "Other" becomes the Updates tab, and the
// headers Graph keeps (References, List-Unsubscribe, Authentication-Results) are read as Gmail's are.

export type GraphAddress = { emailAddress?: { name?: string | null; address?: string | null } };
type GraphAttachment = { id: string; name?: string; contentType?: string; size?: number; isInline?: boolean; contentId?: string | null };
export type GraphMessage = {
  /** Set by Graph on derived types: meeting requests, updates, cancellations and answers are event messages. */
  "@odata.type"?: string;
  id: string;
  conversationId: string;
  parentFolderId?: string;
  subject?: string | null;
  bodyPreview?: string;
  receivedDateTime?: string;
  sentDateTime?: string | null;
  lastModifiedDateTime?: string;
  isRead?: boolean;
  isDraft?: boolean;
  flag?: { flagStatus?: string };
  categories?: string[];
  from?: GraphAddress | null;
  sender?: GraphAddress | null;
  toRecipients?: GraphAddress[];
  ccRecipients?: GraphAddress[];
  bccRecipients?: GraphAddress[];
  replyTo?: GraphAddress[];
  internetMessageId?: string | null;
  internetMessageHeaders?: { name: string; value: string }[] | null;
  inferenceClassification?: "focused" | "other";
  hasAttachments?: boolean;
  body?: { contentType?: "html" | "text"; content?: string };
  attachments?: GraphAttachment[];
};

/** Fields for lists and threads (no bodies). Headers carry References and List-Unsubscribe. */
export const META_FIELDS = [
  "id",
  "conversationId",
  "parentFolderId",
  "subject",
  "bodyPreview",
  "receivedDateTime",
  "sentDateTime",
  "lastModifiedDateTime",
  "isRead",
  "isDraft",
  "flag",
  "categories",
  "from",
  "sender",
  "toRecipients",
  "ccRecipients",
  "bccRecipients",
  "replyTo",
  "internetMessageId",
  "internetMessageHeaders",
  "inferenceClassification",
  "hasAttachments",
].join(",");
export const FULL_FIELDS = `${META_FIELDS},body`;
/** Attachments without their bytes; contentId lives on file attachments only. */
export const ATTACHMENT_EXPAND = "attachments($select=id,name,contentType,size,isInline,microsoft.graph.fileAttachment/contentId)";

function contact(address: GraphAddress | null | undefined): Contact | null {
  const email = address?.emailAddress?.address?.trim();
  if (!email) return null;
  return { name: address?.emailAddress?.name?.trim() || email.split("@")[0] || email, email };
}

export function contacts(list: GraphAddress[] | undefined): Contact[] {
  return (list ?? []).map(contact).filter((c): c is Contact => !!c);
}

function header(message: GraphMessage, name: string) {
  return message.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function labelsOf(message: GraphMessage, f: Folders): string[] {
  const labels: string[] = [];
  const folder = folderLabel(f, message.parentFolderId);
  if (folder) labels.push(folder);
  if (message.isDraft && !labels.includes(DRAFT)) labels.push(DRAFT);
  if (message.isRead === false && !message.isDraft) labels.push(UNREAD);
  if (message.flag?.flagStatus === "flagged") labels.push(STARRED);
  if (message.inferenceClassification === "other") labels.push(CATEGORY_UPDATES);
  labels.push(...categoriesOf(message));
  return labels;
}

/** The message's categories: tags keyed by name (one named like a mailbox, "INBOX", can't be told apart, so it's left out). */
function categoriesOf(message: Pick<GraphMessage, "categories">) {
  return (message.categories ?? []).filter((c) => c.trim() && !SYSTEM_LABELS.has(c));
}

function toAttachment(a: GraphAttachment, html: string | null): Attachment {
  const name = a.name || "attachment";
  const attachment: Attachment = {
    name,
    size: formatSize(a.size ?? 0),
    kind: attachmentKind(name, a.contentType),
    partId: a.id,
    mimeType: inferMimeType(name, a.contentType),
    bytes: a.size ?? 0,
    contentId: a.contentId?.replace(/^<|>$/g, "").trim() || undefined,
  };
  return (a.isInline && attachment.contentId) || (html && isInlineIn(html, attachment)) ? { ...attachment, inline: true } : attachment;
}

/** A meeting request, update, cancellation or answer (Graph's eventMessage types, or the calendar message class). */
function isEventMessage(message: GraphMessage) {
  return /eventMessage/i.test(message["@odata.type"] ?? "") || /calendarmessage/i.test(header(message, "Content-Class"));
}

export function toMessage(message: GraphMessage, f: Folders, full: boolean): Message {
  const from = contact(message.from) ?? contact(message.sender) ?? { name: "unknown", email: "unknown" };
  const cc = contacts(message.ccRecipients);
  const replyTo = contacts(message.replyTo);
  const references = header(message, "References");
  const base: Message = {
    id: message.id,
    from,
    to: contacts(message.toRecipients),
    cc: cc.length ? cc : undefined,
    replyTo: replyTo.length ? replyTo : undefined,
    draft: message.isDraft || undefined,
    date: (message.isDraft ? message.lastModifiedDateTime : (message.receivedDateTime ?? message.sentDateTime)) ?? new Date().toISOString(),
    body: [],
    snippet: message.bodyPreview ?? "",
    messageIdHeader: message.internetMessageId || undefined,
    inReplyTo: header(message, "In-Reply-To") || undefined,
    references: references || undefined,
    unread: (message.isRead === false && !message.isDraft) || undefined,
    remoteThread: message.conversationId,
    labels: labelsOf(message, f),
    subject: message.subject || undefined,
  };
  if (isEventMessage(message)) base.calendar = true;
  if (!full) return base;

  const authResults = (message.internetMessageHeaders ?? []).filter((h) => h.name.toLowerCase() === "authentication-results").map((h) => h.value);
  if (authResults.length) base.auth = senderAuth(authResults, base.from.email);
  const content = message.body?.content ?? "";
  const html = message.body?.contentType === "html" && content ? content : null;
  const attachments = (message.attachments ?? []).map((a) => toAttachment(a, html));
  if (html) {
    const stripped = stripTrackers(html);
    return { ...base, html: stripped.html, body: [], trackersBlocked: stripped.trackers, remoteImages: stripped.remoteImages, attachments };
  }
  return { ...base, body: toParagraphs(content || base.snippet || ""), attachments };
}

/** One Outlook conversation (its messages from every folder) in Kite's model. */
export function toRecord(account: AccountRow, conversationId: string, raw: GraphMessage[], f: Folders, full: boolean): ThreadRecord {
  const ordered = [...raw].sort((a, b) => (a.receivedDateTime ?? "").localeCompare(b.receivedDateTime ?? ""));
  const messages = ordered.map((m) => toMessage(m, f, full));
  const labels = [...new Set(messages.flatMap((m) => m.labels ?? []))];
  const me = account.email.toLowerCase();
  const externalIndex = messages.findLastIndex((m) => m.from.email.toLowerCase() !== me);
  const recipients = messages
    .filter((m) => m.from.email.toLowerCase() === me)
    .flatMap((m) => [...m.to, ...(m.cc ?? [])])
    .map((c) => c.email.toLowerCase());
  const lastExternal = externalIndex >= 0 ? ordered[externalIndex] : null;
  return {
    thread: {
      id: `${account.id}:${conversationId}`,
      remoteId: conversationId,
      accountId: account.id,
      subject: ordered[0]?.subject || "(no subject)",
      messages,
      mailbox: "inbox",
      category: categoryFrom(messages.at(-1)?.labels ?? []),
      unread: labels.includes(UNREAD),
      starred: labels.includes(STARRED),
      loaded: full,
    },
    labels,
    sender: externalIndex >= 0 ? messages[externalIndex].from : null,
    unsubscribe: lastExternal ? parseUnsubscribe(header(lastExternal, "List-Unsubscribe"), header(lastExternal, "List-Unsubscribe-Post")) : null,
    recipients: [...new Set(recipients)],
  };
}
