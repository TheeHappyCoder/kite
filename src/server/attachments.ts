import "server-only";

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { attachmentUrl, isInlineIn } from "@/lib/mail/attachments";
import type { Attachment, Message } from "@/lib/mail/types";
import { indexDocument } from "./document-text";
import { resolveKiteImages } from "./assets";
import { PART_ID, REMOTE_ID } from "@/lib/mail/threads";
import type { AccountRow } from "./db";
import type { AttachmentFile } from "./mail/types";
import { mailOf } from "./providers/registry";
import { dataDir } from "./paths";

// Attachments are downloaded from the provider when first opened, then kept under
// data/attachments so previews and repeat opens work offline.

export const ATTACHMENT_DIR = dataDir("attachments");
/** Bigger files are streamed through but not kept. */
const MAX_CACHED_BYTES = 25 * 1024 * 1024;


export class AttachmentError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

function cacheFile(accountId: string, messageId: string, partId: string) {
  return path.join(ATTACHMENT_DIR, createHash("sha256").update(`${accountId}:${messageId}:${partId}`).digest("hex").slice(0, 32));
}


/** Bytes for one attachment, by its part id. */
export async function getAttachment(account: AccountRow, messageId: string, partId: string, name?: string): Promise<AttachmentFile> {
  if (!REMOTE_ID.test(messageId) || !PART_ID.test(partId)) throw new AttachmentError("That file link isn't valid.", 400);
  const file = cacheFile(account.id, messageId, partId);
  const meta = await readFile(`${file}.json`, "utf-8").then((s) => JSON.parse(s) as Omit<AttachmentFile, "data">).catch(() => null);
  if (meta) {
    const data = await readFile(file).catch(() => null);
    if (data) {
      // Windows doesn't update access times reliably: mark the use so the sweep keeps it.
      const now = new Date();
      await utimes(file, now, now).catch(() => {});
      await utimes(`${file}.json`, now, now).catch(() => {});
      await indexDocument(account.id, messageId, partId, { ...meta, data }).catch(() => {});
      return { ...meta, data };
    }
  }

  const result = await mailOf(account).attachment(account, messageId, partId, name);
  if (!result) throw new AttachmentError("This file is no longer in the message.", 404);
  const { data } = result;
  if (data.length <= MAX_CACHED_BYTES) {
    mkdirSync(ATTACHMENT_DIR, { recursive: true });
    await writeFile(file, data);
    await writeFile(`${file}.json`, JSON.stringify({ name: result.name, mimeType: result.mimeType }));
  }
  await indexDocument(account.id, messageId, partId, result).catch(() => {});
  return result;
}

export async function clearAttachmentCache() {
  await rm(ATTACHMENT_DIR, { recursive: true, force: true });
}

/** Cached files not opened for this long are removed (they download again when needed). */
const CACHE_DAYS = 30;

/** Removes cached attachments last used more than CACHE_DAYS ago. */
export async function sweepAttachmentCache() {
  const cutoff = Date.now() - CACHE_DAYS * 86_400_000;
  const names = await readdir(ATTACHMENT_DIR).catch(() => [] as string[]);
  for (const name of names) {
    const file = path.join(ATTACHMENT_DIR, name);
    const info = await stat(file).catch(() => null);
    if (info && Math.max(info.atimeMs, info.mtimeMs) < cutoff) await rm(file, { force: true });
  }
}

const CID = /\bcid:([^"'\s)>]+)/gi;
const SRC = /(\bsrc\s*=\s*)(["'])([^"'<>]+)\2/gi;

/**
 * Points a message's inline images at real bytes: Kite's own designed images come
 * from the local copies, everything else from the attachment route. Handles cid:
 * references and bare file names (src="logo.png"), and marks those files inline.
 */
export async function resolveInlineImages(accountId: string, message: Message): Promise<Message> {
  if (!message.html) return message;
  let html = await resolveKiteImages(message.html);
  const attachments = message.attachments ?? [];
  if (!attachments.length) return { ...message, html };

  const byCid = new Map(attachments.filter((a) => a.contentId).map((a) => [a.contentId!.toLowerCase(), a] as const));
  const byName = new Map(attachments.map((a) => [a.name.toLowerCase(), a] as const));
  const url = (a: Attachment) => attachmentUrl(accountId, message.id, a);
  html = html.replace(CID, (match, raw: string) => {
    let cid = raw;
    try {
      cid = decodeURIComponent(raw);
    } catch {}
    const attachment = byCid.get(cid.toLowerCase());
    return attachment ? url(attachment) : match;
  });
  html = html.replace(SRC, (match, prefix: string, quote: string, value: string) => {
    if (/[:/]/.test(value)) return match;
    const attachment = byName.get(value.toLowerCase());
    return attachment ? `${prefix}${quote}${url(attachment)}${quote}` : match;
  });
  return {
    ...message,
    html,
    attachments: attachments.map((a) => (a.inline || isInlineIn(message.html!, a) ? { ...a, inline: true } : a)),
  };
}
