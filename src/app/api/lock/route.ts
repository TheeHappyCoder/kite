import { NextResponse } from "next/server";
import * as z from "zod";
import { rejectCrossSite } from "@/server/guard";
import { clearPin, lockEnabled, setPin, verifyPin } from "@/server/lock";

export const runtime = "nodejs";

/** Whether a PIN is set (never the PIN itself). */
export async function GET() {
  return NextResponse.json({ enabled: lockEnabled() });
}

const Body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("verify"), pin: z.string().max(16) }),
  z.object({ action: z.literal("set"), pin: z.string().max(16), current: z.string().max(16).optional() }),
  z.object({ action: z.literal("clear"), current: z.string().max(16) }),
]);

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Unknown request" }, { status: 400 });
  const body = parsed.data;
  if (body.action === "verify") {
    const result = verifyPin(body.pin);
    if (result.ok) return NextResponse.json({ ok: true });
    const wait = result.waitMs ? Math.ceil(result.waitMs / 1000) : 0;
    return NextResponse.json({ error: wait ? `Too many tries. Wait ${wait} seconds.` : "That PIN didn't match." }, { status: 403 });
  }
  const result = body.action === "set" ? setPin(body.pin, body.current) : clearPin(body.current);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ ok: true, enabled: lockEnabled() });
}
