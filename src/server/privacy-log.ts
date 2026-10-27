import "server-only";

import { getDb } from "./db";

// The privacy log: everything Kite sends anywhere other than the user's mail provider, kept on
// this computer so Settings → Privacy can show it. AI calls are logged one by one (what action,
// which emails by subject); routine lookups (avatars, DNS) are counted per day and service.
// The log holds no message text, keys or codes.

type SentKind = "ai" | "picture" | "dns" | "unsubscribe" | "setup" | "translation";

type LogEntry = { at: string; kind: SentKind; service: string; action: string; detail: string | null };

const KEEP_DAYS = 30;

let ready = false;
function db() {
  const d = getDb();
  if (!ready) {
    d.exec(`
      CREATE TABLE IF NOT EXISTS privacy_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        kind TEXT NOT NULL,
        service TEXT NOT NULL,
        action TEXT NOT NULL,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS privacy_counts (
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        service TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (day, kind, service)
      );
    `);
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString();
    d.prepare("DELETE FROM privacy_log WHERE at < ?").run(cutoff);
    d.prepare("DELETE FROM privacy_counts WHERE day < ?").run(cutoff.slice(0, 10));
    ready = true;
  }
  return d;
}

/** One deliberate send (an AI call, an unsubscribe), with a short description and no content. */
export function logSent(kind: SentKind, service: string, action: string, detail?: string) {
  try {
    db()
      .prepare("INSERT INTO privacy_log (at, kind, service, action, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), kind, service, action, detail ?? null);
  } catch {
    // The log never breaks the thing it records.
  }
}

/** A routine lookup, counted per day and service. */
export function countSent(kind: SentKind, service: string) {
  try {
    db()
      .prepare(
        `INSERT INTO privacy_counts (day, kind, service, count) VALUES (?, ?, ?, 1)
         ON CONFLICT(day, kind, service) DO UPDATE SET count = count + 1`,
      )
      .run(new Date().toISOString().slice(0, 10), kind, service);
  } catch {}
}

/** The last `days` days: deliberate sends newest first, and lookup counts per service. */
export function readLog(days = 7): { entries: LogEntry[]; counts: { kind: SentKind; service: string; count: number }[] } {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const entries = db()
    .prepare("SELECT at, kind, service, action, detail FROM privacy_log WHERE at >= ? ORDER BY at DESC LIMIT 200")
    .all(since) as LogEntry[];
  const counts = db()
    .prepare("SELECT kind, service, SUM(count) AS count FROM privacy_counts WHERE day >= ? GROUP BY kind, service ORDER BY count DESC")
    .all(since.slice(0, 10)) as { kind: SentKind; service: string; count: number }[];
  return { entries, counts };
}

export function clearLog() {
  db().exec("DELETE FROM privacy_log; DELETE FROM privacy_counts;");
}
