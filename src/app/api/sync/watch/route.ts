import { NextResponse } from "next/server";
import { rejectCrossSite } from "@/server/guard";
import { checkNow, ensureSyncLoop, markWatched } from "@/server/sync";

export const runtime = "nodejs";

/** A slow provider doesn't hold a refresh longer than this; its check carries on and lands by SSE. */
const NOW_MS = 15_000;

/**
 * A Kite window is on screen (sent about once a minute while visible): new mail is checked every few seconds.
 * `{ now: true }` (Refresh) reads every account's change feed now and answers once it's done.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  ensureSyncLoop();
  markWatched();
  const body = (await request.json().catch(() => ({}))) as { now?: unknown };
  if (body.now === true) await Promise.race([checkNow(), new Promise((done) => setTimeout(done, NOW_MS))]);
  return NextResponse.json({ ok: true });
}
