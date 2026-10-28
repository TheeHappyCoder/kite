import { NextResponse } from "next/server";
import * as z from "zod";
import { allow, archiveAllFrom, block, CleanupError, isSenderEmail, keep, senderDetail, undoArchive, unsubscribe } from "@/server/cleanup";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { senderSummaries } from "@/server/store";
import { ensureSyncLoop } from "@/server/sync";

export const runtime = "nodejs";

/** Cleanup's sender table from the local copy; `?sender=` instead returns one sender's recent emails and archive rule. */
export async function GET(request: Request) {
  ensureSyncLoop();
  const params = new URL(request.url).searchParams;
  const accountId = params.get("account") || "all";
  const sender = params.get("sender")?.trim().toLowerCase();
  if (sender) {
    if (!isSenderEmail(sender)) return NextResponse.json({ error: "Invalid sender" }, { status: 400 });
    return NextResponse.json(senderDetail(sender, accountId));
  }
  return NextResponse.json({ senders: senderSummaries(accountId) });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["allow", "block", "archive", "unsubscribe", "keep", "unkeep"]), email: z.string().trim().toLowerCase().max(320), account: z.string().min(1).max(4000).default("all") }),
  /** Undo of Cleanup archives: the ids "archive" and "block" returned. */
  z.object({ action: z.literal("undo"), undo: z.array(z.uuid()).min(1).max(500) }),
]);

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  const body = parsed.data;

  try {
    if (body.action === "undo") {
      await undoArchive(body.undo);
      return NextResponse.json({ ok: true });
    }
    const email = body.email;
    if (!isSenderEmail(email)) return NextResponse.json({ error: "Invalid sender" }, { status: 400 });
    switch (body.action) {
      case "allow":
        allow(email);
        return NextResponse.json({ ok: true });
      case "keep":
      case "unkeep":
        keep(email, body.action === "keep");
        return NextResponse.json({ ok: true });
      case "block":
        return NextResponse.json({ ok: true, ...(await block(email, body.account)) });
      case "archive":
        return NextResponse.json({ ok: true, ...(await archiveAllFrom(email, body.account)) });
      case "unsubscribe":
        return NextResponse.json({ ok: true, result: await unsubscribe(email, body.account) });
    }
  } catch (error) {
    if (error instanceof CleanupError) return NextResponse.json({ error: error.message }, { status: 410 });
    return errorResponse(error);
  }
}
