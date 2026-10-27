import { NextResponse } from "next/server";
import * as z from "zod";
import { summarizePerson } from "@/lib/mail/people";
import { PersonPatch } from "@/lib/mail/person-prefs";
import { listAccounts } from "@/server/db";
import { rejectCrossSite } from "@/server/guard";
import { updatePerson } from "@/server/people";
import { threadsWithPerson } from "@/server/store";

export const runtime = "nodejs";

/** One person from the local copy: conversations together, shared files, usual reply times. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const email = z.email().safeParse(params.get("email") ?? "");
  if (!email.success) return NextResponse.json({ error: "That address doesn't look right" }, { status: 400 });
  const accountId = params.get("account") || "all";
  const me = listAccounts().map((a) => a.email);
  return NextResponse.json({ person: summarizePerson(threadsWithPerson(email.data, accountId), email.data, me) });
}

/** Changes one person's local state (VIP flag, private note). Gmail is untouched. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = PersonPatch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That change didn't look right" }, { status: 400 });
  return NextResponse.json({ prefs: updatePerson(parsed.data) });
}
