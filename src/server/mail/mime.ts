import "server-only";

import type { AccountRow } from "../db";
import type { RenderedMessage } from "../outgoing";
import type { Recipient } from "@/lib/mail/compose";
import type { OutgoingMessage } from "./types";

// Outgoing mail as RFC 822 MIME, shared by every provider (Gmail uploads it, Graph takes it as
// base64, SMTP sends it as is): text, or multipart/related(alternative(text, html), inline images),
// wrapped in multipart/mixed with files.

function encodeHeader(value: string) {
  // RFC 2047 encoding for non-ASCII headers (subjects, names).
  return /^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function formatAddress({ name, email }: Recipient) {
  const clean = name?.replace(/["\\\r\n]/g, "").trim();
  if (!clean || clean === email) return email;
  return /^[\x20-\x7e]*$/.test(clean) ? `"${clean}" <${email}>` : `${encodeHeader(clean)} <${email}>`;
}

function addressHeader(name: string, list: Recipient[] | undefined) {
  if (!list?.length) return null;
  // Folded so long recipient lists stay under the 998-character line limit.
  return `${name}: ${list.map(formatAddress).join(",\r\n ")}`;
}

/** Base64 wrapped at 76 characters, as MIME requires. */
function base64Lines(data: Buffer | string) {
  return (Buffer.isBuffer(data) ? data : Buffer.from(data)).toString("base64").replace(/.{76}(?=.)/g, "$&\r\n");
}

/** A random MIME boundary with no product name in it, so sent mail doesn't say which app wrote it. */
export function boundary() {
  return `----=_Part_${crypto.randomUUID().replace(/-/g, "")}`;
}

const MIME_TYPE = /^[a-z0-9][\w.+-]*\/[\w.+-]+$/i;

/** name= and filename= parameters, with RFC 2231 / 2047 forms for non-ASCII names. */
function fileParams(raw: string) {
  const name = raw.replace(/["\\\r\n]/g, "").trim() || "attachment";
  if (/^[\x20-\x7e]*$/.test(name)) return { type: `name="${name}"`, disposition: `filename="${name}"` };
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return { type: `name="${encodeHeader(name)}"`, disposition: `filename*=UTF-8''${encoded}` };
}

const contentType = (type: string) => (MIME_TYPE.test(type) ? type : "application/octet-stream");

/** text, or multipart/related(multipart/alternative(text, html, calendar), inline images). */
function contentPart(rendered: RenderedMessage): string[] {
  const textPart = ['Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64Lines(rendered.text)];
  if (!rendered.html && !rendered.calendar) return textPart;

  const alt = boundary();
  const method = rendered.calendar?.method.replace(/[^A-Z-]/gi, "");
  const alternative = [
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    ...textPart,
    ...(rendered.html ? [`--${alt}`, 'Content-Type: text/html; charset="UTF-8"', "Content-Transfer-Encoding: base64", "", base64Lines(rendered.html)] : []),
    ...(rendered.calendar
      ? [`--${alt}`, `Content-Type: text/calendar; charset="UTF-8"; method=${method}`, "Content-Transfer-Encoding: base64", "", base64Lines(rendered.calendar.text)]
      : []),
    `--${alt}--`,
  ];
  if (!rendered.inline.length) return alternative;

  const related = boundary();
  return [
    `Content-Type: multipart/related; type="multipart/alternative"; boundary="${related}"`,
    "",
    `--${related}`,
    ...alternative,
    ...rendered.inline.flatMap((image) => {
      const params = fileParams(image.name);
      return [
        `--${related}`,
        `Content-Type: ${contentType(image.contentType)}; ${params.type}`,
        "Content-Transfer-Encoding: base64",
        `Content-ID: <${image.cid.replace(/[<>\r\n]/g, "")}>`,
        `Content-Disposition: inline; ${params.disposition}`,
        "",
        base64Lines(image.data),
      ];
    }),
    `--${related}--`,
  ];
}

/** The content part, wrapped in multipart/mixed with the attached files when there are any. */
function mimeBody(rendered: RenderedMessage): string[] {
  const content = contentPart(rendered);
  if (!rendered.attachments.length) return content;
  const mixed = boundary();
  return [
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    ...content,
    ...rendered.attachments.flatMap((file) => {
      const params = fileParams(file.name);
      return [
        `--${mixed}`,
        `Content-Type: ${contentType(file.contentType)}; ${params.type}`,
        "Content-Transfer-Encoding: base64",
        `Content-Disposition: attachment; ${params.disposition}`,
        "",
        base64Lines(file.data),
      ];
    }),
    `--${mixed}--`,
  ];
}

/** The RFC 822 message as text. Bcc stays in: the provider delivers to it and removes it from what recipients see. */
export function buildMime(account: AccountRow, input: OutgoingMessage, rendered: RenderedMessage) {
  const lines = [
    `From: ${formatAddress({ name: account.name, email: account.email })}`,
    addressHeader("To", input.to),
    addressHeader("Cc", input.cc),
    addressHeader("Bcc", input.bcc),
    `Subject: ${encodeHeader(input.subject)}`,
    input.inReplyTo ? `In-Reply-To: ${input.inReplyTo}` : null,
    input.inReplyTo ? `References: ${[input.references, input.inReplyTo].filter(Boolean).join(" ")}` : null,
    "MIME-Version: 1.0",
    ...mimeBody(rendered),
  ].filter((line): line is string => line !== null);
  return lines.join("\r\n");
}

/** A message with nothing to render: its body as plain text. */
export const plainRendering = (input: OutgoingMessage): RenderedMessage => ({ text: input.body, html: null, inline: [], attachments: [] });
