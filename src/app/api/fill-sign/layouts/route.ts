import { NextResponse } from "next/server";
import * as z from "zod";
import { FormPrint, LayoutSpec } from "@/lib/pdf/layout";
import { countForSender, LayoutError, listLayouts, saveLayout } from "@/server/fill-layouts";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";

export const runtime = "nodejs";

/** Remembered layouts (Settings), or `?sender=` for how many could apply to that sender's mail. */
export async function GET(request: Request) {
  const foreign = rejectForeignHost(request);
  if (foreign) return foreign;
  const sender = new URL(request.url).searchParams.get("sender");
  if (sender !== null) {
    const parsed = z.string().trim().toLowerCase().email().safeParse(sender);
    return NextResponse.json({ count: parsed.success ? countForSender(parsed.data) : 0 });
  }
  return NextResponse.json({ layouts: listLayouts() });
}

const Body = FormPrint.extend({ name: z.string().trim().min(1).max(80), spec: LayoutSpec });

/** Remembers where things were placed on this sender's form. Only ever from the user's Remember. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That layout didn't look right" }, { status: 400 });
  const { name, spec, ...print } = parsed.data;
  try {
    return NextResponse.json({ layout: saveLayout(print, name, spec) });
  } catch (e) {
    if (e instanceof LayoutError) return NextResponse.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
