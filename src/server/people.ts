import "server-only";

import { patchPerson, personKey, type PersonPatch, type PersonPrefs } from "@/lib/mail/person-prefs";
import { getDb } from "./db";

// Local per-person state (people table). Only the user writes here; sync never does, so it
// survives every upsert and "Reset local copy". Notes are private: never log them.

type PersonRow = { email: string; vip: number; note: string | null; images: number };

function fromRow(row: PersonRow): PersonPrefs {
  const p: PersonPrefs = {};
  if (row.vip) p.vip = true;
  if (row.note) p.note = row.note;
  if (row.images) p.images = true;
  return p;
}

export function listPeople(): Record<string, PersonPrefs> {
  const rows = getDb().prepare("SELECT email, vip, note, images FROM people").all() as PersonRow[];
  return Object.fromEntries(rows.map((r) => [r.email, fromRow(r)]));
}

function getPerson(email: string): PersonPrefs | undefined {
  const row = getDb().prepare("SELECT email, vip, note, images FROM people WHERE email = ?").get(email) as PersonRow | undefined;
  return row ? fromRow(row) : undefined;
}

/** Applies one change and returns what is kept (null: the row is gone). */
export function updatePerson({ email, ...patch }: PersonPatch): PersonPrefs | null {
  const key = personKey(email);
  const next = patchPerson(getPerson(key), patch);
  const db = getDb();
  if (!next) db.prepare("DELETE FROM people WHERE email = ?").run(key);
  else
    db.prepare(
      `INSERT INTO people (email, vip, note, note_at, images, updated_at) VALUES (?1, ?2, ?3, CASE WHEN ?3 IS NULL THEN NULL ELSE ?5 END, ?4, ?5)
       ON CONFLICT(email) DO UPDATE SET vip = excluded.vip, note = excluded.note, images = excluded.images, updated_at = excluded.updated_at,
         note_at = CASE WHEN excluded.note IS NULL THEN NULL WHEN excluded.note IS people.note THEN people.note_at ELSE excluded.updated_at END`,
    ).run(key, next.vip ? 1 : 0, next.note ?? null, next.images ? 1 : 0, new Date().toISOString());
  return next;
}
