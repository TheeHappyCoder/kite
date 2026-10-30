import { read, utils, type WorkBook } from "xlsx";
import { textCharset } from "../mail/attachments";

// Reads a spreadsheet off the main thread, so a big one can't freeze the app. Values only:
// formulas show their saved results, and macros and links are never touched.

export const MAX_ROWS = 20_000;
const MAX_COLUMNS = 200;

export type Sheet = { name: string; rows: string[][]; firstRow: number; firstColumn: number; columns: number; cut: boolean };
export type SheetRequest = { bytes: ArrayBuffer; csv: boolean };
export type SheetReply = { sheets: Sheet[]; error?: undefined } | { error: string };

function sheetsOf(book: WorkBook): Sheet[] {
  const hidden = new Set((book.Workbook?.Sheets ?? []).filter((s) => s.Hidden).map((s) => s.name));
  const names = book.SheetNames.filter((name) => !hidden.has(name));
  return (names.length ? names : book.SheetNames).map((name) => {
    const sheet = book.Sheets[name];
    const range = utils.decode_range(sheet["!ref"] ?? "A1");
    const all = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, blankrows: true, defval: "" });
    const rows = all.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS).map(String));
    return { name, rows, firstRow: range.s.r, firstColumn: range.s.c, columns: rows.reduce((most, row) => Math.max(most, row.length), 0), cut: all.length > MAX_ROWS };
  });
}

self.onmessage = (event: MessageEvent<SheetRequest>) => {
  const { bytes, csv } = event.data;
  try {
    const options = { dense: true, sheetRows: MAX_ROWS + 1, cellHTML: false, cellFormula: false } as const;
    const data = new Uint8Array(bytes);
    // A CSV's cells stay exactly as written: no dropped leading zeros, no numbers turned into dates.
    const book = csv ? read(new TextDecoder(textCharset(data)).decode(data), { ...options, type: "string", raw: true }) : read(data, { ...options, type: "array" });
    self.postMessage({ sheets: sheetsOf(book) } satisfies SheetReply);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "Couldn't read this file." } satisfies SheetReply);
  }
};
