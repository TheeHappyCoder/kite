import { rejectForeignHost } from "@/server/guard";
import { ensureSyncLoop, syncEvents, type SyncEvent } from "@/server/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Server-sent events: the client refreshes its view when the sync engine reports changes. */
export async function GET(request: Request) {
  // Events carry sign-in codes: only Kite's own host may read them.
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  ensureSyncLoop();
  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream({
    start(controller) {
      const send = (event: SyncEvent | { type: "ping" }) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const onEvent = (event: SyncEvent) => send(event);
      const heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
      syncEvents.on("event", onEvent);
      cleanup = () => {
        clearInterval(heartbeat);
        syncEvents.off("event", onEvent);
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      send({ type: "ping" });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
