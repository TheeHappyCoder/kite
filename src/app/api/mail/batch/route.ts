import { NextResponse } from "next/server";
import * as z from "zod";
import { THREAD_KEY } from "@/lib/mail/threads";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";
import { previewMailBatch, executeMailBatch, undoMailBatch, refreshTrash, jobState, stopJob } from "@/server/mail-batch";

export const runtime = "nodejs";
const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preview"), account: z.string().min(1).max(4000), action: z.enum(["trash", "archive", "permanent"]), threads: z.array(z.object({ account: z.string(), id: z.string().regex(THREAD_KEY) })).min(1).max(1000).optional(), senders: z.array(z.email().toLowerCase()).min(1).max(500).optional(), inboxOnly: z.boolean().optional(), unsubscribe: z.boolean().optional() }),
  z.object({ kind: z.enum(["execute", "undo"]), token: z.uuid() }),
  z.object({ kind: z.literal("stop"), job: z.uuid() }),
  z.object({ kind: z.literal("refresh"), account: z.string().min(1).max(4000) }),
]);

/** A review, run or undo as it stands (`?job=`). */
export async function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const job = jobState(new URL(request.url).searchParams.get("job") ?? "");
  return job ? NextResponse.json(job) : NextResponse.json({ error: "That job is gone. Review the selection again." }, { status: 404 });
}

/** preview / execute / undo start a job and answer with it at once; the window follows it with GET. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid mail selection." }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.kind === "preview") return NextResponse.json(previewMailBatch(body));
    if (body.kind === "execute") return NextResponse.json(executeMailBatch(body.token));
    if (body.kind === "undo") return NextResponse.json(undoMailBatch(body.token));
    if (body.kind === "stop") stopJob(body.job);
    if (body.kind === "refresh") await refreshTrash(body.account);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Couldn't change that mail." }, { status: 400 });
  }
}
