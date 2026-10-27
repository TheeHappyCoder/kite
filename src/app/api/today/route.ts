import { NextResponse } from "next/server";
import { collectToday } from "@/server/today";

export const runtime = "nodejs";

/** Today: calendar events, nudges, snoozes waking, scheduled sends and pins, from the local copy (read-only). */
export async function GET(request: Request) {
  const account = new URL(request.url).searchParams.get("account") || "all";
  return NextResponse.json(collectToday(account));
}
