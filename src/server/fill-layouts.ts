import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  LayoutSpec,
  MATCH_SIMILARITY,
  MIN_PRINT_LINES,
  PageSizes,
  sameGeometry,
  similarity,
  type FormPrint,
  type Layout,
} from "@/lib/pdf/layout";
import { PERSONAL_DOMAINS } from "./avatars";
import { getDb } from "./db";

// Remembered Fill & sign layouts ("sign like last time"). A form is recognised by its sender,
// page sizes and printed text; the text arrives as normalized lines and is hashed here with a
// per-install salt, so the database never holds the form's words. Never log the lines.

type Row = {
  id: string;
  sender: string;
  name: string;
  pages: string;
  fingerprint: string;
  spec: string;
  created_at: string;
  used_at: string | null;
};

export class LayoutError extends Error {}

function salt() {
  const d = getDb();
  const row = d.prepare("SELECT value FROM settings WHERE key = 'fillSignSalt'").get() as { value: string } | undefined;
  if (row) return row.value;
  const value = randomBytes(16).toString("hex");
  d.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('fillSignSalt', ?)").run(value);
  return (d.prepare("SELECT value FROM settings WHERE key = 'fillSignSalt'").get() as { value: string }).value;
}

function fingerprint(lines: string[]) {
  const s = salt();
  return [...new Set(lines.map((line) => createHash("sha256").update(s).update(line).digest("hex").slice(0, 16)))];
}

function toLayout(row: Row): Layout | null {
  const spec = LayoutSpec.safeParse(JSON.parse(row.spec));
  const pages = PageSizes.safeParse(JSON.parse(row.pages));
  if (!spec.success || !pages.success) return null;
  return { id: row.id, sender: row.sender, name: row.name, pages: pages.data, spec: spec.data, createdAt: row.created_at, usedAt: row.used_at };
}

function domainOf(email: string) {
  return email.slice(email.lastIndexOf("@") + 1);
}

/** Layouts that could be this sender's: the same address, or the same company domain (not free mail). */
function candidates(sender: string): Row[] {
  const d = getDb();
  const exact = d.prepare("SELECT * FROM fill_layouts WHERE sender = ?").all(sender) as Row[];
  if (exact.length) return exact;
  const domain = domainOf(sender);
  if (PERSONAL_DOMAINS.has(domain)) return [];
  return d.prepare("SELECT * FROM fill_layouts WHERE sender LIKE ? ESCAPE '\\'").all(`%@${domain.replace(/[\\%_]/g, "\\$&")}`) as Row[];
}

export function listLayouts(): Layout[] {
  const rows = getDb().prepare("SELECT * FROM fill_layouts ORDER BY COALESCE(used_at, created_at) DESC").all() as Row[];
  return rows.map(toLayout).filter((l): l is Layout => !!l);
}

/** How many layouts could apply to mail from this sender (the preview's cheap first check). */
export function countForSender(sender: string) {
  return candidates(sender.toLowerCase()).length;
}

/** Whether a print has enough text to be recognised again. */
function recognisable(print: FormPrint) {
  return new Set(print.lines).size >= MIN_PRINT_LINES;
}

function matches(rows: Row[], print: FormPrint, hashes: string[]) {
  return rows.filter((row) => {
    const pages = PageSizes.safeParse(JSON.parse(row.pages));
    return pages.success && sameGeometry(pages.data, print.pages) && similarity(JSON.parse(row.fingerprint) as string[], hashes) >= MATCH_SIMILARITY;
  });
}

/** The one layout this form matches with confidence, or null (none, too little text, or ambiguous). */
export function matchLayout(print: FormPrint): Layout | null {
  if (!recognisable(print)) return null;
  const found = matches(candidates(print.sender), print, fingerprint(print.lines));
  return found.length === 1 ? toLayout(found[0]) : null;
}

/** Remembers a layout. The same form from the same sender replaces the one remembered before. */
export function saveLayout(print: FormPrint, name: string, spec: LayoutSpec): Layout {
  if (!recognisable(print)) throw new LayoutError("This PDF has too little printed text for Kite to recognise it next time.");
  const d = getDb();
  const hashes = fingerprint(print.lines);
  const same = matches(d.prepare("SELECT * FROM fill_layouts WHERE sender = ?").all(print.sender) as Row[], print, hashes);
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  d.exec("BEGIN");
  try {
    for (const row of same) d.prepare("DELETE FROM fill_layouts WHERE id = ?").run(row.id);
    d.prepare("INSERT INTO fill_layouts (id, sender, name, pages, fingerprint, spec, created_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
      id,
      print.sender,
      name,
      JSON.stringify(print.pages),
      JSON.stringify(hashes),
      JSON.stringify(spec),
      now,
      now,
    );
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
  return { id, sender: print.sender, name, pages: print.pages, spec, createdAt: now, usedAt: now };
}

export function markUsed(id: string) {
  return getDb().prepare("UPDATE fill_layouts SET used_at = ? WHERE id = ?").run(new Date().toISOString(), id).changes > 0;
}

export function deleteLayout(id: string) {
  return getDb().prepare("DELETE FROM fill_layouts WHERE id = ?").run(id).changes > 0;
}
