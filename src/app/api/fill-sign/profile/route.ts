import { NextResponse } from "next/server";
import { Profile } from "@/lib/pdf/profile";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";
import { getProfile, saveProfile } from "@/server/profile";

export const runtime = "nodejs";

/** The Fill & sign profile (local only). */
export async function GET(request: Request) {
  const foreign = rejectForeignHost(request);
  if (foreign) return foreign;
  return NextResponse.json({ profile: getProfile() });
}

/** Replaces the profile. Errors stay generic so no value is echoed or logged. */
export async function PUT(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Profile.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".");
    return NextResponse.json({ error: field ? `Check ${field}: it didn't look right` : "Those details didn't look right" }, { status: 400 });
  }
  return NextResponse.json({ profile: saveProfile(parsed.data) });
}
