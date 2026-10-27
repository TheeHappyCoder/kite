import { NextResponse } from "next/server";
import * as z from "zod";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";
import { prepare, removeLanguage, translateState, TranslateError } from "@/server/translate";

export const runtime = "nodejs";

// Translation on this computer (server/translate.ts): GET what can be translated into `to` and
// what's downloaded (`local`: without asking Mozilla, for Settings); POST gets a pair ready
// (downloading it once) and says which files the worker loads; DELETE removes a language. Message
// text never comes here.

const Code = z.string().regex(/^[a-z]{2,3}$/);

const failed = (error: unknown) =>
  NextResponse.json({ error: error instanceof TranslateError ? error.message : "Couldn't reach Mozilla's server. Check your connection and try again." }, { status: 502 });

export async function GET(request: Request) {
  const foreign = rejectForeignHost(request);
  if (foreign) return foreign;
  const to = Code.safeParse(new URL(request.url).searchParams.get("to"));
  if (!to.success) return NextResponse.json({ error: "Which language?" }, { status: 400 });
  try {
    return NextResponse.json(await translateState(to.data, new URL(request.url).searchParams.has("local")));
  } catch (error) {
    return failed(error);
  }
}

const Prepare = z.object({ from: Code, to: Code });

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Prepare.safeParse(await request.json().catch(() => null));
  if (!parsed.success || parsed.data.from === parsed.data.to) return NextResponse.json({ error: "Which languages?" }, { status: 400 });
  try {
    return NextResponse.json(await prepare(parsed.data.from, parsed.data.to));
  } catch (error) {
    return failed(error);
  }
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const params = new URL(request.url).searchParams;
  const language = Code.safeParse(params.get("language"));
  const to = Code.safeParse(params.get("to"));
  if (!language.success || !to.success) return NextResponse.json({ error: "Which language?" }, { status: 400 });
  try {
    await removeLanguage(language.data, to.data);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failed(error);
  }
}
