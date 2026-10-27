import { NextResponse } from "next/server";
import { getAccount } from "@/server/db";
import { errorResponse } from "@/server/errors";
import { inviteThread } from "@/server/calendar";

export const runtime = "nodejs";

/** The conversation with an event's invite email (`?account=&uid=&summary=`), found in the local copy; null when there's none. */
export async function GET(request: Request) {
  const search = new URL(request.url).searchParams;
  const account = getAccount(search.get("account") ?? "");
  const uid = search.get("uid");
  if (!account || !uid) return NextResponse.json({ error: "Unknown event" }, { status: 404 });
  try {
    return NextResponse.json({ thread: await inviteThread(account, uid, search.get("summary") ?? "") });
  } catch (error) {
    return errorResponse(error);
  }
}
