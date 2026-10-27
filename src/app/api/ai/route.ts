import { NextResponse } from "next/server";
import * as z from "zod";
import { AiLimitReached, AiUnavailable, clearAiSettings, publicAiSettings, saveAiSettings, testAi, usageSetup } from "@/server/ai";
import { announceUsage, clearUsage } from "@/server/ai-usage";
import { rejectCrossSite } from "@/server/guard";
import { warmKey } from "@/server/secrets";

export const runtime = "nodejs";

const Model = z.object({
  id: z.string().trim().min(1).max(120),
  name: z.string().trim().min(1).max(60),
  /** US dollars per million tokens; null = tokens only. */
  price: z.object({ input: z.number().min(0).max(10_000), output: z.number().min(0).max(10_000) }).nullable(),
});

const SettingsBody = z.object({
  provider: z.enum(["anthropic", "openai-compatible"]),
  preset: z.string().max(40),
  models: z.array(Model).min(1).max(20),
  defaultModel: z.string().max(120),
  baseUrl: z.string().url().max(300).optional(),
  apiKey: z.string().max(400).optional(),
  test: z.boolean().optional(),
});

export async function GET() {
  // The key hint needs the key: wait for the startup unwrap rather than blocking the server.
  await warmKey();
  return NextResponse.json({ settings: publicAiSettings() });
}

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = SettingsBody.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: "Check the provider details" }, { status: 400 });
  if (new Set(parsed.data.models.map((m) => m.id)).size !== parsed.data.models.length) {
    return NextResponse.json({ error: "Each model once" }, { status: 400 });
  }
  if (parsed.data.provider === "openai-compatible" && !parsed.data.baseUrl) {
    return NextResponse.json({ error: "A server address is required" }, { status: 400 });
  }
  const { test, ...settings } = parsed.data;
  saveAiSettings(settings);
  if (!test) return NextResponse.json({ ok: true, settings: publicAiSettings() });
  try {
    const result = await testAi();
    return NextResponse.json({ ok: true, settings: publicAiSettings(), test: result });
  } catch (error) {
    if (error instanceof AiLimitReached) return NextResponse.json({ ok: false, settings: publicAiSettings(), error: error.message, limit: error.limit }, { status: 429 });
    const message = error instanceof AiUnavailable ? error.message : "Test failed";
    return NextResponse.json({ ok: false, settings: publicAiSettings(), error: message });
  }
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  clearAiSettings();
  // The usage ledger goes with it.
  clearUsage();
  announceUsage(usageSetup());
  return NextResponse.json({ ok: true });
}
