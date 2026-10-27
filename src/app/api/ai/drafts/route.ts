import { NextResponse } from "next/server";
import * as z from "zod";
import { AiDraftPrefs } from "@/lib/settings";
import { aiDraftsView, resumeAiDrafts } from "@/server/ai-drafts";
import { rejectCrossSite } from "@/server/guard";
import { updatePreferences } from "@/server/settings";
import { warmKey } from "@/server/secrets";

export const runtime = "nodejs";

// Rules' "Draft with AI": the switch that pauses all of it, what's waiting, and Resume after errors
// (server/ai-drafts.ts). What it uses is in the usage ledger (/api/ai/usage).

export async function GET() {
  // Whether an AI is connected needs the key: wait for the startup unwrap.
  await warmKey();
  return NextResponse.json(aiDraftsView());
}

const Body = z.object({
  on: AiDraftPrefs.shape.on.unwrap().optional(),
  resume: z.boolean().optional(),
});

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "That didn't look right" }, { status: 400 });
  const { resume, on } = parsed.data;
  if (on !== undefined) updatePreferences({ aiDrafts: { on } });
  if (resume) resumeAiDrafts();
  await warmKey();
  return NextResponse.json(aiDraftsView());
}
