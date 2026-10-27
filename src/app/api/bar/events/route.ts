import type { BarIntegrationEvent } from "@/lib/bar/spec";
import { authorize } from "@/server/bar/integrations";
import { onIntegrationEvent } from "@/server/bar/runtime";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** What the user does with an integration's activities, as server-sent events (docs/bar.md). */
export async function GET(request: Request) {
  const auth = authorize(request);
  if ("refused" in auth) return auth.refused;
  const encoder = new TextEncoder();
  let cleanup = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: BarIntegrationEvent | { type: "ping" } | { type: "ready"; integration: string }) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        } catch {
          cleanup();
        }
      };
      const stop = onIntegrationEvent(auth.integration.id, send);
      const heartbeat = setInterval(() => send({ type: "ping" }), 25_000);
      cleanup = () => {
        clearInterval(heartbeat);
        stop();
      };
      request.signal.addEventListener("abort", () => {
        cleanup();
        try {
          controller.close();
        } catch {}
      });
      send({ type: "ready", integration: auth.integration.name });
    },
    cancel() {
      cleanup();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive" } });
}
