// Data usage: bytes Kite's server pulls from Gmail and others, measured on the wire by the
// server's network meter (KITE_PERF=1). Runs on a read-only copy of the real local data.
import { getJson, kb, log, postJson, round, sleep, summarizeBuckets, totals, waitForSettled } from "./lib.mjs";

const window = (snapshot, ms) => {
  const t = totals(snapshot);
  return { ms, requests: t.requests, receivedKB: kb(t.received), sentKB: kb(t.sent), byEndpoint: summarizeBuckets(snapshot) };
};

/** Startup catch-up, then `idleMinutes` of idle sync (extrapolated to an hour), then opening older threads. */
export async function steadyScenarios(base, { idleMinutes, openCount = 20 }) {
  const results = {};

  await postJson(base, "/api/perf");
  await getJson(base, "/api/accounts"); // starts the sync loop
  const started = Date.now();
  const startup = await waitForSettled(base);
  results.startupCatchUp = { ...window(startup.snapshot, Date.now() - started), timedOut: !!startup.timedOut };
  log(`startup catch-up: ${results.startupCatchUp.receivedKB} KB in ${results.startupCatchUp.requests} requests`);

  await postJson(base, "/api/perf");
  log(`idling ${idleMinutes} min…`);
  await sleep(idleMinutes * 60_000);
  const idle = await getJson(base, "/api/perf");
  const idleWindow = window(idle, idleMinutes * 60_000);
  results.idle = { ...idleWindow, perHourKB: round((idleWindow.receivedKB * 60) / idleMinutes, 1), perHourRequests: round((idleWindow.requests * 60) / idleMinutes) };
  log(`idle: ${results.idle.perHourKB} KB/hour`);

  // Older conversations aren't prefetched, so opening them downloads full bodies.
  const archive = await getJson(base, "/api/mail/threads?mailbox=archive");
  const targets = archive.threads.slice(-openCount);
  await postJson(base, "/api/perf");
  const openStarted = Date.now();
  for (const t of targets) {
    const key = t.id.slice(t.accountId.length + 1);
    await fetch(`${base}/api/mail/threads/${encodeURIComponent(key)}?account=${encodeURIComponent(t.accountId)}`);
  }
  const opened = await getJson(base, "/api/perf");
  const openWindow = window(opened, Date.now() - openStarted);
  results.openOldThreads = {
    ...openWindow,
    threads: targets.length,
    perThreadKB: targets.length ? round(openWindow.receivedKB / targets.length, 1) : null,
    perThreadMs: targets.length ? round(openWindow.ms / targets.length) : null,
  };
  log(`open ${targets.length} old threads: ${results.openOldThreads.perThreadKB} KB each`);
  return results;
}

/** A new user's first sync (local copy reset), until sync has nothing left to do. */
export async function initialSyncScenario(base) {
  await postJson(base, "/api/perf");
  const { accounts } = await getJson(base, "/api/accounts");
  const started = Date.now();
  let lastLog = 0;
  // An account whose sign-in the provider refuses (its refresh token in data/ revoked or expired)
  // can't sync in the copy either: name it, so a missing first pass isn't read as slow sync.
  const reconnect = new Set();
  // What a new user sees: the first rows, then the first pass done (everything after is background).
  const marks = { firstRowsMs: null, firstPassMs: null };
  let checking = false;
  const check = async () => {
    if (checking || marks.firstPassMs) return;
    checking = true;
    try {
      const byAccount = Object.entries((await getJson(base, "/api/mail/threads?mailbox=drafts")).sync ?? {});
      for (const [id, a] of byAccount) if (a.reconnect) reconnect.add(accounts.find((x) => x.id === id)?.provider ?? id);
      const sync = byAccount.map(([, a]) => a);
      const stored = sync.reduce((n, a) => n + (a.stored ?? 0), 0);
      if (marks.firstRowsMs == null && stored >= 20) marks.firstRowsMs = Date.now() - started;
      if (sync.length && sync.every((a) => a.ready)) marks.firstPassMs = Date.now() - started;
    } catch {}
    checking = false;
  };
  const settled = await waitForSettled(base, {
    timeoutMs: 20 * 60_000,
    onProgress: (snap) => {
      void check();
      if (Date.now() - lastLog > 30_000) {
        lastLog = Date.now();
        log(`initial sync: ${kb(totals(snap).received)} KB so far`);
      }
    },
  });
  while (checking) await sleep(100);
  await check();
  const threads = (await getJson(base, "/api/mail/threads?mailbox=inbox")).sync;
  const stored = Object.values(threads).reduce((s, a) => s + (a.stored ?? 0), 0);
  const result = { ...window(settled.snapshot, Date.now() - started), ...marks, timedOut: !!settled.timedOut, storedThreads: stored, needsReconnect: [...reconnect] };
  result.perThreadKB = stored ? round(result.receivedKB / stored, 2) : null;
  result.serverRssMB = round(settled.snapshot.memory.rss / 1024 / 1024, 1);
  log(`initial sync: ${result.receivedKB} KB for ${stored} threads in ${round(result.ms / 1000)} s (first rows ${marks.firstRowsMs == null ? "never" : `${round(marks.firstRowsMs / 1000)} s`}, first pass ${marks.firstPassMs == null ? `never: ${reconnect.size ? `${[...reconnect].join(", ")} needs Reconnect in data/` : "an account never finished"}` : `${round(marks.firstPassMs / 1000)} s`})`);
  return result;
}
