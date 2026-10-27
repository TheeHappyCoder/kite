import "server-only";
import { inflateRawSync } from "node:zlib";
import { getDb } from "./db";

const MAX_TEXT = 500_000;
export function searchableDocument(name: string) { return /\.(pdf|docx|txt|csv|md)$/i.test(name); }
/** DOCX's document XML only; never executes macros, follows links or expands external entities. */
function docxText(data: Buffer): string {
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (end < 0 || end + 22 > data.length) throw new Error("Invalid document");
  let at = data.readUInt32LE(end + 16);
  const count = Math.min(data.readUInt16LE(end + 10), 10000);
  for (let i = 0; i < count && at + 46 <= data.length; i++) {
    if (data.readUInt32LE(at) !== 0x02014b50) break;
    const size = data.readUInt32LE(at + 20), plain = data.readUInt32LE(at + 24);
    const nameLength = data.readUInt16LE(at + 28), extra = data.readUInt16LE(at + 30), comment = data.readUInt16LE(at + 32);
    const name = data.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    if (name === "word/document.xml") {
      if (plain > 4_000_000 || size > 4_000_000 || data.readUInt16LE(at + 8) & 1) throw new Error("Document is too large or encrypted");
      const local = data.readUInt32LE(at + 42);
      if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) throw new Error("Invalid document");
      const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
      if (start + size > data.length) throw new Error("Invalid document");
      const bytes = data.subarray(start, start + size);
      const method = data.readUInt16LE(at + 10);
      const xml = (method === 0 ? bytes : method === 8 ? inflateRawSync(bytes, { maxOutputLength: 4_000_000 }) : Buffer.alloc(0)).toString("utf8");
      return xml.replace(/<\/w:p>/g, "\n").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").slice(0, MAX_TEXT);
    }
    at += 46 + nameLength + extra + comment;
  }
  return "";
}
export async function extractDocumentText(name: string, data: Buffer): Promise<string> {
  if (data.length > 25 * 1024 * 1024) return "";
  if (/\.docx$/i.test(name)) return docxText(data);
  if (/\.(txt|csv|md)$/i.test(name)) return data.toString("utf8").slice(0, MAX_TEXT);
  if (!/\.pdf$/i.test(name)) return "";
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: false, useWorkerFetch: false });
  const doc = await task.promise;
  try {
    let text = "";
    for (let n = 1; n <= Math.min(doc.numPages, 200) && text.length < MAX_TEXT; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      text += content.items.map((item) => "str" in item ? item.str : "").join(" ") + "\n";
      page.cleanup();
    }
    return text.slice(0, MAX_TEXT);
  } finally { await task.destroy(); }
}
export async function indexDocument(accountId: string, messageId: string, partId: string, file: { name: string; data: Buffer }) {
  if (!searchableDocument(file.name)) return;
  if (getDb().prepare("SELECT 1 FROM document_text WHERE account_id = ? AND message_id = ? AND part_id = ?").get(accountId, messageId, partId)) return;
  const text = await extractDocumentText(file.name, file.data);
  // A download can finish after disconnect or Reset local copy. Never restore erased data.
  const present = getDb().prepare(`SELECT 1 FROM accounts a JOIN threads t ON t.account_id = a.id,
    json_each(t.list_data, '$.messages') m, json_each(m.value, '$.attachments') p
    WHERE a.id = ? AND json_extract(m.value, '$.id') = ?
      AND json_extract(p.value, '$.partId') = ? LIMIT 1`).get(accountId, messageId, partId);
  if (!present) return;
  getDb().prepare("INSERT OR REPLACE INTO document_text VALUES (?, ?, ?, ?)").run(accountId, messageId, partId, text.toLowerCase());
}
