import { NextResponse } from "next/server";
import * as z from "zod";
import { rejectCrossSite } from "@/server/guard";
import { notifyTestCode, notifyTestMail, notifyTestMeeting } from "@/server/sync";

export const runtime = "nodejs";

const Body = z.object({
  code: z.string().max(20).optional(),
  link: z.url().optional(),
  service: z.string().max(60).default("Kite test"),
  /** A sample meeting instead: its title, starting in `minutes`. */
  meeting: z.string().max(120).optional(),
  minutes: z.number().min(-5).max(60).default(2),
  /** A sample "notify now" email instead, from this name, in a made-up conversation (Archive there fails, by design). */
  mail: z.string().max(60).optional(),
  subject: z.string().max(200).default("Contract approved"),
  preview: z.string().max(200).default("Everything is signed on our side. Can we start on the 1st, or would you rather wait for the board on Thursday?"),
});

/** Dev only: sends a sample code, meeting or email to the desktop shell, to try the Kite bar and toast without real mail. */
export async function POST(request: Request) {
  if (process.env.NODE_ENV === "production") return NextResponse.json({ error: "Not found" }, { status: 404 });
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That sample didn't look right" }, { status: 400 });
  const { service, link, meeting, minutes, mail, subject, preview } = parsed.data;
  if (mail) {
    const id = `test-${Date.now()}`;
    notifyTestMail({ id, accountId: "test", threadId: `test:${id}`, from: { name: mail, email: "someone@example.com" }, subject, preview, count: 1 });
    return NextResponse.json({ ok: true });
  }
  if (meeting) {
    const start = new Date(Date.now() + minutes * 60_000);
    notifyTestMeeting({
      id: `test-${Date.now()}`,
      title: meeting,
      start: start.toISOString(),
      end: new Date(start.getTime() + 30 * 60_000).toISOString(),
      join: link ?? "https://meet.google.com/abc-defg-hij",
    });
    return NextResponse.json({ ok: true });
  }
  const code = parsed.data.code ?? (link ? undefined : String(Math.floor(100000 + Math.random() * 900000)));
  notifyTestCode({ id: `test-${Date.now()}`, service, code, link, receivedAt: new Date().toISOString(), threadId: "" });
  return NextResponse.json({ ok: true });
}
