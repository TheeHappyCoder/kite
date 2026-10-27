import { NextResponse } from "next/server";
import { authorize } from "@/server/bar/integrations";
import { removeActivity } from "@/server/bar/runtime";

export const runtime = "nodejs";

/** An integration takes one of its activities away. */
export async function DELETE(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const auth = authorize(request);
  if ("refused" in auth) return auth.refused;
  const { key } = await params;
  const removed = removeActivity(auth.integration.id, key);
  return removed ? NextResponse.json({ ok: true }) : NextResponse.json({ error: `No activity "${key}" is showing.` }, { status: 404 });
}
