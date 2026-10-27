import { NextResponse } from "next/server";
import { NewEvent } from "@/lib/calendar/event";
import { inScope } from "@/lib/mail/scope";
import { getAccount, listAccounts } from "@/server/db";
import { errorResponse } from "@/server/errors";
import { createEvent, readRange } from "@/server/events";
import { rejectCrossSite } from "@/server/guard";
import { removeLocalEvent } from "@/server/mail-calendar";

export const runtime = "nodejs";

const DAY = 86_400_000;

/**
 * Events in the accounts' calendars (`?account=` scope, `from` / `to` ISO; default: the next week): the local
 * copy, or for weeks outside it (the Calendar view) one read from the provider that isn't stored.
 */
export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;
  const scope = search.get("account") || "all";
  const from = new Date(search.get("from") ?? Date.now() - DAY);
  const to = new Date(search.get("to") ?? from.getTime() + 8 * DAY);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return NextResponse.json({ error: "Bad dates" }, { status: 400 });
  if (to.getTime() - from.getTime() > 45 * DAY) return NextResponse.json({ error: "Ask for at most six weeks" }, { status: 400 });
  const accounts = listAccounts().filter((a) => inScope(scope, a.id));
  return NextResponse.json(await readRange(accounts, from.toISOString(), to.toISOString()));
}

/** "Add to calendar": saves the event the user filled in, in that account's calendar. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const input = NewEvent.parse(await request.json());
    const account = getAccount(input.accountId);
    if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
    return NextResponse.json({ event: await createEvent(account, input) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Removes an event added in Kite to a mail calendar (`?id=`). Events in mail or a provider's calendar aren't Kite's to remove. */
export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!removeLocalEvent(id)) return NextResponse.json({ error: "That event isn't in Kite any more." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
