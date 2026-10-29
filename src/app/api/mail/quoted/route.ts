import { NextResponse } from "next/server";
import { REMOTE_ID } from "@/lib/mail/threads";
import { resolveInlineImages } from "@/server/attachments";
import { getAccount } from "@/server/db";
import { errorResponse } from "@/server/errors";
import { rejectForeignHost } from "@/server/guard";
import { quotedMessage } from "@/server/outgoing";

export const runtime = "nodejs";

/**
 * The message a forward carries, as the send will read it (outgoing.ts `quotedMessage`), for
 * compose's "Remove parts" preview. Read-only and host-guarded: it returns a message body.
 */
export async function GET(request: Request) {
  const foreign = rejectForeignHost(request);
  if (foreign) return foreign;
  const search = new URL(request.url).searchParams;
  const account = getAccount(search.get("account") ?? "");
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  const messageId = search.get("message") ?? "";
  const thread = search.get("thread") ?? undefined;
  if (!REMOTE_ID.test(messageId) || (thread && !REMOTE_ID.test(thread))) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  try {
    const message = await quotedMessage(account, { messageId } as Parameters<typeof quotedMessage>[1], thread);
    if (!message) return NextResponse.json({ error: "Kite can't find that message any more." }, { status: 404 });
    const shown = await resolveInlineImages(account.id, message);
    return NextResponse.json({ html: shown.html ?? null, text: message.body.join("\n\n") || message.snippet || "" });
  } catch (error) {
    return errorResponse(error);
  }
}
