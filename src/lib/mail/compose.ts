import * as z from "zod";
import { REMOTE_ID } from "./threads";
import { Design } from "../design/spec";
import type { Attachment, Contact, Message } from "./types";
import { formatBytes } from "@/lib/format";

// What the compose window edits. The same record is saved as a Gmail draft, sent, or
// queued for later, so it's plain validated data. The body is markup (see body.ts), or a
// kite-design/1 document in `design` for a designed email.

export const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const Recipient = z.object({
  name: z.string().max(200).optional(),
  email: z.string().regex(EMAIL, "That doesn't look like an email address"),
});
export type Recipient = z.infer<typeof Recipient>;

const Recipients = z.array(Recipient).max(100).default([]);

const MESSAGE_ID = z.string().regex(REMOTE_ID);

export const AttachmentRef = z.discriminatedUnion("type", [
  /** A file uploaded from this computer (data/uploads). */
  z.object({ type: z.literal("upload"), id: z.string().regex(/^[0-9a-f]{32}$/), name: z.string().min(1).max(255), mimeType: z.string().max(200), bytes: z.number().int().min(0) }),
  /**
   * A file in a message already in the mailbox (forwarding, or picked from your files), found
   * again by part id. `accountId` is the account holding that message; absent means the draft's.
   */
  z.object({ type: z.literal("message"), accountId: z.string().min(1).max(200).optional(), messageId: MESSAGE_ID, partId: z.string().regex(/^[0-9]+(\.[0-9]+)*$/), name: z.string().min(1).max(255), mimeType: z.string().max(200), bytes: z.number().int().min(0) }),
]);
export type AttachmentRef = z.infer<typeof AttachmentRef>;

/** The earlier message a reply quotes or a forward carries. Its content is added when sending. */
export const Quote = z.object({
  mode: z.enum(["reply", "forward"]),
  messageId: MESSAGE_ID,
  from: z.object({ name: z.string(), email: z.string() }),
  date: z.string(),
  subject: z.string().max(1000).default(""),
  to: z.array(z.object({ name: z.string(), email: z.string() })).max(100).default([]),
  snippet: z.string().max(400).default(""),
});
export type Quote = z.infer<typeof Quote>;

export const ComposeDraft = z.object({
  accountId: z.string(),
  to: Recipients,
  cc: Recipients,
  bcc: Recipients,
  subject: z.string().max(1000).refine((s) => !/[\r\n]/.test(s), "No line breaks in the subject").default(""),
  /** Markup (see body.ts). */
  body: z.string().max(200_000).default(""),
  /** A designed email: sent instead of `body` (the signature and any quote still follow). */
  design: Design.optional(),
  /** Add the account's signature. */
  signature: z.boolean().default(true),
  attachments: z.array(AttachmentRef).max(50).default([]),
  threadId: z.string().regex(REMOTE_ID).optional(),
  inReplyTo: z.string().max(1000).refine((s) => !/[\r\n]/.test(s)).optional(),
  references: z.string().max(8000).refine((s) => !/[\r\n]/.test(s)).optional(),
  quote: Quote.optional(),
  /** The Gmail draft this was saved as. */
  draftId: z.string().regex(REMOTE_ID).optional(),
  /**
   * Send separately: each person in To gets their own copy (no Cc or Bcc), with `{first_name}` and
   * `{name}` in the body filled for them.
   */
  separately: z.boolean().optional(),
});
export type ComposeDraft = z.infer<typeof ComposeDraft>;

export function emptyDraft(accountId: string): ComposeDraft {
  return { accountId, to: [], cc: [], bcc: [], subject: "", body: "", signature: true, attachments: [] };
}

/** Nothing worth keeping as a draft. */
export function isBlank(draft: Pick<ComposeDraft, "to" | "cc" | "bcc" | "subject" | "body" | "attachments" | "design">) {
  return !draft.to.length && !draft.cc.length && !draft.bcc.length && !draft.subject.trim() && !draft.body.trim() && !draft.attachments.length && !draft.design;
}

// ---------------------------------------------------------------------------
// Size limits
// ---------------------------------------------------------------------------

/** Gmail refuses messages over 25 MB, measured after files are encoded for sending. */
export const MESSAGE_LIMIT_BYTES = 25 * 1024 * 1024;
/** Encoding grows files by about a third, which leaves this much for the files themselves. */
export const ATTACHMENT_LIMIT_BYTES = 18 * 1024 * 1024;

