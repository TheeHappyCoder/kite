import { NextResponse } from "next/server";
import { EMAIL } from "@/lib/mail/compose";
import { collectionExists } from "@/server/collections";
import { rejectForeignHost } from "@/server/guard";
import { buildPack, monthPeriod } from "@/server/packs";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * The month-end pack for one month of a collection (`?month=2026-10&to=`): a draft for the app to
 * open in compose (the files are references to stored mail, read again when it's sent), and what's
 * in it. Nothing is sent or saved here.
 */
export async function GET(request: Request, { params }: Context) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const { id } = await params;
  const search = new URL(request.url).searchParams;
  const month = search.get("month") ?? "";
  const to = (search.get("to") ?? "").trim().toLowerCase();
  if (!collectionExists(id)) return NextResponse.json({ error: "That collection is gone." }, { status: 404 });
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return NextResponse.json({ error: "Pick a month." }, { status: 400 });
  if (!EMAIL.test(to)) return NextResponse.json({ error: "Write the address to send it to." }, { status: 400 });
  const period = monthPeriod(month);
  const { draft, summary } = buildPack({ collectionId: id, start: period.start, end: period.end, periodName: period.name, to, subject: "{collection}: {period}" });
  return NextResponse.json({ draft, summary });
}
