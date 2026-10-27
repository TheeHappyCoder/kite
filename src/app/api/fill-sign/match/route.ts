import { NextResponse } from "next/server";
import { FormPrint } from "@/lib/pdf/layout";
import { matchLayout } from "@/server/fill-layouts";
import { rejectCrossSite } from "@/server/guard";

export const runtime = "nodejs";

/** The remembered layout this form matches with confidence, or null. Read-only; POST only to carry the print. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = FormPrint.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ layout: null });
  return NextResponse.json({ layout: matchLayout(parsed.data) });
}
