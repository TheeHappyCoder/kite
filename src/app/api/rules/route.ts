import { NextResponse } from "next/server";
import * as z from "zod";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { createRule, listRules, reorderRules, syncFilters } from "@/server/rules";

export const runtime = "nodejs";

/** Every rule in run order. */
export async function GET() {
  return NextResponse.json({ rules: listRules() });
}

/** A new rule (it goes just above "Everyone else: notify"). */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const rule = createRule(await request.json());
    if (rule.gmail) await syncFilters({ ruleId: rule.id });
    return NextResponse.json({ rule, rules: listRules() });
  } catch (error) {
    return errorResponse(error);
  }
}

const Order = z.object({ order: z.array(z.string().max(80)).max(500) });

/** A new run order. */
export async function PUT(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Order.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid order" }, { status: 400 });
  reorderRules(parsed.data.order);
  return NextResponse.json({ rules: listRules() });
}
