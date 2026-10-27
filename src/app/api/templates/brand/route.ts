import { NextResponse } from "next/server";
import { BrandKit } from "@/lib/design/brand";
import { rejectCrossSite } from "@/server/guard";
import { saveBrand } from "@/server/mail-designs";

export const runtime = "nodejs";

/** Replaces the brand kit. */
export async function PUT(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = BrandKit.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Those brand details didn't look right" }, { status: 400 });
  return NextResponse.json({ brand: saveBrand(parsed.data) });
}
