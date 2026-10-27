import { NextResponse } from "next/server";
import { ALL_ACCOUNTS } from "@/lib/mail/scope";
import { rejectForeignHost } from "@/server/guard";
import { listNotes } from "@/server/notes";

export const runtime = "nodejs";

/** Every private note (Notes view): conversation notes for `?account=` (scope), and notes on people. */
export async function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const scope = new URL(request.url).searchParams.get("account") || ALL_ACCOUNTS;
  return NextResponse.json({ notes: listNotes(scope) });
}
