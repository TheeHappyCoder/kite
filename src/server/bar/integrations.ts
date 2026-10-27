import "server-only";

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getDb } from "../db";
import { getPreferences } from "../settings";

// Integrations: the apps and scripts the user let into the Kite bar (docs/bar.md). Each has a token,
// shown once when it's made and kept only as a SHA-256 hash, sent as `Authorization: Bearer <token>`.
// Paused or removed, its token stops working at once.

export type BarIntegration = { id: string; name: string; hint: string; enabled: boolean; createdAt: string; lastSeen: string | null };

type Row = { id: string; name: string; token_hint: string; enabled: number; created_at: string; last_seen: string | null };

const PREFIX = "kite_bar_";
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const fromRow = (row: Row): BarIntegration => ({
  id: row.id,
  name: row.name,
  hint: row.token_hint,
  enabled: row.enabled === 1,
  createdAt: row.created_at,
  lastSeen: row.last_seen,
});

export function listIntegrations(): BarIntegration[] {
  const rows = getDb().prepare("SELECT id, name, token_hint, enabled, created_at, last_seen FROM bar_integrations ORDER BY created_at").all() as Row[];
  return rows.map(fromRow);
}

function getIntegration(id: string): BarIntegration | null {
  const row = getDb().prepare("SELECT id, name, token_hint, enabled, created_at, last_seen FROM bar_integrations WHERE id = ?").get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

/** A new integration and its token (the only time the token is ever available). */
export function createIntegration(name: string): { integration: BarIntegration; token: string } {
  const token = PREFIX + randomBytes(24).toString("base64url");
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  getDb()
    .prepare("INSERT INTO bar_integrations (id, name, token_hash, token_hint, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)")
    .run(id, name, hash(token), token.slice(-4), createdAt);
  return { integration: getIntegration(id)!, token };
}

export function updateIntegration(id: string, patch: { name?: string; enabled?: boolean }) {
  const d = getDb();
  if (patch.name !== undefined) d.prepare("UPDATE bar_integrations SET name = ? WHERE id = ?").run(patch.name, id);
  if (patch.enabled !== undefined) d.prepare("UPDATE bar_integrations SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
  return getIntegration(id);
}

export function deleteIntegration(id: string) {
  return getDb().prepare("DELETE FROM bar_integrations WHERE id = ?").run(id).changes > 0;
}

const seen = new Map<string, number>();

/**
 * The integration a request comes from, or the response that refuses it. Only scripts and apps on
 * this computer: requests are already limited to Kite's own host (src/proxy.ts), and anything a web
 * page sends (it carries an Origin) is refused, so a site can't use a token it somehow learned.
 */
export function authorize(request: Request): { integration: BarIntegration } | { refused: NextResponse } {
  const refuse = (status: number, error: string) => ({ refused: NextResponse.json({ error }, { status }) });
  if (request.headers.get("origin")) return refuse(403, "The Kite bar API is for apps and scripts on this computer, not web pages.");
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  if (!token) return refuse(401, "Send your integration's token as `Authorization: Bearer <token>` (Kite → Settings → Kite bar → Add integration).");
  const row = getDb().prepare("SELECT id, name, token_hint, enabled, created_at, last_seen FROM bar_integrations WHERE token_hash = ?").get(hash(token)) as
    | Row
    | undefined;
  if (!row) return refuse(401, "That token isn't known to Kite. It may have been removed: make a new one in Settings → Kite bar.");
  if (!getPreferences().bar.integrations) return refuse(403, "Integrations are turned off in Kite (Settings → Kite bar).");
  if (row.enabled !== 1) return refuse(403, `"${row.name}" is paused in Kite (Settings → Kite bar).`);
  // Last seen, at most once a minute.
  const now = Date.now();
  if (now - (seen.get(row.id) ?? 0) > 60_000) {
    seen.set(row.id, now);
    row.last_seen = new Date(now).toISOString();
    getDb().prepare("UPDATE bar_integrations SET last_seen = ? WHERE id = ?").run(row.last_seen, row.id);
  }
  return { integration: fromRow(row) };
}
