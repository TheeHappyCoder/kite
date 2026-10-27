import "server-only";

import { BrandKit, EMPTY_BRAND, EmailTemplate, MAX_TEMPLATES, type TemplateInput } from "@/lib/design/brand";
import { getDb } from "./db";

// Designed mail: the brand kit (settings key "brand") and email templates (key "templates"),
// each one validated JSON record in the settings table. Kept out of preferences so they don't
// ride along every settings event.

function read(key: string): unknown {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown) {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(key, JSON.stringify(value));
}

export function getBrand(): BrandKit {
  const parsed = BrandKit.safeParse(read("brand"));
  return parsed.success ? parsed.data : EMPTY_BRAND;
}

export function saveBrand(brand: BrandKit): BrandKit {
  const next = BrandKit.parse(brand);
  write("brand", next);
  return next;
}

/** Templates, newest first. One that no longer validates is skipped rather than breaking the list. */
export function listTemplates(): EmailTemplate[] {
  const raw = read("templates");
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    const parsed = EmailTemplate.safeParse(t);
    return parsed.success ? [parsed.data] : [];
  });
}

/** Saves a new template, or replaces the one with this id. */
export function saveTemplate(input: TemplateInput, id?: string): EmailTemplate {
  const list = listTemplates();
  const template = EmailTemplate.parse({ ...input, id: id ?? crypto.randomUUID(), updatedAt: new Date().toISOString() });
  const rest = list.filter((t) => t.id !== template.id);
  if (rest.length >= MAX_TEMPLATES) throw new Error(`Kite keeps up to ${MAX_TEMPLATES} templates. Delete one first.`);
  write("templates", [template, ...rest]);
  return template;
}

export function deleteTemplate(id: string) {
  const list = listTemplates();
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return false;
  write("templates", next);
  return true;
}
