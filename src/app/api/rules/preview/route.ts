import { NextResponse } from "next/server";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { previewRule } from "@/server/rules";

export const runtime = "nodejs";

/** How many conversations from the last 30 days a rule being edited would have matched (POST: the draft is a body, never a URL). */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    return NextResponse.json(previewRule(await request.json()));
  } catch (error) {
    return errorResponse(error);
  }
}
