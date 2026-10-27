import { NextResponse } from "next/server";
import * as z from "zod";
import { PreferencesPatch } from "@/lib/settings";
import { getAccount } from "@/server/db";
import { rejectCrossSite } from "@/server/guard";
import { clearAvatarCache, getPreferences, pendingSenderCount, storageInfo, updatePreferences } from "@/server/settings";
import { eraseEverything, notifySettings, resetMailCache } from "@/server/sync";
import { usageSetup } from "@/server/ai";
import { announceUsage } from "@/server/ai-usage";
import { screenerOn } from "@/server/rules";
import { listOverrides } from "@/server/overrides";
import { listPeople } from "@/server/people";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const withStorage = new URL(request.url).searchParams.get("storage") === "1";
  return NextResponse.json({
    preferences: getPreferences(),
    pendingSenders: pendingSenderCount(),
    screener: screenerOn(),
    overrides: listOverrides(),
    people: listPeople(),
    storage: withStorage ? await storageInfo() : undefined,
  });
}

export async function PATCH(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = PreferencesPatch.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Those settings didn't look right" }, { status: 400 });
  const unknown = Object.keys(parsed.data.signatures ?? {}).find((id) => !getAccount(id));
  if (unknown) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  const preferences = updatePreferences(parsed.data);
  notifySettings();
  if (parsed.data.aiLimits) announceUsage(usageSetup());
  return NextResponse.json({ preferences });
}

const Action = z.object({ action: z.enum(["reset-cache", "clear-avatars", "erase-everything"]) });

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  if (parsed.data.action === "erase-everything") {
    await eraseEverything();
    return NextResponse.json({ ok: true });
  }
  if (parsed.data.action === "reset-cache") await resetMailCache();
  else await clearAvatarCache();
  return NextResponse.json({ ok: true, storage: await storageInfo() });
}
