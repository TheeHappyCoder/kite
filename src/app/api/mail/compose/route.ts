import { NextResponse } from "next/server";
import { replyDraft, type ReplyMode, type ReplySource } from "@/lib/mail/compose";
import type { Thread } from "@/lib/mail/types";
import { THREAD_KEY } from "@/lib/mail/threads";
import { getAccount } from "@/server/db";
import { mailOf } from "@/server/providers/registry";
import { loadFullThread } from "@/server/sync";
import { errorResponse } from "@/server/errors";

export const runtime = "nodejs";

const MODES: ReplyMode[] = ["reply", "replyAll", "forward"];

/**
 * A prefilled reply, reply-all or forward for a thread. Recipients come from the message's
 * current headers at the provider (Cc and Reply-To included), falling back to the local copy offline.
 */
export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;
  const account = getAccount(search.get("account") ?? "");
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  const mode = search.get("mode") as ReplyMode;
  const threadId = search.get("thread") ?? "";
  if (!MODES.includes(mode) || !THREAD_KEY.test(threadId)) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    const row = await loadFullThread(account, threadId);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const thread = JSON.parse(row.data) as Thread;
    const wanted = search.get("message");
    const sent = thread.messages.filter((m) => !m.draft);
    const stored = sent.find((m) => m.id === wanted) ?? sent[sent.length - 1] ?? thread.messages[thread.messages.length - 1];
    let message: ReplySource = stored;
    try {
      const fresh = await mailOf(account).fetchMessage(account, stored.id, false);
      message = { ...stored, from: fresh.from, to: fresh.to, cc: fresh.cc, replyTo: fresh.replyTo, messageIdHeader: fresh.messageIdHeader ?? stored.messageIdHeader, references: fresh.references ?? stored.references };
    } catch {}
    return NextResponse.json({
      draft: replyDraft({ mode, message, subject: thread.subject, accountId: account.id, me: account.email, threadId: thread.remoteId }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
