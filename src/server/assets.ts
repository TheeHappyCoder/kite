import "server-only";

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesignAsset } from "@/lib/design/prompt";
import { dataDir } from "./paths";

// Images used in designs (signatures now, emails later). Stored on this computer under
// data/assets and sent inside each message as inline (CID) parts, so nothing is hosted.

const DIR = dataDir("assets");
export const MAX_ASSET_BYTES = 512 * 1024;

const TYPES: { type: string; ext: string; magic: (b: Buffer) => boolean }[] = [
  { type: "image/png", ext: "png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/gif", ext: "gif", magic: (b) => b.subarray(0, 4).toString("ascii") === "GIF8" },
  { type: "image/webp", ext: "webp", magic: (b) => b.subarray(0, 4).toString("ascii") === "RIFF" && b.subarray(8, 12).toString("ascii") === "WEBP" },
];

export class AssetError extends Error {}

const ID = /^[0-9a-f]{24}$/;

/** Saves an image. Private ones (a Fill & sign signature) never show up in design image lists. The type comes from the file's bytes, never from what the browser claimed. */
export async function saveAsset(data: Buffer, meta: { name: string; width: number; height: number; private?: boolean }): Promise<DesignAsset> {
  if (data.length > MAX_ASSET_BYTES) throw new AssetError(`Images can be up to ${MAX_ASSET_BYTES / 1024} KB, because they travel inside every email.`);
  const kind = TYPES.find((t) => t.magic(data));
  if (!kind) throw new AssetError("Use a PNG, JPG, GIF or WebP image.");
  const id = createHash("sha256").update(data).digest("hex").slice(0, 24);
  const asset: DesignAsset = {
    id,
    name: meta.name.replace(/[^\w .()-]/g, "").slice(0, 80) || `image.${kind.ext}`,
    width: Math.max(1, Math.round(meta.width)),
    height: Math.max(1, Math.round(meta.height)),
    contentType: kind.type,
    bytes: data.length,
    ...(meta.private ? { private: true } : {}),
  };
  mkdirSync(DIR, { recursive: true });
  await writeFile(path.join(DIR, id), data);
  await writeFile(path.join(DIR, `${id}.json`), JSON.stringify(asset));
  return asset;
}

export async function getAsset(id: string): Promise<{ asset: DesignAsset; data: Buffer } | null> {
  if (!ID.test(id)) return null;
  try {
    const [data, meta] = await Promise.all([readFile(path.join(DIR, id)), readFile(path.join(DIR, `${id}.json`), "utf-8")]);
    return { asset: JSON.parse(meta) as DesignAsset, data };
  } catch {
    return null;
  }
}

/** Deletes an image and its details (an account picture nobody shows any more). */
export async function removeAsset(id: string) {
  if (!ID.test(id)) return;
  await Promise.all([rm(path.join(DIR, id), { force: true }), rm(path.join(DIR, `${id}.json`), { force: true })]);
}

/** Design images, without private ones. */
export async function listAssets(): Promise<DesignAsset[]> {
  const files = await readdir(DIR).catch(() => [] as string[]);
  const metas = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => readFile(path.join(DIR, f), "utf-8").then((s) => JSON.parse(s) as DesignAsset).catch(() => null)),
  );
  return metas.filter((m): m is DesignAsset => !!m && !m.private);
}

const KITE_CID = /cid:([0-9a-f]{24})@kite/g;

/** Kite's own sent mail points at inline images by Content-ID; show them from the local copies. */
export async function resolveKiteImages(html: string) {
  const ids = [...new Set([...html.matchAll(KITE_CID)].map((m) => m[1]))];
  if (!ids.length) return html;
  const found = new Map((await Promise.all(ids.map(getAsset))).flatMap((f) => (f ? [[f.asset.id, f] as const] : [])));
  return html.replace(KITE_CID, (match, id: string) => {
    const f = found.get(id);
    return f ? `data:${f.asset.contentType};base64,${f.data.toString("base64")}` : match;
  });
}
