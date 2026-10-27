import "server-only";

import { attachmentKind, inferMimeType, isInlineIn } from "@/lib/mail/attachments";
import { isCalendarFile } from "@/lib/calendar/invite";
import { categoryFrom, DRAFT, STARRED, UNREAD } from "@/lib/mail/mailboxes";
import { senderAuth } from "@/lib/mail/privacy";
import type { Attachment, Message } from "@/lib/mail/types";
import type { AccountRow } from "../../db";
import { decodeEntities, formatSize, parseAddress, parseAddressList, parseUnsubscribe, stripTrackers, toParagraphs } from "../../mail/parse";
import type { ThreadRecord } from "../../mail/types";

// Gmail's message format to Kite's. Gmail's label ids are already Kite's mailbox names
// (lib/mail/mailboxes.ts), so labels pass through unchanged.

type Header = { name: string; value: string };
export type Part = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Header[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: Part[];
};
export type GmailMessage = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: Part;
};
export type GmailThread = { id: string; messages?: GmailMessage[] };

export function header(message: GmailMessage, name: string) {
  return message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decode(data: string) {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

export function findBody(part: Part | undefined, mime: string): string | null {
  if (!part) return null;
  if (part.mimeType === mime && part.body?.data && !part.filename) return decode(part.body.data);
  for (const child of part.parts ?? []) {
    const found = findBody(child, mime);
    if (found) return found;
  }
  return null;
}

export function findPart(part: Part | undefined, match: (p: Part) => boolean): Part | null {
  if (!part) return null;
  if (match(part)) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, match);
    if (found) return found;
  }
  return null;
}

function partHeader(part: Part, name: string) {
  return part.headers?.find((h) => h.name.toLowerCase() === name)?.value ?? "";
}

/** Files in a message, including images the HTML shows inline by Content-ID. */
export function collectAttachments(part: Part | undefined, out: Attachment[] = []) {
  if (!part) return out;
  const contentId = partHeader(part, "content-id").replace(/^<|>$/g, "").trim() || undefined;
  const hasBytes = !!(part.body?.attachmentId || part.body?.data);
  // An invite's text/calendar part has no file name: kept as a hidden "invite.ics" for the invite card.
  const calendarPart = !part.filename && part.mimeType?.toLowerCase() === "text/calendar";
  const named = !!part.filename || calendarPart || (!!contentId && !part.mimeType?.startsWith("text/"));
  if (hasBytes && named && !part.parts?.length) {
    const name = part.filename || (calendarPart ? "invite.ics" : `${contentId?.split("@")[0] || "image"}.${part.mimeType?.split("/")[1] ?? "bin"}`);
    out.push({
      name,
      size: formatSize(part.body?.size ?? 0),
      kind: attachmentKind(name, part.mimeType),
      partId: part.partId,
      mimeType: inferMimeType(name, part.mimeType),
      bytes: part.body?.size ?? 0,
      contentId,
      ...(calendarPart ? { inline: true } : {}),
    });
  }
  for (const child of part.parts ?? []) collectAttachments(child, out);
  return out;
}

export function toMessage(message: GmailMessage, full: boolean): Message {
  const cc = parseAddressList(header(message, "Cc"));
  const replyTo = parseAddressList(header(message, "Reply-To"));
  const base: Message = {
    id: message.id,
    from: parseAddress(header(message, "From") || "unknown"),
    to: parseAddressList(header(message, "To")),
    cc: cc.length ? cc : undefined,
    replyTo: replyTo.length ? replyTo : undefined,
    draft: message.labelIds?.includes(DRAFT) || undefined,
    date: new Date(Number(message.internalDate ?? Date.now())).toISOString(),
    body: [],
    snippet: decodeEntities(message.snippet ?? ""),
    messageIdHeader: header(message, "Message-ID") || undefined,
    inReplyTo: header(message, "In-Reply-To") || undefined,
    references: header(message, "References") || undefined,
    unread: message.labelIds?.includes(UNREAD) || undefined,
    remoteThread: message.threadId,
    labels: message.labelIds ?? [],
    subject: header(message, "Subject") || undefined,
  };
  if (!full) return base;

  const authResults = (message.payload?.headers ?? []).filter((h) => h.name.toLowerCase() === "authentication-results").map((h) => h.value);
  if (authResults.length) base.auth = senderAuth(authResults, base.from.email);
  const html = findBody(message.payload, "text/html");
  const text = findBody(message.payload, "text/plain");
  const attachments = collectAttachments(message.payload).map((a) => (html && isInlineIn(html, a) ? { ...a, inline: true } : a));
  if (attachments.some(isCalendarFile)) base.calendar = true;
  if (html) {
    const stripped = stripTrackers(html);
    return {
      ...base,
      html: stripped.html,
      body: text ? toParagraphs(text) : [],
      trackersBlocked: stripped.trackers,
      remoteImages: stripped.remoteImages,
      attachments,
    };
  }
  return { ...base, body: toParagraphs(text ?? base.snippet ?? ""), attachments };
}

/** Converts a Gmail thread into Kite's model plus the fields the local store indexes. */
export function toRecord(account: AccountRow, raw: GmailThread, full: boolean): ThreadRecord {
  const messages = raw.messages ?? [];
  const labels = [...new Set(messages.flatMap((m) => m.labelIds ?? []))];
  const first = messages[0];
  const converted = messages.map((m) => toMessage(m, full));
  const me = account.email.toLowerCase();
  const external = [...converted].reverse().find((m) => m.from.email.toLowerCase() !== me);
  const lastExternalRaw = [...messages].reverse().find((m) => parseAddress(header(m, "From")).email.toLowerCase() !== me);
  const recipients = messages
    .filter((m) => parseAddress(header(m, "From")).email.toLowerCase() === me)
    .flatMap((m) => [...parseAddressList(header(m, "To")), ...parseAddressList(header(m, "Cc"))])
    .map((c) => c.email.toLowerCase());

  return {
    thread: {
      id: `${account.id}:${raw.id}`,
      remoteId: raw.id,
      accountId: account.id,
      subject: (first && header(first, "Subject")) || "(no subject)",
      messages: converted,
      mailbox: "inbox",
      category: categoryFrom(messages[messages.length - 1]?.labelIds ?? []),
      unread: labels.includes(UNREAD),
      starred: labels.includes(STARRED),
      loaded: full,
    },
    labels,
    sender: external?.from ?? null,
    unsubscribe: lastExternalRaw ? parseUnsubscribe(header(lastExternalRaw, "List-Unsubscribe"), header(lastExternalRaw, "List-Unsubscribe-Post")) : null,
    recipients: [...new Set(recipients)],
  };
}
