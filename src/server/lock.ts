import "server-only";

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { PIN_LENGTH } from "@/lib/lock";
import { getDb } from "./db";

// App lock: a PIN that keeps people at this screen out of Kite. Stored as a salted scrypt hash in
// the settings table under its own key (never in preferences, so it never reaches the browser).
// Checks are throttled after wrong tries. It locks the window, not the data on disk (that's
// protected by the OS account; secrets are sealed, see secrets.ts). Never log PINs.

type Stored = { salt: string; hash: string };

const KEY = "lock";
const MAX_TRIES = 5;
const WAIT_MS = 30_000;

let failures = 0;
let blockedUntil = 0;

function read(): Stored | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as Stored) : null;
}

const hashPin = (pin: string, salt: string) => scryptSync(pin, Buffer.from(salt, "hex"), 32);

const PIN_PATTERN = new RegExp(String.raw`^\d{${PIN_LENGTH}}$`);

export function lockEnabled() {
  return read() != null;
}

/** Checks a PIN. Wrong tries are counted; after MAX_TRIES, checks wait WAIT_MS. */
export function verifyPin(pin: string): { ok: true } | { ok: false; waitMs?: number } {
  const stored = read();
  if (!stored) return { ok: true };
  const now = Date.now();
  if (now < blockedUntil) return { ok: false, waitMs: blockedUntil - now };
  const ok = PIN_PATTERN.test(pin) && timingSafeEqual(hashPin(pin, stored.salt), Buffer.from(stored.hash, "hex"));
  if (ok) {
    failures = 0;
    return { ok: true };
  }
  failures++;
  if (failures >= MAX_TRIES) {
    failures = 0;
    blockedUntil = now + WAIT_MS;
    return { ok: false, waitMs: WAIT_MS };
  }
  return { ok: false };
}

/** Sets or changes the PIN (the current one is required to change it). */
export function setPin(pin: string, current?: string) {
  if (!PIN_PATTERN.test(pin)) return { ok: false as const, error: `Use ${PIN_LENGTH} digits.` };
  if (lockEnabled() && !verifyPin(current ?? "").ok) return { ok: false as const, error: "Your current PIN didn't match." };
  const salt = randomBytes(16).toString("hex");
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(KEY, JSON.stringify({ salt, hash: hashPin(pin, salt).toString("hex") } satisfies Stored));
  return { ok: true as const };
}

/** Removes the lock (needs the current PIN). */
export function clearPin(current: string) {
  if (!verifyPin(current).ok) return { ok: false as const, error: "That PIN didn't match." };
  getDb().prepare("DELETE FROM settings WHERE key = ?").run(KEY);
  return { ok: true as const };
}
