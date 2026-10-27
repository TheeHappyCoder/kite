"use client";

import type { DesignAsset } from "@/lib/design/prompt";

const ASSET_LIMIT = 512 * 1024;
/** Above this, every email gets noticeably heavier. */
export const ASSET_WARN = 150 * 1024;

function readAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function dimensions(url: string) {
  return new Promise<{ width: number; height: number }>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => reject(new Error("That file isn't an image Kite can read."));
    img.src = url;
  });
}

export async function uploadAsset(file: File, { private: hidden = false }: { private?: boolean } = {}): Promise<DesignAsset> {
  if (file.size > ASSET_LIMIT) throw new Error(`That image is ${Math.round(file.size / 1024)} KB. Images can be up to 512 KB, because they travel inside every email.`);
  const url = await readAsDataUrl(file);
  const { width, height } = await dimensions(url);
  const res = await fetch("/api/assets", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: file.name, data: url.slice(url.indexOf(",") + 1), width, height, ...(hidden ? { private: true } : {}) }),
  });
  const data = (await res.json().catch(() => ({}))) as { asset?: DesignAsset; error?: string };
  if (!res.ok || !data.asset) throw new Error(data.error ?? "The upload didn't go through. Try again.");
  return data.asset;
}

export async function listAssets(): Promise<DesignAsset[]> {
  const res = await fetch("/api/assets");
  const data = (await res.json()) as { assets: DesignAsset[] };
  return data.assets;
}

/**
 * The first frame of a GIF as a PNG data URL: what Outlook on Windows shows.
 * Uses WebCodecs (Chromium and WebView2); returns null where it isn't available.
 */
export async function firstFrame(assetId: string): Promise<string | null> {
  if (typeof ImageDecoder === "undefined") return null;
  try {
    const data = await fetch(`/api/assets/${assetId}`).then((r) => r.arrayBuffer());
    const decoder = new ImageDecoder({ data, type: "image/gif" });
    const { image } = await decoder.decode({ frameIndex: 0 });
    const canvas = document.createElement("canvas");
    canvas.width = image.displayWidth;
    canvas.height = image.displayHeight;
    canvas.getContext("2d")?.drawImage(image, 0, 0);
    image.close();
    decoder.close();
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
