import { NextResponse } from "next/server";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";
import { meterSnapshot, resetMeter } from "@/server/perf-meter";
import { syncActivity } from "@/server/sync";

export const runtime = "nodejs";

// Network meter readings for `pnpm perf`. Answers only when the server runs with KITE_PERF=1.

export async function GET(request: Request) {
  const foreign = rejectForeignHost(request);
  if (foreign) return foreign;
  const snapshot = process.env.KITE_PERF === "1" ? meterSnapshot() : null;
  if (!snapshot) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ...snapshot, sync: syncActivity() });
}

/** Starts a new measuring window. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request) ?? rejectForeignHost(request);
  if (rejected) return rejected;
  if (process.env.KITE_PERF !== "1") return NextResponse.json({ error: "Not found" }, { status: 404 });
  resetMeter();
  return NextResponse.json({ ok: true });
}
