import { NextResponse } from "next/server";
import type { Mailbox, Thread } from "@/lib/mail/types";
import { THREAD_KEY } from "@/lib/mail/threads";
import { messagesInMailbox } from "@/lib/mail/trash";
import { resolveInlineImages } from "@/server/attachments";
import { withInvites } from "@/server/calendar";
import { getAccount } from "@/server/db";
import { errorResponse } from "@/server/errors";
import type { ThreadOp } from "@/server/mail/ops";
import { rejectCrossSite } from "@/server/guard";
import { loadFullThread, runOp } from "@/server/sync";
import { getPrepared } from "@/server/prepared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const OPS: ThreadOp[] = [
  "archive", "unarchive", "star", "unstar", "read", "unread",
  "spam", "unspam", "trash", "untrash", "snooze", "unsnooze",
];

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const account = getAccount(search.get("account") ?? "");
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  if (!THREAD_KEY.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    const row = await loadFullThread(account, id);
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    const stored = JSON.parse(row.data) as Thread;
    const visible = messagesInMailbox(stored.messages, search.get("mailbox") === "trash");
    const messages = await withInvites(account, row.id, await Promise.all(visible.map((m) => resolveInlineImages(account.id, m))));
    const thread = { ...stored, messages, mailbox: (search.get("mailbox") as Mailbox) ?? "inbox" };
    // A reply a rule prepared waits in the quick-reply box (never sent by itself).
    return NextResponse.json({ thread, prepared: getPrepared(row.id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  const body = (await request.json()) as { account?: string; op?: ThreadOp; until?: string };
  const account = getAccount(body.account ?? "");
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  if (!THREAD_KEY.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!body.op || !OPS.includes(body.op)) return NextResponse.json({ error: "Unknown operation" }, { status: 400 });
  try {
    await runOp(account, id, body.op, body.until);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
