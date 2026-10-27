import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import * as z from "zod";
import { getDb } from "./db";
import { logSent } from "./privacy-log";
import { costOf, dollarsPossibleFor, isLocalPreset, limitMessage, pricedModels, type AiModel, type AiUsage, type LimitUnit } from "@/lib/ai-pricing";
import type { AiTask } from "@/lib/ai-tasks";
import { announceUsage, limitsCheck, recordUsage, type UsageSetup } from "./ai-usage";
import { seal, unseal } from "./secrets";
import { getPreferences, updatePreferences } from "./settings";

// Bring your own AI. Claude goes through Anthropic's SDK; everything else
// (OpenAI, OpenRouter, DeepSeek, Groq, and local Ollama / LM Studio) through the
// OpenAI-compatible chat API they all share. One connection carries several models: each task
// (lib/ai-tasks.ts) runs on the model picked for it in preferences, else the default. Keys are
// sealed in the local database (server/secrets.ts) and are never sent back to the browser.

type AiProvider = "anthropic" | "openai-compatible";

export type AiSettings = {
  provider: AiProvider;
  preset: string;
  /** At least one. Each carries the price the user pays (US dollars per million tokens), or null for tokens only. */
  models: AiModel[];
  /** The id of the model tasks run on unless they pick another. */
  defaultModel: string;
  baseUrl?: string;
  apiKey?: string;
};

type PublicAiSettings = Omit<AiSettings, "apiKey"> & { hasKey: boolean; keyHint: string | null };

/** The stored settings, key still sealed. */
function storedSettings(): AiSettings | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'ai'").get() as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as AiSettings) : null;
}

export function getAiSettings(): AiSettings | null {
  const settings = storedSettings();
  if (!settings) return null;
  return settings.apiKey ? { ...settings, apiKey: unseal(settings.apiKey) } : settings;
}

/** The connected models with the prices Kite counts with, the default first. */
function orderedModels(settings: AiSettings): AiModel[] {
  const models = pricedModels(settings.preset, settings.models);
  return [...models].sort((a, b) => Number(b.id === settings.defaultModel) - Number(a.id === settings.defaultModel));
}

/**
 * The model a task runs on: the one asked for (a rule's own choice), else the one picked for the
 * task in preferences, else the default. A choice that isn't connected any more falls through.
 */
export function modelFor(settings: AiSettings, task: AiTask, asked?: string | null): AiModel {
  const models = orderedModels(settings);
  for (const id of [asked, getPreferences().aiModels[task], settings.defaultModel]) {
    const found = id ? models.find((m) => m.id === id) : undefined;
    if (found) return found;
  }
  return models[0];
}

/** The AI as the usage ledger sees it (no key needed, so it never waits for the unwrap). */
export function usageSetup(): UsageSetup {
  const settings = storedSettings();
  if (!settings) return null;
  return {
    configured: settings.provider !== "anthropic" || !!settings.apiKey,
    preset: settings.preset,
    models: orderedModels(settings),
    local: isLocalPreset(settings.preset),
  };
}

export function publicAiSettings(): PublicAiSettings | null {
  const settings = getAiSettings();
  if (!settings) return null;
  const { apiKey, ...rest } = settings;
  return { ...rest, hasKey: !!apiKey, keyHint: apiKey ? `…${apiKey.slice(-4)}` : null };
}

/** Saves settings. An empty apiKey keeps the stored one, so the key never has to round-trip through the UI. */
export function saveAiSettings(next: AiSettings) {
  const previous = getAiSettings();
  const apiKey = next.apiKey?.trim() || (previous?.preset === next.preset ? previous.apiKey : undefined);
  const defaultModel = next.models.some((m) => m.id === next.defaultModel) ? next.defaultModel : next.models[0].id;
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('ai', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ ...next, defaultModel, apiKey: apiKey ? seal(apiKey) : undefined }));
  // Task choices naming a model that's gone go back to the default.
  const ids = new Set(next.models.map((m) => m.id));
  const stale = Object.entries(getPreferences().aiModels).filter(([, id]) => !ids.has(id));
  if (stale.length) updatePreferences({ aiModels: Object.fromEntries(stale.map(([task]) => [task, null])) });
  // Dollar limits need every model priced: otherwise they start over in tokens.
  if (getPreferences().aiLimits.unit === "dollars" && !dollarsPossibleFor(pricedModels(next.preset, next.models))) {
    updatePreferences({ aiLimits: { unit: "tokens", daily: null, monthly: null } });
  }
  announceUsage(usageSetup());
}

