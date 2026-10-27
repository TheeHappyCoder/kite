import "server-only";

import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { inferMimeType } from "@/lib/mail/attachments";
import { ATTACHMENT_LIMIT_BYTES } from "@/lib/mail/compose";
import { getDb } from "./db";
import { dataDir } from "./paths";

// Files attached to outgoing mail, kept in data/uploads until the message is sent or the
// draft is discarded. Drafts and queued sends refer to them by id.

const UPLOAD_DIR = dataDir("uploads");
const ID = /^[0-9a-f]{32}$/;
/** Unreferenced uploads older than this are removed. */
const STALE_MS = 3 * 86_400_000;
let sweptAt = 0;

type UploadMeta = { id: string; name: string; mimeType: string; bytes: number };

export class UploadError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

const file = (id: string) => path.join(UPLOAD_DIR, id);

export async function saveUpload(rawName: string, mimeType: string, data: Buffer): Promise<UploadMeta> {
  if (data.length > ATTACHMENT_LIMIT_BYTES) throw new UploadError("That file is over Gmail's limit.", 413);
  void sweepUploads();
  const name = rawName.replace(/[\\/\r\n\0]/g, "_").trim().slice(0, 255) || "attachment";
  const meta: UploadMeta = { id: crypto.randomUUID().replace(/-/g, ""), name, mimeType: inferMimeType(name, mimeType), bytes: data.length };
  mkdirSync(UPLOAD_DIR, { recursive: true });
  await writeFile(file(meta.id), data);
  await writeFile(`${file(meta.id)}.json`, JSON.stringify(meta));
  return meta;
}

export async function readUpload(id: string) {
  if (!ID.test(id)) throw new UploadError("That file link isn't valid.", 400);
  const [meta, data] = await Promise.all([
    readFile(`${file(id)}.json`, "utf-8").then((s) => JSON.parse(s) as UploadMeta).catch(() => null),
    readFile(file(id)).catch(() => null),
  ]);
  if (!meta || !data) throw new UploadError("An attached file is missing. Remove it and attach it again.", 404);
  return { ...meta, data };
}

export async function removeUploads(ids: string[]) {
  await Promise.all(ids.filter((id) => ID.test(id)).flatMap((id) => [rm(file(id), { force: true }), rm(`${file(id)}.json`, { force: true })]));
}

/** Drops old uploads that no draft or queued message refers to (closed windows, failed attaches). */
async function sweepUploads() {
  if (Date.now() - sweptAt < 3_600_000) return;
  sweptAt = Date.now();
  const names = await readdir(UPLOAD_DIR).catch(() => [] as string[]);
  const referenced = (getDb().prepare("SELECT payload FROM drafts UNION ALL SELECT payload FROM scheduled WHERE status IN ('pending', 'sending', 'failed')").all() as { payload: string }[])
    .map((r) => r.payload)
    .join("\n");
  for (const id of names.filter((n) => ID.test(n))) {
    const info = await stat(file(id)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > STALE_MS && !referenced.includes(id)) await removeUploads([id]);
  }
}
