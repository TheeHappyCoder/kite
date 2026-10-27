import { NextResponse } from "next/server";
import * as z from "zod";
import { AiLimitReached, aiConfigured } from "@/server/ai";
import { rejectCrossSite } from "@/server/guard";
import { designRule } from "@/server/rule-design";

export const runtime = "nodejs";

/** "Describe a rule": the AI drafts a rule from the description; nothing is saved here (the editor opens it for review). */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = z.object({ description: z.string().trim().min(3).max(500) }).safeParse(await request.json());
  if (!body.success) return NextResponse.json({ error: "Describe what the automation should do" }, { status: 400 });
  if (!aiConfigured()) return NextResponse.json({ error: "Connect an AI first (sidebar → AI)", connect: true }, { status: 400 });
  try {
    return NextResponse.json({ draft: await designRule(body.data.description) });
  } catch (error) {
    if (error instanceof AiLimitReached) return NextResponse.json({ error: error.message, limit: error.limit }, { status: 429 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Couldn't draft that automation" }, { status: 502 });
  }
}
