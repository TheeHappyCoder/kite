import type { Attachment, FileItem, Thread } from "./types";

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

/** Text files shown as they are, whatever type the sender gave them. */
const TEXT_FILE = /\.(txt|md|markdown|log|json|xml|yaml|yml|ini)$/i;
const SHEET_FILE = /\.(xlsx|xlsm|xlsb|xltx|xls|ods|csv)$/i;
const WORD_FILE = /\.(docx|docm|dotx)$/i;
const SLIDES_FILE = /\.(pptx|pptm|ppsx|potx)$/i;

/** What the browser can open by itself. Everything else the route serves as a download. */
export function viewableType(name: string, mimeType?: string) {
  return TEXT_FILE.test(name) ? "text/plain" : inferMimeType(name, mimeType);
}

/** Types the browser can show (the route serves everything else as a download). */
export function canPreview(attachment: Pick<Attachment, "name" | "mimeType" | "kind">) {
  const type = viewableType(attachment.name, attachment.mimeType);
  return attachment.kind === "pdf" || /^image\/(png|jpeg|gif|webp|bmp|avif)$/.test(type) || type === "text/plain" || type === "text/csv" || /^(audio|video)\//.test(type);
}

/** The Office files Kite draws itself, on this computer, from the attachment's bytes. */
export function officePreview(attachment: Pick<Attachment, "name" | "mimeType">): "sheet" | "word" | "slides" | null {
  const { name } = attachment;
  const type = (attachment.mimeType ?? "").toLowerCase();
  if (SHEET_FILE.test(name) || type === "text/csv" || type.includes("spreadsheetml") || type === "application/vnd.ms-excel" || type.includes("opendocument.spreadsheet")) return "sheet";
  if (WORD_FILE.test(name) || type.includes("wordprocessingml")) return "word";
  if (SLIDES_FILE.test(name) || type.includes("presentationml")) return "slides";
  return null;
}

/** Text in UTF-8 unless its bytes say otherwise; old Windows files are the usual exception. */
export function textCharset(bytes: Uint8Array) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return "utf-8";
  } catch {
    return "windows-1252";
  }
}

/** The files in these conversations (not inline images), newest first: from the slim list copy, which keeps attachments. */
export function threadFiles(threads: Thread[]): FileItem[] {
  return threads
    .flatMap((t) =>
      t.messages.flatMap((m) =>
        (m.attachments ?? []).filter((a) => !a.inline).map((a) => ({ ...a, accountId: t.accountId, threadId: t.id, messageId: m.id, subject: t.subject, from: m.from, date: m.date })),
      ),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}
