// Shared helpers for `pnpm perf`: servers on their own ports and data folders, HTTP, stats.
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

export const ROOT = path.resolve(import.meta.dirname, "../..");
export const RUNS = path.join(ROOT, "perf", "results", "runs");

export const log = (...args) => console.log("[perf]", ...args);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function median(values) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
export const percentile = (values, p) => {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null;
};
export const round = (n, digits = 0) => (n == null ? null : Math.round(n * 10 ** digits) / 10 ** digits);
export const kb = (bytes) => round(bytes / 1024, 1);

export function compressedSizes(buffer) {
  return {
    raw: buffer.length,
    gzip: zlib.gzipSync(buffer, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buffer, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length,
  };
}

/** Makes a fresh scratch data folder under perf/results/tmp. */
export function scratchDir(name) {
  const dir = path.join(ROOT, "perf", "results", "tmp", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Copies the real local data (a consistent snapshot via VACUUM INTO) for a read-only run.
 * Everything that could act on the user's behalf is removed from the copy: scheduled sends,
 * snoozes (waking moves mail), follow-ups and AI settings. The server also runs with
 * KITE_PERF_READONLY=1, which refuses every third-party write.
 */
export function copyRealData(name, { fresh = false } = {}) {
  const source = path.join(ROOT, "data", "kite.sqlite");
  if (!fs.existsSync(source)) return null;
  const live = new DatabaseSync(source, { readOnly: true });
  const accounts = live.prepare("SELECT COUNT(*) AS n FROM accounts").get().n;
  if (!accounts) {
    live.close();
    return null;
  }
  const dir = scratchDir(name);
  live.exec(`VACUUM INTO '${path.join(dir, "kite.sqlite").replaceAll("'", "''")}'`);
  live.close();
  const db = new DatabaseSync(path.join(dir, "kite.sqlite"));
  // The app PIN goes too: the lock screen would cover the copy and block the browser suite.
  db.exec("DELETE FROM scheduled; DELETE FROM snoozes; DELETE FROM followups; DELETE FROM settings WHERE key IN ('ai', 'lock');");
  if (fresh) {
    // Same as Settings → "Reset local copy": a new user's first sync.
    db.exec("DELETE FROM threads_fts; DELETE FROM threads; DELETE FROM sync_state; UPDATE labels SET filled_at = NULL;");
  }
  db.close();
  // Tokens are encrypted with the key in secret.key (itself protected by the OS user account).
  const key = path.join(ROOT, "data", "secret.key");
  if (fs.existsSync(key)) fs.copyFileSync(key, path.join(dir, "secret.key"));
  for (const sub of fresh ? ["avatars", "assets"] : ["avatars", "assets", "attachments"]) {
    const from = path.join(ROOT, "data", sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true });
  }
  return dir;
}

/** Starts `next start` on the perf build with its own data folder; resolves once it answers. */
export async function startServer({ port, dataDir, label, env = {} }) {
  const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const child = spawn(process.execPath, [nextBin, "start", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "production",
      KITE_PERF_BUILD: "1",
      KITE_PERF: "1",
      KITE_PERF_READONLY: "1",
      KITE_DATA_DIR: dataDir,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (d) => output.push(String(d)));
  child.stderr.on("data", (d) => output.push(String(d)));
  const base = `http://127.0.0.1:${port}`;
  const started = Date.now();
  for (;;) {
    if (child.exitCode != null) throw new Error(`${label} server exited:\n${output.join("")}`);
    try {
      const res = await fetch(`${base}/api/perf`);
      if (res.ok) break;
    } catch {}
    if (Date.now() - started > 60_000) throw new Error(`${label} server did not start:\n${output.join("")}`);
    await sleep(250);
  }
  log(`${label} server up on ${base} (${Date.now() - started} ms)`);
  return {
    base,
    output,
    async stop() {
      if (child.exitCode != null) return;
      try {
        if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill("SIGTERM");
      } catch {}
      await sleep(500);
    },
  };
}

export async function getJson(base, route) {
  const res = await fetch(`${base}${route}`);
  if (!res.ok) throw new Error(`GET ${route} -> ${res.status}`);
  return res.json();
}

export async function postJson(base, route, body = {}) {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${route} -> ${res.status}`);
  return res.json();
}

export function totals(snapshot) {
  return snapshot.buckets.reduce(
    (sum, b) => ({ requests: sum.requests + b.requests, sent: sum.sent + b.sent, received: sum.received + b.received }),
    { requests: 0, sent: 0, received: 0 },
  );
}

/**
 * Waits until sync has nothing left to do: no pass running and less than `quietBytes`
 * received over the last `windowMs` (an idle tick only asks Gmail for history).
 */
export async function waitForSettled(base, { windowMs = 45_000, quietBytes = 40_000, timeoutMs = 15 * 60_000, onProgress } = {}) {
  const started = Date.now();
  const samples = [];
  for (;;) {
    const snap = await getJson(base, "/api/perf");
    const now = Date.now();
    samples.push({ at: now, received: totals(snap).received, running: snap.sync.running });
    while (samples.length && samples[0].at < now - windowMs) samples.shift();
    const oldest = samples[0];
    const quiet = now - started >= windowMs && snap.sync.running === 0 && snap.inflight === 0;
    if (quiet && samples.at(-1).received - oldest.received < quietBytes) return { ms: now - started, snapshot: snap };
    if (now - started > timeoutMs) return { ms: now - started, snapshot: snap, timedOut: true };
    onProgress?.(snap);
    await sleep(3000);
  }
}

export function summarizeBuckets(snapshot, top = 12) {
  return snapshot.buckets.slice(0, top).map((b) => ({ endpoint: b.key, requests: b.requests, receivedKB: kb(b.received), sentKB: kb(b.sent) }));
}
