import { NextResponse } from "next/server";
import * as z from "zod";
import { rejectCrossSite } from "@/server/guard";
import { detectLanguage } from "@/server/detect-language";

export const runtime = "nodejs";

const Body = z.object({ text: z.string().max(4000) });

/**
 * Which language a message's text is in (server/detect-language.ts), worked out here on this
 * computer so the reader doesn't carry the language statistics. Nothing is kept or sent anywhere.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That didn't look right" }, { status: 400 });
  return NextResponse.json({ language: detectLanguage(parsed.data.text) });
}
