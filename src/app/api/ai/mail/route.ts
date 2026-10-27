import { NextResponse } from "next/server";
import * as z from "zod";
import type { Thread } from "@/lib/mail/types";
import { THREAD_KEY } from "@/lib/mail/threads";
import { AiLimitReached, AiUnavailable, aiConfigured } from "@/server/ai";
import { draftReply, rewriteText, summariseThread } from "@/server/ai-mail";
import { REWRITE_INSTRUCTION_MAX, REWRITE_STYLES } from "@/lib/ai-mail";
import { getAccount } from "@/server/db";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { loadFullThread } from "@/server/sync";

export const runtime = "nodejs";

// On-click AI on mail: Summarise and Draft with AI (one conversation), Rewrite (the text sent).
// Each runs only from a click in the app; nothing here is called by sync.

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("summarise"), account: z.string(), thread: z.string().regex(THREAD_KEY) }),
  z.object({ kind: z.literal("draft"), account: z.string(), thread: z.string().regex(THREAD_KEY), notes: z.string().max(4_000).default("") }),
  z.object({
    kind: z.literal("rewrite"),
    text: z.string().trim().min(1, "Select some text to rewrite").max(20_000, "That's too long to rewrite in one go"),
    style: z.enum(REWRITE_STYLES).nullable().default(null),
    instruction: z.string().max(REWRITE_INSTRUCTION_MAX, "Keep the instruction shorter").default(""),
  }),
]);

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "That didn't look right" }, { status: 400 });
  if (!aiConfigured()) return NextResponse.json({ error: "Connect an AI first", connect: true }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.kind === "rewrite") {
      if (!body.style && !body.instruction.trim()) return NextResponse.json({ error: "Say how to rewrite it" }, { status: 400 });
      return NextResponse.json({ text: await rewriteText(body.text, body.style, body.instruction) });
    }
    const account = getAccount(body.account);
    if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
    const row = await loadFullThread(account, body.thread);
    if (!row) return NextResponse.json({ error: "That conversation isn't here any more" }, { status: 404 });
    const thread = JSON.parse(row.data) as Thread;
    if (body.kind === "summarise") return NextResponse.json({ summary: await summariseThread(account, thread) });
    return NextResponse.json({ body: await draftReply(account, thread, body.notes) });
  } catch (error) {
    if (error instanceof AiLimitReached) return NextResponse.json({ error: error.message, limit: error.limit }, { status: 429 });
    if (error instanceof AiUnavailable) return NextResponse.json({ error: error.message }, { status: 502 });
    return errorResponse(error);
  }
}
