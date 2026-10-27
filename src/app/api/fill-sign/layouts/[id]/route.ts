import { NextResponse } from "next/server";
import { deleteLayout, markUsed } from "@/server/fill-layouts";
import { rejectCrossSite } from "@/server/guard";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Marks a layout as just used (after "Sign like last time"). */
export async function PATCH(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  return markUsed((await params).id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That layout is gone" }, { status: 404 });
}

export async function DELETE(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  deleteLayout((await params).id);
  return NextResponse.json({ ok: true });
}