export function clearAiSettings() {
  getDb().prepare("DELETE FROM settings WHERE key = 'ai'").run();
}

export class AiUnavailable extends Error {}

/** A call refused before it was sent: it could cross today's or this month's limit (server/ai-usage.ts). */
export class AiLimitReached extends AiUnavailable {
  constructor(readonly limit: { period: "day" | "month"; limit: number; unit: LimitUnit }) {
    super(limitMessage(limit.period, limit.limit, limit.unit));
  }
}

// Models that accept Anthropic's server-side refusal fallbacks.
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5", "claude-fable-5-1"]);

type Metered<T> = { value: T; usage: AiUsage | null };

async function anthropicJson<T extends z.ZodType>(settings: AiSettings, model: string, schema: T, system: string, prompt: string, maxOutput: number): Promise<Metered<z.infer<T>>> {
  const client = new Anthropic({ apiKey: settings.apiKey, maxRetries: 2, timeout: 120_000 });
  const fallback = FALLBACK_MODELS.has(model);
  const response = await client.beta.messages.parse({
    model,
    max_tokens: maxOutput,
    system,
    messages: [{ role: "user", content: prompt }],
    // Extraction is a simple task: low effort keeps it fast and cheap.
    output_config: { effort: "low", format: betaZodOutputFormat(schema) },
    ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
  });
  if (response.stop_reason === "refusal") throw new AiUnavailable("The model declined this request");
  if (response.stop_reason === "max_tokens") throw new AiUnavailable("The model's answer was cut off");
  if (!response.parsed_output) throw new AiUnavailable("The model didn't return valid JSON");
  return { value: response.parsed_output as z.infer<T>, usage: { input: response.usage.input_tokens, output: response.usage.output_tokens } };
}

function extractJson(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body);
}

async function openAiCompatibleJson<T extends z.ZodType>(settings: AiSettings, model: string, schema: T, system: string, prompt: string, maxOutput: number): Promise<Metered<z.infer<T>>> {
  const url = `${(settings.baseUrl ?? "").replace(/\/+$/, "")}/chat/completions`;
  const jsonSchema = z.toJSONSchema(schema);
  const body = {
    model,
    messages: [
      {
        role: "system",
        content: `${system}\n\nReply with a single JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(jsonSchema)}`,
      },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: maxOutput,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;

  const call = async (responseFormat: boolean) =>
    fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(responseFormat ? { ...body, response_format: { type: "json_object" } } : body),
      signal: AbortSignal.timeout(120_000),
    });

  // Not every compatible server supports response_format; retry without it.
  let res = await call(true);
  if (res.status === 400 || res.status === 422) res = await call(false);
  if (!res.ok) throw new AiUnavailable(`AI provider returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
  const content = data.choices?.[0]?.message?.content ?? "";
  const parsed = schema.safeParse(extractJson(content));
  if (!parsed.success) throw new AiUnavailable("The model's JSON didn't match what Kite asked for");
  const usage = data.usage?.prompt_tokens != null ? { input: data.usage.prompt_tokens, output: data.usage.completion_tokens ?? 0 } : null;
  return { value: parsed.data as z.infer<T>, usage };
}

/** Who receives AI requests, for the privacy log: the preset's name, or the server's host. */
function serviceName(settings: AiSettings) {
  if (settings.provider === "anthropic") return "Anthropic";
  try {
    return new URL(settings.baseUrl ?? "").host || settings.preset;
  } catch {
    return settings.preset;
  }
}

/**
 * What an AI call is for, recorded in the privacy log before it's sent and in the usage ledger.
 * Every call comes from a user action, or from a rule the user let use AI (server/ai-drafts.ts), so
 * `action` names it ("Fill with AI") and `detail` says which emails it covers, by subject (privacy
 * log only). `task` picks the model (lib/ai-tasks.ts); `model` asks for one by id (a rule's own
 * choice) and is used when it's connected. `ruleId` / `threadId` go in the ledger as ids.
 */
type AiPurpose = { task: AiTask; action: string; detail?: string; model?: string | null; ruleId?: string; threadId?: string };

/** A provider failure as one short, plain line (shown to the user and kept in the ledger). */
function callError(settings: AiSettings, model: string, error: unknown): AiUnavailable {
  if (error instanceof AiUnavailable) return error;
  if (settings.provider === "anthropic") {
    if (error instanceof Anthropic.AuthenticationError) return new AiUnavailable("Anthropic rejected the API key");
    if (error instanceof Anthropic.RateLimitError) return new AiUnavailable("Anthropic rate limit reached, try again shortly");
    if (error instanceof Anthropic.NotFoundError) return new AiUnavailable(`Model "${model}" wasn't found`);
    if (error instanceof Anthropic.APIError) return new AiUnavailable(`Anthropic error ${error.status ?? ""}: ${error.message}`);
    return new AiUnavailable(error instanceof Error ? error.message : "AI request failed");
  }
  const local = /localhost|127\.0\.0\.1/.test(settings.baseUrl ?? "");
  return new AiUnavailable(
    local
      ? `Couldn't reach ${settings.baseUrl}. Is ${settings.preset === "lmstudio" ? "LM Studio's server" : "Ollama"} running?`
      : `Couldn't reach ${settings.baseUrl ?? "the AI"}. Check the address and your connection.`,
  );
}

