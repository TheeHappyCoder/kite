import { NextResponse } from "next/server";
import * as z from "zod";
import { OverridePatch } from "@/lib/mail/overrides";
import { rejectCrossSite } from "@/server/guard";
import { updateOverride } from "@/server/overrides";

export const runtime = "nodejs";

const Body = OverridePatch.extend({ threadId: z.string().min(1).max(300) });

/** Changes one conversation's local state: chat view, mute, pin, note or subject. Gmail is untouched. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That change didn't look right" }, { status: 400 });
  const { threadId, ...patch } = parsed.data;
  return NextResponse.json({ override: updateOverride(threadId, patch) });
}
