import { NextResponse } from "next/server";
import * as z from "zod";
import { THREAD_KEY } from "@/lib/mail/threads";
import { rejectCrossSite } from "@/server/guard";
import { previewMailBatch, executeMailBatch, undoMailBatch, refreshTrash } from "@/server/mail-batch";

export const runtime = "nodejs";
const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview"), account: z.string().min(1).max(4000), action: z.enum(["trash", "archive", "permanent"]), threads: z.array(z.object({ account: z.string(), id: z.string().regex(THREAD_KEY) })).min(1).max(1000).optional(), senders: z.array(z.email().toLowerCase()).min(1).max(500).optional(), inboxOnly: z.boolean().optional(), unsubscribe: z.boolean().optional() }),
  z.object({ kind: z.enum(["execute", "undo"]), token: z.uuid() }),
  z.object({ kind: z.literal("refresh"), account: z.string().min(1).max(4000) }),
]);
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid mail selection." }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.kind === "preview") return NextResponse.json(await previewMailBatch(body));
    if (body.kind === "execute") return NextResponse.json(await executeMailBatch(body.token));
    if (body.kind === "undo") return NextResponse.json(await undoMailBatch(body.token));
    if (body.kind === "refresh") await refreshTrash(body.account);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Couldn't change that mail." }, { status: 400 });
  }
}
