import * as z from "zod";
import { formatAcrobatDate, type FieldValue, type FormInfo, type Placed } from "./fill";

// "Sign like last time": a remembered layout is where the user placed things on a sender's form,
// plus the field values they chose to keep. Typed data, applied only when the user clicks.
// Forms are recognised by sender, page geometry and a fingerprint of their printed text; the
// text is hashed on the server (server/fill-layouts.ts) and never stored.

const LayoutItem = z.object({
  kind: z.enum(["text", "tick", "date", "signature"]),
  page: z.number().int().min(0).max(999),
  x: z.number().finite(),
  y: z.number().finite(),
  w: z.number().positive().max(5000),
  h: z.number().positive().max(5000),
  /** Placed text the user chose to keep. Dates never keep theirs: they're today's date when applied. */
  text: z.string().max(500).optional(),
});
type LayoutItem = z.infer<typeof LayoutItem>;

const LayoutValue = z.union([
  z.object({ field: z.string().min(1).max(300), value: z.union([z.string().max(2000), z.boolean()]) }),
  /** A date field: filled with the day it's applied, in this Acrobat format. */
  z.object({ field: z.string().min(1).max(300), today: z.string().min(1).max(40) }),
]);
type LayoutValue = z.infer<typeof LayoutValue>;

export const LayoutSpec = z.object({
  version: z.literal(1),
  items: z.array(LayoutItem).max(200),
  values: z.array(LayoutValue).max(500),
  flatten: z.boolean(),
});
export type LayoutSpec = z.infer<typeof LayoutSpec>;

/** Page sizes in points, as pdf.js shows them (rotation applied). */
export const PageSizes = z.array(z.tuple([z.number().positive().max(20_000), z.number().positive().max(20_000)])).min(1).max(999);
export type PageSizes = z.infer<typeof PageSizes>;

/** What a form looks like, sent to the server to save or match a layout. `lines` are hashed there. */
export const FormPrint = z.object({
  sender: z.string().trim().toLowerCase().email().max(320),
  pages: PageSizes,
  lines: z.array(z.string().max(1000)).max(5000),
});
export type FormPrint = z.infer<typeof FormPrint>;

/** A remembered layout as the API returns it (never the fingerprint). */
export type Layout = {
  id: string;
  sender: string;
  name: string;
  pages: PageSizes;
  spec: LayoutSpec;
  createdAt: string;
  usedAt: string | null;
};

/** Fewer distinct lines than this and Kite can't tell one form from another. */
export const MIN_PRINT_LINES = 6;
/** Share of lines two prints must have in common to count as the same form. */
export const MATCH_SIMILARITY = 0.8;

const MONTH_WORDS =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|june?|july?|aug(ust)?|sep(t(ember)?)?|oct(ober)?|nov(ember)?|dec(ember)?|mon(day)?|tue(sday)?|wed(nesday)?|thu(rsday)?|fri(day)?|sat(urday)?|sun(day)?)\b/g;

/** A printed line with its variable parts (numbers, dates) blanked, so job numbers don't matter. */
function normalizeLine(line: string) {
  return line
    .toLowerCase()
    .normalize("NFKC")
    .replace(MONTH_WORDS, "#")
    .replace(/\d+/g, "#")
    .replace(/[#\s./:,-]*#[#\s./:,-]*/g, " # ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Distinct normalized lines per page, plus the form's fields (their names and kinds). */
export function printLines(pages: string[][], fields: FormInfo["fields"] = []) {
  const out = new Set<string>();
  pages.forEach((lines, page) => {
    for (const line of lines) {
      const n = normalizeLine(line);
      // Lines that were only numbers or dates say nothing about the form.
      if (n.replace(/[#\s]/g, "").length >= 2) out.add(`${page}|${n}`);
    }
  });
  for (const f of fields) out.add(`field|${f.name}|${f.kind}`);
  return [...out];
}

/** Same page count and each page the same size (to a point). */
export function sameGeometry(a: PageSizes, b: PageSizes) {
  return a.length === b.length && a.every(([w, h], i) => Math.abs(w - b[i][0]) <= 1 && Math.abs(h - b[i][1]) <= 1);
}

/** Jaccard similarity of two sets of line hashes. */
export function similarity(a: string[], b: string[]) {
  const sa = new Set(a);
  const sb = new Set(b);
  let shared = 0;
  for (const x of sa) if (sb.has(x)) shared++;
  const union = sa.size + sb.size - shared;
  return union ? shared / union : 0;
}

const DATE_FORMATS = ["dd/mm/yyyy", "d/m/yyyy", "yyyy-mm-dd", "yyyy/mm/dd", "dd-mm-yyyy", "dd.mm.yyyy", "d mmmm yyyy", "d mmm yyyy", "mm/dd/yyyy"];

/** The format a value was typed in when it's today's date, so it can be "today" next time. */
export function asToday(value: FieldValue, today = new Date(), own?: string) {
  if (typeof value !== "string" || !value.trim()) return null;
  const v = value.trim().toLowerCase();
  for (const f of own ? [own, ...DATE_FORMATS] : DATE_FORMATS) if (formatAcrobatDate(today, f).toLowerCase() === v) return f;
  return null;
}

/** "Job card 4411 (signed).pdf" -> "Job card". */
export function formName(fileName: string) {
  const name = fileName
    .replace(/\.pdf$/i, "")
    .replace(/\((signed|filled)\)/gi, "")
    .replace(/[_]+/g, " ")
    .replace(/[#\s-]*\d[\d\s./-]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (name || "Form").slice(0, 80);
}

type Applied = {
  values: Record<string, FieldValue>;
  items: Placed[];
  /** What was placed, in plain words ("signature", "Name", "date"). */
  summary: string[];
  /** A signature was remembered but there's no saved signature to place. */
  missingSignature: boolean;
};

/** Turns a remembered layout into editor state for this form. Fields it lacks are skipped. */
export function applyLayout(spec: LayoutSpec, info: FormInfo | null, pageCount: number, hasSignature: boolean, today = new Date()): Applied {
  const fields = new Map((info?.fields ?? []).filter((f) => !f.readOnly).map((f) => [f.name, f]));
  const values: Record<string, FieldValue> = {};
  const summary: string[] = [];
  for (const v of spec.values) {
    const field = fields.get(v.field);
    if (!field) continue;
    values[v.field] = "today" in v ? formatAcrobatDate(today, field.dateFormat ?? v.today) : v.value;
    summary.push(field.label ?? field.name);
  }

  let missingSignature = false;
  const items: Placed[] = [];
  for (const item of spec.items) {
    if (item.page >= pageCount) continue;
    if (item.kind === "signature" && !hasSignature) {
      missingSignature = true;
      continue;
    }
    if (item.kind === "text" && !item.text?.trim()) continue;
    items.push({
      id: crypto.randomUUID(),
      ...item,
      ...(item.kind === "date" ? { text: formatAcrobatDate(today, "dd/mm/yyyy") } : {}),
    });
  }
  const count = (kind: Placed["kind"]) => items.filter((i) => i.kind === kind).length;
  const placed = [
    count("signature") ? "signature" : null,
    count("text") ? (count("text") === 1 ? "your text" : `${count("text")} bits of text`) : null,
    count("tick") ? (count("tick") === 1 ? "a tick" : `${count("tick")} ticks`) : null,
    count("date") ? "date" : null,
  ].filter((s): s is string => !!s);
  return { values, items, summary: [...placed, ...summary], missingSignature };
}