/** A plain explanation when adding a file would push the message over Gmail's limit. */
export function attachmentLimitError(name: string, bytes: number, alreadyAttached: number) {
  if (bytes > ATTACHMENT_LIMIT_BYTES) {
    return `${name} is ${formatBytes(bytes)}. A message can carry about ${formatBytes(ATTACHMENT_LIMIT_BYTES)} of files (25 MB once they're encoded for sending, what most mail services accept). Share it as a link instead, from Google Drive, OneDrive or Dropbox.`;
  }
  if (alreadyAttached + bytes > ATTACHMENT_LIMIT_BYTES) {
    const left = Math.max(0, ATTACHMENT_LIMIT_BYTES - alreadyAttached);
    return `${name} doesn't fit: this message has room for ${formatBytes(left)} more (the limit is about ${formatBytes(ATTACHMENT_LIMIT_BYTES)} of files). Send it in a second message, or share it as a link.`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

/** Parses pasted or typed text: "Ann <ann@x.com>, bob@y.com; …". Invalid pieces are returned separately. */
export function parseRecipients(text: string): { valid: Recipient[]; invalid: string[] } {
  const valid: Recipient[] = [];
  const invalid: string[] = [];
  for (const piece of text.split(/[,;\n](?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const raw = piece.trim();
    if (!raw) continue;
    const match = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    const email = (match ? match[2] : raw).trim().replace(/^mailto:/i, "");
    const name = match?.[1].trim();
    if (EMAIL.test(email)) valid.push(name ? { name, email } : { email });
    else invalid.push(raw);
  }
  return { valid, invalid };
}

function dedupe(list: Recipient[], exclude: Set<string>) {
  const seen = new Set(exclude);
  return list.filter((r) => {
    const key = r.email.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const toRecipient = (c: Contact): Recipient => (c.name && c.name !== c.email && c.name !== c.email.split("@")[0] ? { name: c.name, email: c.email } : { email: c.email });

// ---------------------------------------------------------------------------
// Replies and forwards
// ---------------------------------------------------------------------------

export type ReplyMode = "reply" | "replyAll" | "forward";

/** The headers a reply needs from the message it answers. */
export type ReplySource = Pick<Message, "id" | "from" | "to" | "cc" | "replyTo" | "date" | "snippet" | "messageIdHeader" | "references" | "attachments">;

function replySubject(subject: string, mode: ReplyMode) {
  if (mode === "forward") return /^(fwd?|fw):/i.test(subject) ? subject : `Fwd: ${subject}`;
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * A prefilled draft for replying to, replying to all of, or forwarding a message. `me` is
 * the account's address: it's never added as a recipient, and replying to your own message
 * goes to the people you sent it to.
 */
export function replyDraft({
  mode,
  message,
  subject,
  accountId,
  me,
  threadId,
}: {
  mode: ReplyMode;
  message: ReplySource;
  subject: string;
  accountId: string;
  me: string;
  threadId?: string;
}): ComposeDraft {
  const self = me.toLowerCase();
  const exclude = new Set([self]);
  const fromMe = message.from.email.toLowerCase() === self;
  const primary = (fromMe ? message.to : message.replyTo?.length ? message.replyTo : [message.from]).map(toRecipient);
  let to: Recipient[] = [];
  let cc: Recipient[] = [];
  if (mode === "reply") to = dedupe(primary, exclude);
  if (mode === "replyAll") {
    to = dedupe(fromMe ? primary : [...primary, ...message.to.map(toRecipient)], exclude);
    cc = dedupe((message.cc ?? []).map(toRecipient), new Set([...exclude, ...to.map((r) => r.email.toLowerCase())]));
  }
  return {
    ...emptyDraft(accountId),
    to,
    cc,
    subject: replySubject(subject, mode),
    threadId,
    inReplyTo: message.messageIdHeader,
    // The send adds In-Reply-To to the end of References.
    references: message.references,
    attachments:
      mode === "forward"
        ? (message.attachments ?? []).filter((a): a is Attachment & { partId: string } => !a.inline && !!a.partId).map((a) => ({
            type: "message" as const,
            messageId: message.id,
            partId: a.partId,
            name: a.name,
            mimeType: a.mimeType ?? "application/octet-stream",
            bytes: a.bytes ?? 0,
          }))
        : [],
    quote: {
      mode: mode === "forward" ? "forward" : "reply",
      messageId: message.id,
      from: message.from,
      date: message.date,
      subject,
      to: message.to,
      snippet: (message.snippet ?? "").slice(0, 400),
    },
  };
}

/** A queued message as an editable draft. */
export function draftFromPayload(accountId: string, message: Record<string, unknown>): ComposeDraft {
  const parsed = ComposeDraft.safeParse({
    ...message,
    accountId,
    signature: !!message.signature,
  });
  return parsed.success ? parsed.data : emptyDraft(accountId);
}
