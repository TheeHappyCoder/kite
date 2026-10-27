import "server-only";

import { ProviderError, ReconnectRequired } from "../../mail/errors";
import { getAccessToken } from "./oauth";

// Microsoft Graph calls for one mailbox. Ids are immutable (they survive moves between folders),
// at most four requests run at once per mailbox (Graph's own limit), and throttled requests wait
// as long as Graph asks (Retry-After).

const API = "https://graph.microsoft.com/v1.0";
const PER_MAILBOX = 4;
const MAX_ATTEMPTS = 4;

export class GraphError extends ProviderError {
  constructor(message: string, status: number, public code?: string) {
    super(message, status, "Outlook");
  }
}

type Slots = { active: number; queue: (() => void)[] };
const g = globalThis as typeof globalThis & { __kiteGraphSlots?: Map<string, Slots> };
const slots = (g.__kiteGraphSlots ??= new Map());

async function withSlot<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  let s = slots.get(accountId);
  if (!s) slots.set(accountId, (s = { active: 0, queue: [] }));
  // A finished request hands its slot straight to the next one waiting.
  if (s.active >= PER_MAILBOX) await new Promise<void>((r) => s.queue.push(r));
  else s.active++;
  try {
    return await fn();
  } finally {
    const next = s.queue.shift();
    if (next) next();
    else s.active--;
  }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Init = Omit<RequestInit, "body"> & { body?: unknown; bytes?: boolean };

/** One Graph request. `body` objects go as JSON; `bytes` returns the raw response. */
export async function graph<T>(accountId: string, path: string, init: Init = {}): Promise<T> {
  return withSlot(accountId, async () => {
    for (let attempt = 1; ; attempt++) {
      const token = await getAccessToken(accountId);
      const json = init.body !== undefined && !(init.body instanceof Uint8Array) && typeof init.body !== "string";
      const res = await fetch(path.startsWith("https://") ? path : `${API}${path}`, {
        ...init,
        body: json ? JSON.stringify(init.body) : (init.body as BodyInit | undefined),
        headers: {
          authorization: `Bearer ${token}`,
          prefer: 'IdType="ImmutableId"',
          ...(json ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.ok) {
        if (init.bytes) return Buffer.from(await res.arrayBuffer()) as T;
        const text = await res.text();
        return (text ? JSON.parse(text) : null) as T;
      }
      // The grant was withdrawn (or the token can't be used any more): the user signs in again.
      if (res.status === 401) throw new ReconnectRequired(accountId);
      const retryable = res.status === 429 || res.status === 503 || res.status === 504 || res.status === 500;
      if (retryable && attempt < MAX_ATTEMPTS) {
        const after = Number(res.headers.get("retry-after"));
        await wait(Math.min(30, Number.isFinite(after) && after > 0 ? after : 2 ** attempt) * 1000);
        continue;
      }
      const detail = await res.text();
      let code: string | undefined;
      try {
        code = JSON.parse(detail)?.error?.code;
      } catch {}
      throw new GraphError(`Graph ${init.method ?? "GET"} ${path.split("?")[0]} failed (${res.status}): ${detail.slice(0, 200)}`, res.status, code);
    }
  });
}

type Page<T> = { value?: T[]; "@odata.nextLink"?: string };

/** Every item of a list, following nextLink pages, up to `max`; `onPage` sees each page. */
export async function pages<T>(accountId: string, path: string, max: number, onPage?: (items: T[]) => boolean | void) {
  const items: T[] = [];
  let next: string | undefined = path;
  while (next && items.length < max) {
    const page: Page<T> = await graph<Page<T>>(accountId, next);
    const found = page.value ?? [];
    items.push(...found);
    // A page callback returning false stops early (it has what it needs).
    if (onPage?.(found) === false) break;
    next = page["@odata.nextLink"];
  }
  return items.slice(0, max);
}

/** A value inside an OData string literal ('it''s'). */
export function odata(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

type BatchResponse = { id: string; status: number; body?: unknown };

/** Up to 20 GETs in one request (Graph's JSON batching); each answer comes back with its own status. */
export async function batchGet(accountId: string, urls: string[]): Promise<BatchResponse[]> {
  const out: BatchResponse[] = [];
  for (let i = 0; i < urls.length; i += 20) {
    const requests = urls.slice(i, i + 20).map((url, n) => ({ id: String(i + n), method: "GET", url }));
    const res = await graph<{ responses?: BatchResponse[] }>(accountId, "/$batch", { method: "POST", body: { requests } });
    out.push(...(res.responses ?? []));
  }
  return out.sort((a, b) => Number(a.id) - Number(b.id));
}
