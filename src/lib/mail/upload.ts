"use client";

import type { AttachmentRef } from "./compose";

/** Stores an outgoing file in data/uploads (POST /api/uploads) and returns its compose ref. */
export async function uploadFile(file: File): Promise<AttachmentRef> {
  const res = await fetch("/api/uploads", {
    method: "POST",
    headers: { "content-type": "application/octet-stream", "x-file-name": encodeURIComponent(file.name), "x-file-type": file.type },
    body: file,
  });
  const data = (await res.json().catch(() => ({}))) as { upload?: { id: string; name: string; mimeType: string; bytes: number }; error?: string };
  if (!res.ok || !data.upload) throw new Error(data.error ?? `${file.name} couldn't be attached. Try again.`);
  return { type: "upload", ...data.upload };
}
