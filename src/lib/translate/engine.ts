import type { WorkerReply, WorkerRequest } from "./worker";

// The reader's side of translation: gets a pair ready on the server (downloading it once, with the
// user's say-so), then hands the message's HTML to the worker. One worker for the app, made on first use.

type Prepared = { engine: string; pairs: WorkerRequest["pairs"] };

let worker: Worker | null = null;
let next = 0;
const waiting = new Map<number, (reply: WorkerReply) => void>();

function getWorker() {
  if (!worker) {
    worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<WorkerReply>) => {
      waiting.get(event.data.id)?.(event.data);
      waiting.delete(event.data.id);
    };
    // The worker itself failed (it couldn't load): every waiting translation says so, and the next makes a new one.
    worker.onerror = (event) => {
      event.preventDefault();
      for (const [id, resolve] of waiting) resolve({ id, error: `The translation engine stopped: ${event.message || "it couldn't load"}.` });
      waiting.clear();
      worker?.terminate();
      worker = null;
    };
  }
  return worker;
}

/** Downloads what `from` -> `to` needs (once) and says which files the worker loads. */
export async function prepareTranslation(from: string, to: string): Promise<Prepared> {
  const res = await fetch("/api/translate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, to }) });
  const data = (await res.json().catch(() => ({}))) as Prepared & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "Couldn't get the language ready.");
  return data;
}

/** Translates HTML (or escaped text) from `from` into `to`, on this computer. */
export async function translateHtml(html: string, from: string, to: string): Promise<string> {
  const prepared = await prepareTranslation(from, to);
  const id = ++next;
  const reply = await new Promise<WorkerReply>((resolve) => {
    waiting.set(id, resolve);
    getWorker().postMessage({ id, origin: location.origin, engine: prepared.engine, pairs: prepared.pairs, html } satisfies WorkerRequest);
  });
  if (reply.error || reply.html == null) throw new Error(reply.error ?? "Couldn't translate this.");
  return reply.html;
}
