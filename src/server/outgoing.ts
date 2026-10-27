import "server-only";

import { format } from "date-fns";
import { compileHtml, compileText, escapeHtml, FONT_STACKS } from "@/lib/design/compile";
import { assetId, designAssets, type Design, type LeafBlock } from "@/lib/design/spec";
import { bodyImageIds, bodyToHtml, bodyToText, hasMarkup } from "@/lib/mail/body";
import { MESSAGE_LIMIT_BYTES, type Quote } from "@/lib/mail/compose";
import type { Contact, Message } from "@/lib/mail/types";
import { getAsset } from "./assets";
import { getAttachment } from "./attachments";
import { getAccount, type AccountRow } from "./db";
import type { OutgoingMessage } from "./mail/types";
import { mailOf } from "./providers/registry";
import { remoteMessages } from "./store";
import { readUpload } from "./uploads";
import { formatBytes } from "@/lib/format";

// Turns an outgoing message (markup body, optional signature design, quoted message,
// attached files) into the parts that go on the wire: a text version, an HTML version,
// inline images and attachments. Each provider sends them its own way (Gmail as MIME from
// mail/mime.ts, Outlook as a Graph message).

type InlineImage = { cid: string; contentType: string; name: string; data: Buffer };
type FileAttachment = { name: string; contentType: string; data: Buffer };
export type RenderedMessage = {
  text: string;
  html: string | null;
  inline: InlineImage[];
  attachments: FileAttachment[];
  /** An iTIP part (an invite answer), sent as a text/calendar alternative so calendars act on it. */
  calendar?: { method: string; text: string };
};

export class OutgoingError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

const cid = (id: string) => `${id}@kite`;
/** Images carried along with a quoted or forwarded message. */
const MAX_QUOTED_IMAGE_BYTES = 6 * 1024 * 1024;

/** A design (signature or designed email) as HTML with its images inline, and its text version. */
async function renderDesign(signature: Design) {
  const found = await Promise.all(designAssets(signature).map(getAsset));
  const available = new Set(found.flatMap((f) => (f ? [f.asset.id] : [])));
  // An image whose file is gone is dropped rather than sent broken.
  const keep = (b: LeafBlock) => b.type !== "image" || !assetId(b.src) || available.has(assetId(b.src)!);
  const design: Design = {
    ...signature,
    blocks: signature.blocks
      .map((b) => (b.type === "columns" ? { ...b, columns: b.columns.map((c) => ({ ...c, blocks: c.blocks.filter(keep) })) } : b))
      .filter((b) => b.type === "columns" || keep(b)),
  };
  return {
    html: compileHtml(design, { image: (src) => (assetId(src) ? `cid:${cid(assetId(src)!)}` : src) }),
    text: compileText(design),
    inline: found.flatMap((f) => (f ? [{ cid: cid(f.asset.id), contentType: f.asset.contentType, name: f.asset.name, data: f.data }] : [])),
  };
}

