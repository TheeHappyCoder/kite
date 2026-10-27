import { NextResponse } from "next/server";
import { usageSetup } from "@/server/ai";
import { usageReport } from "@/server/ai-usage";

export const runtime = "nodejs";

/** Settings → AI: what AI calls used today and this month, the limits, by action and the latest calls (read-only). */
export async function GET() {
  return NextResponse.json(usageReport(usageSetup()));
}
