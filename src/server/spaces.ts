import "server-only";

import { randomUUID } from "node:crypto";
import { scopeSql, type AccountScope } from "@/lib/mail/scope";
import type { Thread } from "@/lib/mail/types";
import { SPACE_COLORS, SPACE_DEPTH, placeProblem, spaceDepth, within, type Space, type SpaceItems, type SpacePatch } from "@/lib/spaces";
import { getDb } from "./db";
import { liveThreadsByIds } from "./store";

// Spaces (lib/spaces.ts): the `spaces` tree and what each holds (`space_items`). Local only: no
// provider sees them, and sync and "Reset local copy" never write here.

type SpaceRow = {
  id: string;
  parent_id: string | null;
  name: string;
  color: string;
  note: string | null;
  position: number;
  created_at: string;
  threads: number;
};

export class SpaceError extends Error {
  name = "SpaceError";
}

const fromRow = (row: SpaceRow): Space => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  color: row.color,
  note: row.note,
  position: row.position,
  createdAt: row.created_at,
  threads: row.threads,
});

export function listSpaces(): Space[] {
  const rows = getDb()
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM space_items i WHERE i.space_id = s.id AND i.kind = 'thread') AS threads
       FROM spaces s ORDER BY s.position, s.name`,
    )
    .all() as SpaceRow[];
  return rows.map(fromRow);
}

export function spaceExists(id: string) {
  return !!getDb().prepare("SELECT 1 FROM spaces WHERE id = ?").get(id);
}

function getSpace(id: string) {
  return listSpaces().find((s) => s.id === id);
}

export function createSpace(input: { name: string; parentId?: string | null; color?: string }): Space {
  const spaces = listSpaces();
  const parent = input.parentId ? spaces.find((s) => s.id === input.parentId) : null;
  if (input.parentId && !parent) throw new SpaceError("That space isn't there any more.");
  if (parent && spaceDepth(spaces, parent.id) + 1 > SPACE_DEPTH - 1) throw new SpaceError("Pockets go four levels deep at most.");
  const siblings = spaces.filter((s) => s.parentId === (parent?.id ?? null));
  // A pocket wears its space's colour; a new space the first colour no other space wears.
  const color = input.color ?? parent?.color ?? SPACE_COLORS.find((c) => !spaces.some((s) => !s.parentId && s.color === c)) ?? SPACE_COLORS[0];
  const now = new Date().toISOString();
  const id = randomUUID().slice(0, 12);
  getDb()
    .prepare("INSERT INTO spaces (id, parent_id, name, color, note, position, created_at, updated_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)")
    .run(id, parent?.id ?? null, input.name, color, siblings.length, now, now);
  return getSpace(id)!;
}

export function updateSpace(id: string, patch: SpacePatch): Space {
  const spaces = listSpaces();
  const space = spaces.find((s) => s.id === id);
  if (!space) throw new SpaceError("That space isn't there any more.");
  if (patch.parentId !== undefined && patch.parentId !== space.parentId) {
    const problem = placeProblem(spaces, id, patch.parentId);
    if (problem) throw new SpaceError(problem);
  }
  const parentId = patch.parentId === undefined ? space.parentId : patch.parentId;
  const now = new Date().toISOString();
  getDb()
    .prepare("UPDATE spaces SET name = ?, color = ?, note = ?, parent_id = ?, updated_at = ? WHERE id = ?")
    .run(
      patch.name ?? space.name,
      patch.color ?? space.color,
      patch.note === undefined ? space.note : patch.note?.trim() ? patch.note : null,
      parentId,
      now,
      id,
    );
  // A colour change on a space carries to its pockets that still wore the old one.
  if (patch.color && patch.color !== space.color) {
    for (const pocket of within(spaces, id)) {
      if (pocket !== id) getDb().prepare("UPDATE spaces SET color = ? WHERE id = ? AND color = ?").run(patch.color, pocket, space.color);
    }
  }
  return getSpace(id)!;
}

/** Puts spaces in this order (one level: siblings). */
export function orderSpaces(ids: string[]) {
  const db = getDb();
  ids.forEach((id, position) => db.prepare("UPDATE spaces SET position = ? WHERE id = ?").run(position, id));
}

/** Deletes a space and its pockets. The mail in them stays where it is at the provider. Returns what Undo needs. */
export function deleteSpace(id: string) {
  const db = getDb();
  const ids = [...within(listSpaces(), id)];
  const marks = ids.map(() => "?").join(",");
  const spaces = db.prepare(`SELECT * FROM spaces WHERE id IN (${marks})`).all(...ids) as Omit<SpaceRow, "threads">[];
  const items = db.prepare(`SELECT * FROM space_items WHERE space_id IN (${marks})`).all(...ids) as ItemRow[];
  db.prepare(`DELETE FROM space_items WHERE space_id IN (${marks})`).run(...ids);
  db.prepare(`DELETE FROM spaces WHERE id IN (${marks})`).run(...ids);
  return { spaces, items };
}

type ItemRow = { space_id: string; kind: string; ref: string; account_id: string | null; added_at: string };

/** Puts back what deleteSpace took (Undo). */
export function restoreSpace(saved: ReturnType<typeof deleteSpace>) {
  const db = getDb();
  for (const s of saved.spaces) {
    db.prepare(
      "INSERT OR REPLACE INTO spaces (id, parent_id, name, color, note, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(s.id, s.parent_id, s.name, s.color, s.note, s.position, s.created_at, new Date().toISOString());
  }
  for (const i of saved.items) {
    db.prepare("INSERT OR IGNORE INTO space_items (space_id, kind, ref, account_id, added_at) VALUES (?, ?, ?, ?, ?)").run(i.space_id, i.kind, i.ref, i.account_id, i.added_at);
  }
}

/** Adds conversations to a space (and takes them out of `from`). Returns each thread's spaces after. */
export function moveItems({ to, from, threads }: SpaceItems): Record<string, string[]> {
  const db = getDb();
  if (to && !db.prepare("SELECT 1 FROM spaces WHERE id = ?").get(to)) throw new SpaceError("That space isn't there any more.");
  const now = new Date().toISOString();
  for (const ref of threads) {
    for (const space of from) if (space !== to) db.prepare("DELETE FROM space_items WHERE space_id = ? AND kind = 'thread' AND ref = ?").run(space, ref);
    if (to) {
      db.prepare("INSERT OR IGNORE INTO space_items (space_id, kind, ref, account_id, added_at) VALUES (?, 'thread', ?, ?, ?)").run(
        to,
        ref,
        ref.split(":")[0] || null,
        now,
      );
    }
  }
  return threadSpaces(threads);
}

/** The spaces each of these conversations is directly in. */
export function threadSpaces(threads?: string[]): Record<string, string[]> {
  const db = getDb();
  const rows = (
    threads
      ? threads.flatMap((ref) => db.prepare("SELECT space_id, ref FROM space_items WHERE kind = 'thread' AND ref = ?").all(ref))
      : db.prepare("SELECT space_id, ref FROM space_items WHERE kind = 'thread'").all()
  ) as { space_id: string; ref: string }[];
  const out: Record<string, string[]> = Object.fromEntries((threads ?? []).map((t) => [t, []]));
  for (const row of rows) (out[row.ref] ??= []).push(row.space_id);
  return out;
}

/** A space's conversations (its pockets' too) from the local copy, newest first. */
export function spaceThreads(id: string, scope: AccountScope): Thread[] {
  const ids = [...within(listSpaces(), id)];
  const { sql, args } = scopeSql(scope, "account_id");
  const refs = getDb()
    .prepare(`SELECT DISTINCT ref FROM space_items WHERE kind = 'thread' AND space_id IN (${ids.map(() => "?").join(",")}) AND ${sql}`)
    .all(...ids, ...args) as { ref: string }[];
  return liveThreadsByIds(refs.map((r) => r.ref));
}

/**
 * "Always put their mail here?": when every one of these conversations is from one sender (not one
 * of your own accounts) and that sender now has `AT_LEAST` conversations in the space, their address.
 */
export function senderToSuggest(spaceId: string, threads: string[]): { email: string; name: string } | null {
  const AT_LEAST = 3;
  const db = getDb();
  const rows = db
    .prepare(`SELECT DISTINCT lower(sender_email) AS email, sender_name AS name FROM threads WHERE id IN (SELECT value FROM json_each(?)) AND sender_email IS NOT NULL`)
    .all(JSON.stringify(threads)) as { email: string; name: string | null }[];
  const emails = new Set(rows.map((r) => r.email));
  if (emails.size !== 1) return null;
  const [{ email, name }] = rows;
  if (db.prepare("SELECT 1 FROM accounts WHERE lower(email) = ?").get(email)) return null;
  const { n } = db
    .prepare(
      `SELECT COUNT(*) AS n FROM space_items i JOIN threads t ON t.id = i.ref
       WHERE i.space_id = ? AND i.kind = 'thread' AND lower(t.sender_email) = ?`,
    )
    .get(spaceId, email) as { n: number };
  return n >= AT_LEAST ? { email, name: name || email } : null;
}
