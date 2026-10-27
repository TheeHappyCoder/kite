import { NextResponse } from "next/server";
import * as z from "zod";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { listRuns, undoRuns } from "@/server/rules";
import { notifyChanged } from "@/server/sync";

export const runtime = "nodejs";

/** What rules did in the last 30 days. */
export async function GET() {
  return NextResponse.json({ runs: listRuns() });
}

const Undo = z.object({ undo: z.array(z.string().max(64)).min(1).max(500) });

/** Undoes runs; the rules then leave those conversations alone. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const { undo } = Undo.parse(await request.json());
    const result = await undoRuns(undo);
    result.accounts.forEach(notifyChanged);
    return NextResponse.json({ undone: result.undone, runs: listRuns() });
  } catch (error) {
    return errorResponse(error);
  }
}
