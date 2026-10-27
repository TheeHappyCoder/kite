import { NextResponse } from "next/server";
import * as z from "zod";
import { errorResponse } from "@/server/errors";
import { closeExpectation, reopenExpectation, stepDraft } from "@/server/expectations";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";
import { notifyChanged } from "@/server/sync";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * The request or nudge that's ready, as a draft to send or edit (the app sends it through the
 * usual send route, so Undo send works; the wait counts it when it goes). `missing`: blanks Kite
 * couldn't fill, so the app opens it in compose instead of sending.
 */
export async function GET(request: Request, { params }: Context) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const made = stepDraft((await params).id);
  if (!made) return NextResponse.json({ error: "Nothing is ready to send for this one." }, { status: 409 });
  return NextResponse.json({ draft: made.draft, missing: made.missing, step: made.step });
}

const Op = z.object({ op: z.enum(["received", "stop", "reopen"]) });

/** Received (or paid): settled by hand. Stop: no more waiting. Reopen: Undo of either. */
export async function POST(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const { op } = Op.parse(await request.json());
    const accountId = op === "reopen" ? reopenExpectation(id) : closeExpectation(id, op === "received" ? "met" : "stopped");
    notifyChanged(accountId);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
