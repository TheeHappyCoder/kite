import { NextResponse } from "next/server";
import { rejectCrossSite } from "@/server/guard";
import { clearLog, readLog } from "@/server/privacy-log";

export const runtime = "nodejs";

/** The privacy log for the last 7 days: AI calls and other deliberate sends, plus lookup counts. */
export async function GET() {
  return NextResponse.json(readLog(7));
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  clearLog();
  return NextResponse.json({ ok: true });
}
