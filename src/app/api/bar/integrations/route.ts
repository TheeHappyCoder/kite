import { NextResponse } from "next/server";
import * as z from "zod";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";
import { createIntegration, deleteIntegration, listIntegrations, updateIntegration } from "@/server/bar/integrations";
import { liveActivities, removeSource } from "@/server/bar/runtime";

export const runtime = "nodejs";

const Name = z.string().trim().min(1, "Give it a name").max(60);

/** Settings → Kite bar: the integrations, each with how many activities it has showing now. */
export async function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  return NextResponse.json({ integrations: listIntegrations().map((i) => ({ ...i, live: liveActivities(i.id).length })) });
}

/** A new integration: the response carries its token, the only time Kite ever shows it. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = z.object({ name: Name }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Give it a name" }, { status: 400 });
  const { integration, token } = createIntegration(parsed.data.name);
  return NextResponse.json({ integration: { ...integration, live: 0 }, token });
}

/** Rename, or pause / resume (paused: its activities leave and its token stops working). */
export async function PATCH(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = z.object({ id: z.string().min(1), name: Name.optional(), enabled: z.boolean().optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const integration = updateIntegration(parsed.data.id, parsed.data);
  if (!integration) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (parsed.data.enabled === false) removeSource(integration.id);
  return NextResponse.json({ integration: { ...integration, live: liveActivities(integration.id).length } });
}

/** Removes an integration: its activities leave and its token stops working. */
export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  removeSource(id);
  return deleteIntegration(id) ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 });
}
