import dc from "node:diagnostics_channel";

// Network meter for `pnpm perf` (KITE_PERF=1 only). Counts every outgoing request and its
// bytes on the wire (compressed, as billed) per host and endpoint, through undici's
// diagnostics channels. KITE_PERF_READONLY=1 also refuses every write to a third party
// (only token refreshes may POST), so a run on a copy of real data can't send, modify or call AI.

type Bucket = { key: string; requests: number; sent: number; received: number };
type Meter = { since: number; lastAt: number; inflight: number; buckets: Map<string, Bucket> };
type UndiciRequest = { origin?: string | URL; path?: string; method?: string };

const g = globalThis as typeof globalThis & { __kitePerf?: Meter };

const KNOWN_HOSTS = new Set([
  "gmail.googleapis.com",
  "oauth2.googleapis.com",
  "openidconnect.googleapis.com",
  "people.googleapis.com",
  "graph.microsoft.com",
  "login.microsoftonline.com",
  "cloudflare-dns.com",
  "gravatar.com",
  "icons.duckduckgo.com",
  "api.anthropic.com",
]);

/** host + path with ids folded, plus Gmail's `format`, so endpoints group: `gmail.googleapis.com GET /threads/:id?format=full`. */
function keyOf(request: UndiciRequest) {
  const origin = new URL(String(request.origin ?? "http://unknown"));
  const host = origin.hostname;
  if (!KNOWN_HOSTS.has(host)) return `other hosts ${request.method ?? "GET"} (avatars, site icons, links)`;
  const [rawPath, query = ""] = (request.path ?? "/").split("?");
  const path = rawPath
    .replace(/^\/gmail\/v1\/users\/me|^\/upload\/gmail\/v1\/users\/me|^\/v1\.0\/me/, "")
    .split("/")
    .map((part) => (/^[0-9a-f]{12,}$|^\d+$|^[A-Za-z0-9_-]{20,}$|^r-?\d+$/i.test(part) || part.includes("@") ? ":id" : part))
    .join("/");
  const format = new URLSearchParams(query).get("format");
  const hostPart = host === "gravatar.com" || host === "icons.duckduckgo.com" ? host : `${host} ${request.method ?? "GET"} ${path}`;
  return `${hostPart}${format ? `?format=${format}` : ""}`;
}

export function installMeter() {
  if (g.__kitePerf) return;
  const meter: Meter = { since: Date.now(), lastAt: 0, inflight: 0, buckets: new Map() };
  g.__kitePerf = meter;
  const keys = new WeakMap<object, Bucket>();
  const bucketFor = (request: object) => keys.get(request);

  dc.subscribe("undici:request:create", (message) => {
    const { request } = message as { request: UndiciRequest };
    const key = keyOf(request);
    let bucket = meter.buckets.get(key);
    if (!bucket) meter.buckets.set(key, (bucket = { key, requests: 0, sent: 0, received: 0 }));
    bucket.requests++;
    meter.inflight++;
    meter.lastAt = Date.now();
    keys.set(request as object, bucket);
  });
  dc.subscribe("undici:request:bodyChunkSent", (message) => {
    const { request, chunk } = message as { request: object; chunk: Uint8Array | string };
    const bucket = bucketFor(request);
    if (bucket) bucket.sent += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
  });
  dc.subscribe("undici:request:bodyChunkReceived", (message) => {
    const { request, chunk } = message as { request: object; chunk: Uint8Array };
    const bucket = bucketFor(request);
    if (bucket) bucket.received += chunk.byteLength;
    meter.lastAt = Date.now();
  });
  const done = () => {
    meter.inflight = Math.max(0, meter.inflight - 1);
    meter.lastAt = Date.now();
  };
  dc.subscribe("undici:request:trailers", done);
  dc.subscribe("undici:request:error", done);

  if (process.env.KITE_PERF_READONLY === "1") {
    const original = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      // Read method and URL without building a Request, which would consume a streamed body.
      const url = input instanceof Request ? input.url : String(input);
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const { hostname } = new URL(url);
      const local = hostname === "127.0.0.1" || hostname === "localhost";
      // Token refreshes are POSTs: Google's token endpoint, and Microsoft's (login.microsoftonline.com/…/token).
      const tokenRefresh = hostname === "oauth2.googleapis.com" || (hostname === "login.microsoftonline.com" && new URL(url).pathname.endsWith("/token"));
      // Graph's JSON batch is a POST that only reads when every request inside it is a GET.
      const readBatch = hostname === "graph.microsoft.com" && new URL(url).pathname.endsWith("/$batch") && batchOnlyReads(init?.body);
      if (!local && method !== "GET" && method !== "HEAD" && !tokenRefresh && !readBatch) {
        return Promise.reject(new Error(`Blocked by perf read-only mode: ${method} ${hostname}`));
      }
      return original(input, init);
    };
  }
}

function batchOnlyReads(body: unknown) {
  if (typeof body !== "string") return false;
  try {
    const requests = (JSON.parse(body) as { requests?: { method?: string }[] }).requests;
    return Array.isArray(requests) && requests.length > 0 && requests.every((r) => (r.method ?? "GET").toUpperCase() === "GET");
  } catch {
    return false;
  }
}

export function meterSnapshot() {
  const meter = g.__kitePerf;
  if (!meter) return null;
  return {
    since: meter.since,
    lastAt: meter.lastAt,
    inflight: meter.inflight,
    buckets: [...meter.buckets.values()].sort((a, b) => b.received - a.received),
    memory: process.memoryUsage(),
  };
}

export function resetMeter() {
  const meter = g.__kitePerf;
  if (!meter) return;
  meter.buckets.clear();
  meter.since = Date.now();
}