/**
 * Asks the model for the purpose's task (`modelFor`) for JSON matching `schema`, answering in at
 * most `maxOutput` tokens. Before anything is sent the worst case (the prompt at about 4 characters
 * a token, plus `maxOutput`) is checked against the limits at that model's price: a call that could
 * cross one is refused (AiLimitReached). Every call, refused, failed or answered, lands in the usage
 * ledger with the model that ran it and the cost at its price. Throws AiUnavailable when no AI is
 * set up or it fails.
 */
export async function generateJson<T extends z.ZodType>(
  schema: T,
  system: string,
  prompt: string,
  purpose: AiPurpose,
  maxOutput: number,
): Promise<{ value: z.infer<T>; usage: AiUsage | null; preset: string; model: string; cost: number | null }> {
  const settings = getAiSettings();
  if (!settings) throw new AiUnavailable("No AI is connected");
  if (settings.provider === "anthropic" && !settings.apiKey) throw new AiUnavailable("Add your Anthropic API key in AI settings");
  const model = modelFor(settings, purpose.task, purpose.model);
  const price = model.price;
  const record = (entry: Pick<Parameters<typeof recordUsage>[0], "usage" | "cost" | "outcome" | "reason">) => {
    recordUsage({ action: purpose.action, preset: settings.preset, model: model.id, ruleId: purpose.ruleId, threadId: purpose.threadId, ...entry });
    announceUsage(usageSetup());
  };

  const estimate = { input: Math.ceil((system.length + prompt.length) / 4), output: maxOutput };
  const hit = limitsCheck(estimate, price, usageSetup());
  if (hit) {
    record({ usage: null, cost: null, outcome: "blocked", reason: hit.period === "day" ? "Daily limit" : "Monthly limit" });
    throw new AiLimitReached(hit);
  }

  logSent("ai", serviceName(settings), purpose.action, purpose.detail);
  let result: Metered<z.infer<T>>;
  try {
    result =
      settings.provider === "anthropic"
        ? await anthropicJson(settings, model.id, schema, system, prompt, maxOutput)
        : await openAiCompatibleJson(settings, model.id, schema, system, prompt, maxOutput);
  } catch (error) {
    const failure = callError(settings, model.id, error);
    record({ usage: null, cost: null, outcome: "error", reason: failure.message });
    throw failure;
  }
  const cost = result.usage ? costOf(result.usage, price) : null;
  record({ usage: result.usage, cost, outcome: "ok" });
  return { ...result, preset: settings.preset, model: model.id, cost };
}

export function aiConfigured() {
  const settings = getAiSettings();
  return !!settings && (settings.provider !== "anthropic" || !!settings.apiKey);
}

export async function testAi() {
  const started = Date.now();
  const { value } = await generateJson(
    z.object({ ok: z.boolean(), greeting: z.string() }),
    "You are a connection test.",
    'Return {"ok": true, "greeting": "<a five word greeting>"}.',
    { task: "test", action: "Connection test", detail: "No mail" },
    200,
  );
  return { ...value, latencyMs: Date.now() - started };
}
