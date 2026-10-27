import type { Attachment } from "./types";

const BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
  pdf: "application/pdf", txt: "text/plain", csv: "text/csv", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  mp4: "video/mp4", webm: "video/webm",
};

/** Senders often label files application/octet-stream; fall back to the extension for the common types. */
export function inferMimeType(name: string, mimeType?: string) {
  const type = (mimeType ?? "").toLowerCase();
  if (type && type !== "application/octet-stream") return type;
  return BY_EXTENSION[name.split(".").pop()?.toLowerCase() ?? ""] ?? (type || "application/octet-stream");
}

export function attachmentKind(name: string, mimeType?: string): Attachment["kind"] {
  const type = inferMimeType(name, mimeType);
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/")) return "image";
  if (["doc", "docx", "odt", "rtf", "txt", "pages"].includes(ext) || type === "application/msword" || type.includes("wordprocessingml")) return "doc";
  if (["xls", "xlsx", "csv", "ods", "numbers"].includes(ext) || type.includes("spreadsheetml") || type === "application/vnd.ms-excel") return "sheet";
  return "other";
}

/** Where an attachment opens (or downloads, with `download`). Demo attachments have no part id and no URL. */
export function attachmentUrl(accountId: string, messageId: string, attachment: Pick<Attachment, "partId" | "name">, download = false) {
  const base = `/api/attachments/${encodeURIComponent(accountId)}/${messageId}/${attachment.partId ?? "0"}`;
  const params = new URLSearchParams();
  if (!attachment.partId) params.set("name", attachment.name);
  if (download) params.set("download", "1");
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

/**
 * Whether a message's HTML shows this attachment itself: by Content-ID (cid:…) or,
 * as some senders do, by bare file name (src="logo.png").
 */
export function isInlineIn(html: string, attachment: Pick<Attachment, "name" | "contentId">) {
  const lower = html.toLowerCase();
  if (attachment.contentId && lower.includes(`cid:${attachment.contentId.toLowerCase()}`)) return true;
  const name = attachment.name.toLowerCase();
  return lower.includes(`src="${name}"`) || lower.includes(`src='${name}'`);
}

/** Types the browser can show (the route serves everything else as a download). */
export function canPreview(attachment: Pick<Attachment, "name" | "mimeType" | "kind">) {
  const type = inferMimeType(attachment.name, attachment.mimeType);
  return attachment.kind === "pdf" || /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(type) || type === "text/plain" || type === "text/csv" || /^(audio|video)\//.test(type);
}
