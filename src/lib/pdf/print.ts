import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import type { FormInfo } from "./fill";
import type { TextItem, TextPage } from "./labels";
import { printLines, type PageSizes } from "./layout";

// A form's print for "sign like last time": page sizes plus its printed text lines (pdf.js),
// normalized in layout.ts. Sent only to Kite's own server, which hashes the lines and keeps no text.

/** Lines of one page: text pieces grouped by their baseline, left to right. */
async function pageLines(page: PDFPageProxy) {
  const content = await page.getTextContent();
  const rows = new Map<number, { x: number; s: string }[]>();
  for (const item of content.items) {
    if (!("str" in item) || !item.str.trim()) continue;
    const y = Math.round(item.transform[5] / 3);
    const row = rows.get(y) ?? [];
    row.push({ x: item.transform[4], s: item.str });
    rows.set(y, row);
  }
  return [...rows.values()].map((row) =>
    row
      .sort((a, b) => a.x - b.x)
      .map((p) => p.s)
      .join(" "),
  );
}

/** Printed text with positions, for finding labels on flat forms. Rotated pages and text are skipped. */
export async function pageText(page: PDFPageProxy): Promise<TextPage> {
  const [, , x1] = page.view;
  if (page.rotate % 360 !== 0) return { items: [], right: x1 };
  const content = await page.getTextContent();
  const items: TextItem[] = [];
  for (const item of content.items) {
    if (!("str" in item) || !item.str) continue;
    const [a, b, c, d, x, y] = item.transform as number[];
    if (Math.abs(b) > 0.01 || Math.abs(c) > 0.01 || a <= 0 || d <= 0) continue;
    items.push({ str: item.str, x, y, w: item.width, size: Math.hypot(c, d) });
  }
  return { items, right: x1 };
}

export async function readPrint(doc: PDFDocumentProxy, info: FormInfo | null, pages?: PDFPageProxy[]): Promise<{ pages: PageSizes; lines: string[] }> {
  const list = pages ?? (await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1))));
  const sizes = list.map((p) => {
    const v = p.getViewport({ scale: 1 });
    return [Math.round(v.width * 10) / 10, Math.round(v.height * 10) / 10] as [number, number];
  });
  const text = await Promise.all(list.map(pageLines));
  return { pages: sizes, lines: printLines(text, info?.fields) };
}

/** The print of a PDF from its bytes (the preview's check; loads pdf.js and pdf-lib). */
export async function readPrintFromBytes(bytes: Uint8Array) {
  const [{ loadPdfjs }, { readForm }] = await Promise.all([import("./pdfjs"), import("./fill")]);
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ data: bytes.slice() });
  try {
    const doc = await task.promise;
    const info = await readForm(bytes).catch(() => null);
    return await readPrint(doc, info);
  } finally {
    void task.destroy();
  }
}