/** Rough plain text from an HTML email, for the text part of a quote. */
export function htmlToText(html: string) {
  return html
    .replace(/<(style|script|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|li|blockquote|table)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The inside of an HTML email's <body>, without anything that could run or restyle the reply. */
function bodyInner(html: string) {
  const inner = html.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html;
  return inner
    .replace(/<(script|style|head|title)[\s\S]*?<\/\1>/gi, "")
    .replace(/<\/?(html|body|meta|link|base)\b[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

/** The quoted message from the local copy, or from the provider when it isn't stored in full. */
async function quotedMessage(account: AccountRow, quote: Quote, threadId?: string): Promise<Message | null> {
  // Found wherever a split or merge placed it.
  const stored = threadId ? remoteMessages(account.id, threadId).find((m) => m.id === quote.messageId) : undefined;
  if (stored && (stored.html || stored.body.length)) return stored;
  try {
    return await mailOf(account).fetchMessage(account, quote.messageId, true);
  } catch {
    return stored ?? null;
  }
}

const who = (c: Contact) => (c.name && c.name !== c.email ? `${c.name} <${c.email}>` : c.email);
const whoHtml = (c: Contact) => (c.name && c.name !== c.email ? `<strong>${escapeHtml(c.name)}</strong> &lt;${escapeHtml(c.email)}&gt;` : escapeHtml(c.email));
const when = (date: string) => format(new Date(date), "EEE, d MMM yyyy 'at' HH:mm");

/** The quoted reply or forwarded message, as HTML and text, with the images it shows inline. */
async function renderQuote(account: AccountRow, quote: Quote, threadId?: string) {
  const message = await quotedMessage(account, quote, threadId);
  const from = message?.from ?? quote.from;
  const to = message?.to ?? quote.to;
  const text = message ? (message.body.length ? message.body.join("\n\n") : message.html ? htmlToText(message.html) : message.snippet ?? "") : quote.snippet;

  const inline: InlineImage[] = [];
  let inner = message?.html ? bodyInner(message.html) : `<div>${escapeHtml(text).replace(/\r?\n/g, "<br>")}</div>`;
  if (message?.html) {
    // Images the original showed by Content-ID travel with the quote, up to a size budget.
    let budget = MAX_QUOTED_IMAGE_BYTES;
    for (const a of message.attachments ?? []) {
      if (!a.contentId || !a.partId || !inner.toLowerCase().includes(`cid:${a.contentId.toLowerCase()}`)) continue;
      if ((a.bytes ?? 0) > budget) continue;
      const file = await getAttachment(account, message.id, a.partId, a.name).catch(() => null);
      if (!file || file.data.length > budget) continue;
      budget -= file.data.length;
      inline.push({ cid: a.contentId, contentType: file.mimeType, name: file.name, data: file.data });
    }
    const carried = new Set(inline.map((i) => i.cid.toLowerCase()));
    inner = inner.replace(/<img\b[^>]*\bsrc\s*=\s*["']?cid:([^"'\s>]+)[^>]*>/gi, (tag, id: string) => (carried.has(id.toLowerCase()) ? tag : ""));
  }

  if (quote.mode === "forward") {
    const header = [
      "---------- Forwarded message ---------",
      `From: ${who(from)}`,
      `Date: ${when(message?.date ?? quote.date)}`,
      `Subject: ${quote.subject}`,
      to.length ? `To: ${to.map(who).join(", ")}` : null,
    ].filter(Boolean);
    const headerHtml = [
      "---------- Forwarded message ---------",
      `From: ${whoHtml(from)}`,
      `Date: ${escapeHtml(when(message?.date ?? quote.date))}`,
      `Subject: ${escapeHtml(quote.subject)}`,
      to.length ? `To: ${to.map(whoHtml).join(", ")}` : null,
    ].filter(Boolean);
    return {
      html: `<div class="gmail_quote"><div class="gmail_attr">${headerHtml.join("<br>")}<br></div><br>${inner}</div>`,
      text: `${header.join("\n")}\n\n${text}`,
      inline,
    };
  }
  const attribution = `On ${when(message?.date ?? quote.date)}, ${who(from)} wrote:`;
  return {
    html: `<div class="gmail_quote"><div class="gmail_attr">${escapeHtml(attribution)}<br></div><blockquote class="gmail_quote" style="margin:0 0 0 0.8ex;border-left:1px solid #cccccc;padding-left:1ex">${inner}</blockquote></div>`,
    text: `${attribution}\n${text.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")}`,
    inline,
  };
}

async function loadAttachments(account: AccountRow, message: OutgoingMessage): Promise<FileAttachment[]> {
  const files = await Promise.all(
    (message.attachments ?? []).map(async (ref) => {
      if (ref.type === "upload") {
        const upload = await readUpload(ref.id);
        return { name: upload.name, contentType: upload.mimeType, data: upload.data };
      }
      // A file picked from another account is read with that account's access (or its cached copy).
      const owner = ref.accountId && ref.accountId !== account.id ? getAccount(ref.accountId) : account;
      if (!owner) throw new OutgoingError(`${ref.name} is in an account that's no longer connected. Remove it and attach it again.`, 409);
      const file = await getAttachment(owner, ref.messageId, ref.partId, ref.name);
      return { name: file.name, contentType: file.mimeType, data: file.data };
    }),
  );
  return files;
}

/** Bytes on the wire once every binary part is base64-encoded. */
function encodedSize(rendered: RenderedMessage) {
  const binary = [...rendered.inline, ...rendered.attachments].reduce((n, f) => n + f.data.length, 0);
  return Math.ceil((binary * 4) / 3) + Buffer.byteLength(rendered.text) * 1.4 + Buffer.byteLength(rendered.html ?? "") * 1.4;
}

export async function renderOutgoing(account: AccountRow, message: OutgoingMessage): Promise<RenderedMessage> {
  const markup = message.body;
  const [designed, signature, quote, attachments] = await Promise.all([
    message.design ? renderDesign(message.design) : null,
    message.signature ? renderDesign(message.signature) : null,
    message.quote ? renderQuote(account, message.quote, message.threadId) : null,
    loadAttachments(account, message),
  ]);

  const bodyImages = await Promise.all((message.design ? [] : bodyImageIds(markup)).map(async (id) => {
    const file = await getAsset(id);
    if (!file) throw new OutgoingError("An inline image is missing. Remove it or insert it again.", 409);
    return { cid: cid(id), contentType: file.asset.contentType, name: file.asset.name, data: file.data };
  }));
  const body = designed ? designed.text : bodyToText(markup).replace(/\s+$/, "");
  const text = [body, signature ? `-- \n${signature.text}` : null, quote?.text].filter(Boolean).join("\n\n");
  let html: string | null = null;
  if (designed || signature || quote || hasMarkup(markup)) {
    const font = FONT_STACKS.sans;
    const content = `${designed ? designed.html : bodyToHtml(markup)}${signature ? `<div class="kite-signature" style="margin-top:18px">${signature.html}</div>` : ""}`;
    const quoted = quote ? `<div style="margin-top:18px">${quote.html}</div>` : "";
    html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:0"><div style="font-family:${font};font-size:14px;line-height:21px;color:#1b1b1f">${content}</div>${quoted}</body></html>`;
  }

  // A logo in both the design and the signature travels once.
  const inline = [...bodyImages, ...(designed?.inline ?? []), ...(signature?.inline ?? []), ...(quote?.inline ?? [])].filter(
    (image, i, all) => all.findIndex((other) => other.cid === image.cid) === i,
  );
  const rendered: RenderedMessage = { text, html, inline, attachments };
  const size = encodedSize(rendered);
  if (size > MESSAGE_LIMIT_BYTES) {
    throw new OutgoingError(`This message would be ${formatBytes(size)} once encoded, over Gmail's 25 MB limit. Remove a file or share it as a link.`, 413);
  }
  return rendered;
}

