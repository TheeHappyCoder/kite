import { NextResponse } from "next/server";
import { z } from "zod";
import { InviteResponse } from "@/lib/calendar/invite";
import { THREAD_KEY } from "@/lib/mail/threads";
import { respondToInvite } from "@/server/calendar";
import { getAccount } from "@/server/db";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { refreshCalendar } from "@/server/sync";

export const runtime = "nodejs";

const Body = z.object({
  account: z.string(),
  /** The thread key (not the Kite id). */
  thread: z.string().regex(THREAD_KEY),
  message: z.string().min(1).max(200),
  response: InviteResponse,
  note: z.string().max(2000).optional(),
  /** The card's fallback when the calendar can't take the answer. */
  byEmail: z.boolean().optional(),
});

/** Answers a meeting invite (POST only: it tells the organiser). Returns the invite with your answer. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const body = Body.parse(await request.json());
    const account = getAccount(body.account);
    if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
    const invite = await respondToInvite(account, {
      threadId: `${account.id}:${body.thread}`,
      messageId: body.message,
      response: body.response,
      note: body.note,
      byEmail: body.byEmail,
    });
    // A mail calendar changes with your answer; real calendars report it on their own read.
    void refreshCalendar(account).catch(() => {});
    return NextResponse.json({ invite });
  } catch (error) {
    return errorResponse(error);
  }
}
