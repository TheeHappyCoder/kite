import "server-only";

import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { applyPatch, DEFAULT_PREFERENCES, Preferences, type PreferencesPatch, type StorageInfo } from "@/lib/settings";
import { ATTACHMENT_DIR, clearAttachmentCache } from "./attachments";
import { getDb } from "./db";
import { dataDir } from "./paths";

const DATA_DIR = dataDir();

export function getPreferences(): Preferences {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'preferences'").get() as { value: string } | undefined;
  if (!row) return DEFAULT_PREFERENCES;
  try {
    return Preferences.parse(JSON.parse(row.value));
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function savePreferences(preferences: Preferences) {
  const next = Preferences.parse(preferences);
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('preferences', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(next));
  return next;
}

export function updatePreferences(patch: PreferencesPatch): Preferences {
  return savePreferences(applyPatch(getPreferences(), patch));
}

export function removeSignature(accountId: string) {
  updatePreferences({ signatures: { [accountId]: null } });
}

/** Senders waiting in the Screener. */
export function pendingSenderCount() {
  return (getDb().prepare("SELECT COUNT(*) AS n FROM senders WHERE status = 'pending'").get() as { n: number }).n;
}

async function fileSize(file: string) {
  return stat(file).then((s) => s.size).catch(() => 0);
}

async function dirSize(dir: string) {
  const entries = await readdir(dir).catch(() => [] as string[]);
  const sizes = await Promise.all(entries.map((name) => fileSize(path.join(dir, name))));
  return sizes.reduce((a, b) => a + b, 0);
}

export async function storageInfo(): Promise<StorageInfo> {
  const db = getDb();
  const base = path.join(DATA_DIR, "kite.sqlite");
  const [main, wal, avatars, attachments] = await Promise.all([
    fileSize(base),
    fileSize(`${base}-wal`),
    dirSize(path.join(DATA_DIR, "avatars")),
    dirSize(ATTACHMENT_DIR),
  ]);
  const totals = db.prepare("SELECT COUNT(*) AS threads, COALESCE(SUM(full), 0) AS offline FROM threads").get() as {
    threads: number;
    offline: number;
  };
  const perAccount = db.prepare(
    `SELECT a.id, (SELECT COUNT(*) FROM threads t WHERE t.account_id = a.id) AS threads, s.synced_at AS syncedAt, s.error
     FROM accounts a LEFT JOIN sync_state s ON s.account_id = a.id`,
  );
  return {
    database: main + wal,
    avatars,
    attachments,
    threads: totals.threads,
    offline: totals.offline,
    accounts: perAccount.all() as StorageInfo["accounts"],
  };
}

/** Removes cached sender pictures and downloaded attachments; both are fetched again on demand. */
export async function clearAvatarCache() {
  await rm(path.join(DATA_DIR, "avatars"), { recursive: true, force: true });
  await clearAttachmentCache();
}
