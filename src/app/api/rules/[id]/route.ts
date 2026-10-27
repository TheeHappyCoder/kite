import { NextResponse } from "next/server";
import * as z from "zod";
import { RuleDraftSchema } from "@/lib/rules/spec";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { deleteRule, listRules, runOnExisting, setRuleEnabled, syncFilters, updateRule } from "@/server/rules";
import { notifyChanged, runScheduleNowFor } from "@/server/sync";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const Patch = z.union([z.object({ enabled: z.boolean() }), z.object({ rule: RuleDraftSchema })]);

/** Pause / switch on, or save an edit. Its Gmail filters follow (paused: removed; edited: replaced). */
export async function PATCH(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const body = Patch.parse(await request.json());
    if ("enabled" in body) setRuleEnabled(id, body.enabled);
    else updateRule(id, body.rule);
    await syncFilters({ ruleId: id });
    return NextResponse.json({ rules: listRules() });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    deleteRule(id);
    await syncFilters({ ruleId: id });
    return NextResponse.json({ rules: listRules() });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * "Run on existing mail" (only on this button press): the last 30 days, undone together. A
 * schedule automation's "Run now" instead: this period's requests or pack.
 */
export async function POST(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const rule = listRules().find((r) => r.id === id);
    if (rule?.when === "schedule") {
      const ran = await runScheduleNowFor(rule);
      return NextResponse.json({ changed: ran.waiting + ran.packs.length, waiting: ran.waiting, packs: ran.packs, problems: ran.problems });
    }
    const result = await runOnExisting(id);
    result.accounts.forEach(notifyChanged);
    return NextResponse.json({ batchId: result.batchId, changed: result.changed });
  } catch (error) {
    return errorResponse(error);
  }
}
