import { NextResponse } from "next/server";
import { THREAD_KEY } from "@/lib/mail/threads";
import { getAccount } from "@/server/db";
import { rejectCrossSite } from "@/server/guard";
import { discardPrepared, getPrepared } from "@/server/prepared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** The reply waiting for this conversation (`?account=`), after a rule's AI draft lands. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  const account = getAccount(new URL(request.url).searchParams.get("account") ?? "");
  if (!account || !THREAD_KEY.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ prepared: getPrepared(`${account.id}:${id}`) });
}

/** Discards the reply a rule prepared for this conversation (`?account=`; `&reply=` only that one). Nothing was sent. */
export async function DELETE(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const account = getAccount(search.get("account") ?? "");
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  if (!THREAD_KEY.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  discardPrepared(`${account.id}:${id}`, search.get("reply") ?? undefined);
  return NextResponse.json({ ok: true });
}
