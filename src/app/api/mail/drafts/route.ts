import { NextResponse } from "next/server";
import { REMOTE_ID } from "@/lib/mail/threads";
import { ComposeDraft } from "@/lib/mail/compose";
import { getAccount } from "@/server/db";
import { discardDraft, openDraft, saveDraft } from "@/server/drafts";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";

export const runtime = "nodejs";

const ID = REMOTE_ID;

function refFrom(search: URLSearchParams) {
  const messageId = search.get("message") ?? undefined;
  const threadId = search.get("thread") ?? undefined;
  const draftId = search.get("id") ?? undefined;
  return {
    messageId: messageId && ID.test(messageId) ? messageId : undefined,
    threadId: threadId && ID.test(threadId) ? threadId : undefined,
    draftId: draftId && REMOTE_ID.test(draftId) ? draftId : undefined,
  };
}

/** A draft to keep editing, found by its message (or thread). */
export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;
  const account = getAccount(search.get("account") ?? "");
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  const ref = refFrom(search);
  if (!ref.messageId && !ref.threadId) return NextResponse.json({ error: "Missing message" }, { status: 400 });
  try {
    return NextResponse.json({ draft: await openDraft(account, ref) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Saves the compose window to Gmail as a draft (creates it, or updates `draftId`). */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = ComposeDraft.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "That draft didn't look right" }, { status: 400 });
  const account = getAccount(parsed.data.accountId);
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  try {
    return NextResponse.json({ ok: true, ...(await saveDraft(account, parsed.data)) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const search = new URL(request.url).searchParams;
  const account = getAccount(search.get("account") ?? "");
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  const ref = refFrom(search);
  if (!ref.draftId && !ref.messageId && !ref.threadId) return NextResponse.json({ error: "Missing draft" }, { status: 400 });
  try {
    return NextResponse.json({ ok: await discardDraft(account, ref, false, true) });
  } catch (error) {
    return errorResponse(error);
  }
}
