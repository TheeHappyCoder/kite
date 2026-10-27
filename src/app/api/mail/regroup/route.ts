import { NextResponse } from "next/server";
import * as z from "zod";
import { REMOTE_ID, THREAD_KEY } from "@/lib/mail/threads";
import { getAccount } from "@/server/db";
import { rejectCrossSite } from "@/server/guard";
import { mergeThreads, RegroupError, splitThread, undoRegroup } from "@/server/regroup";
import { notifyChanged } from "@/server/sync";

export const runtime = "nodejs";

const Key = z.string().regex(THREAD_KEY);
const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("split"), account: z.string(), thread: Key, message: z.string().regex(REMOTE_ID), following: z.boolean() }),
  z.object({ action: z.literal("merge"), account: z.string(), thread: Key, others: z.array(Key).min(1).max(50) }),
  z.object({ action: z.literal("undo"), regroups: z.array(z.string().uuid()).min(1).max(50) }),
]);

/** Split a conversation, merge several, or put either back. Local only: Gmail's threading is untouched. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That request didn't look right" }, { status: 400 });
  const body = parsed.data;
  try {
    if (body.action === "undo") {
      // Newest first, so stacked changes unwind in order.
      const undone = [...body.regroups].reverse().map(undoRegroup);
      new Set(undone.map((u) => u.accountId)).forEach(notifyChanged);
      return NextResponse.json({ undone });
    }
    const account = getAccount(body.account);
    if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
    const result =
      body.action === "split"
        ? (({ regroupId, threadId }) => ({ regroupIds: [regroupId], threadId }))(splitThread(account, body.thread, body.message, body.following))
        : mergeThreads(account, body.thread, body.others);
    notifyChanged(account.id);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof RegroupError) return NextResponse.json({ error: error.message }, { status: 409 });
    throw error;
  }
}
