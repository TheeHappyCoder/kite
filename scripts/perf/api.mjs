// Local API: how long each route takes and how big its answer is (what the app downloads
// from its own server). Read-only routes only.
import zlib from "node:zlib";
import { getJson, kb, median, round } from "./lib.mjs";

const REPEAT = 7;

async function time(base, route) {
  const runs = [];
  let body = null;
  for (let i = 0; i < REPEAT; i++) {
    const started = performance.now();
    const res = await fetch(`${base}${route}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    runs.push(performance.now() - started);
    if (!res.ok) return { route, status: res.status };
    body = buffer;
  }
  runs.shift(); // first call warms caches
  return {
    route,
    medianMs: round(median(runs), 1),
    maxMs: round(Math.max(...runs), 1),
    rawKB: kb(body.length),
    gzipKB: kb(zlib.gzipSync(body).length),
  };
}

export async function apiSuite(base) {
  const inbox = await getJson(base, "/api/mail/threads?mailbox=inbox");
  const accountId = inbox.threads[0]?.accountId;
  const routes = [
    "/api/accounts",
    "/api/settings",
    "/api/mail/threads?mailbox=inbox",
    "/api/mail/threads?mailbox=archive",
    "/api/mail/threads?mailbox=inbox&q=invoice",
    "/api/mail/threads?mailbox=inbox&q=from:google",
    "/api/today",
    "/api/files",
    "/api/labels",
    "/api/home",
  ];
  // Open the newest conversations that are already stored in full (local only, no Gmail).
  const opened = inbox.threads.slice(0, 5).map((t) => `/api/mail/threads/${encodeURIComponent(t.id.slice(t.accountId.length + 1))}?account=${encodeURIComponent(accountId)}`);
  const results = [];
  for (const route of routes) results.push(await time(base, route));
  const threadRuns = [];
  for (const route of opened) threadRuns.push(await time(base, route));
  const ok = threadRuns.filter((r) => r.medianMs != null);
  results.push({
    route: "/api/mail/threads/[id] (5 recent)",
    medianMs: round(median(ok.map((r) => r.medianMs)), 1),
    maxMs: round(Math.max(0, ...ok.map((r) => r.maxMs)), 1),
    rawKB: round(median(ok.map((r) => r.rawKB)), 1),
    gzipKB: round(median(ok.map((r) => r.gzipKB)), 1),
  });
  return { routes: results, inboxThreads: inbox.threads.length };
}
