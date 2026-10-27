import { NextResponse } from "next/server";
import * as z from "zod";
import { rejectCrossSite } from "@/server/guard";
import { actOn, dismissActivity } from "@/server/bar/runtime";

export const runtime = "nodejs";

const Body = z.object({ id: z.string().min(1).max(200), action: z.string().min(1).max(40) });

/** From the Kite bar page: the user clicked an integration's callback button, or closed its activity. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { id, action } = parsed.data;
  const ok = action === "dismiss" ? dismissActivity(id) : actOn(id, action);
  return ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "That activity has gone" }, { status: 404 });
}
