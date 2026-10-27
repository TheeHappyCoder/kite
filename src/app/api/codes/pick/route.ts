import { NextResponse } from "next/server";
import * as z from "zod";
import { pickCode } from "@/server/codes";
import { rejectCrossSite } from "@/server/guard";

export const runtime = "nodejs";

const Body = z.object({ id: z.string().min(3).max(800), index: z.number().int().min(0).max(2) });

/** The user copied one part of a code Kite couldn't settle: remembered for that sender, returns the value. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That didn't look right" }, { status: 400 });
  const code = pickCode(parsed.data.id, parsed.data.index);
  if (!code) return NextResponse.json({ error: "That code has expired" }, { status: 404 });
  return NextResponse.json({ code });
}
