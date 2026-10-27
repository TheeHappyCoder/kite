// What AI calls cost, for the usage ledger and its limits (Settings → AI). Users bring any
// provider and model, so the price is theirs to set (AI settings, US dollars per million tokens).
// A few well-known models are suggested so most people don't have to look it up; models running
// on this computer cost nothing. With no price, Kite shows tokens only.

export type AiUsage = { input: number; output: number };
/** US dollars per million tokens. */
export type AiPrice = { input: number; output: number };

/** A connected model: the id the provider knows, the name Kite shows, and what it costs (null: tokens only). */
export type AiModel = { id: string; name: string; price: AiPrice | null };

/** Claude models offered as tick boxes in AI settings, list prices (Oct 2026) prefilled, never assumed without the user's say. */
export const ANTHROPIC_MODELS: AiModel[] = [
  { id: "claude-haiku-5-5", name: "Haiku 5.5", price: { input: 0.1, output: 0.5 } },
  { id: "claude-sonnet-5-5", name: "Sonnet 5.5", price: { input: 2, output: 10 } },
  { id: "claude-opus-5-5", name: "Opus 5.5", price: { input: 4, output: 20 } },
  { id: "claude-fable-5-1", name: "Fable 5.1", price: { input: 10, output: 50 } },
];

const LOCAL_PRESETS = new Set(["ollama", "lmstudio"]);

export const isLocalPreset = (preset: string) => LOCAL_PRESETS.has(preset);

/** The price Kite uses for a model: free on a local preset, else the model's own, else none. */
function priceOf(preset: string, model: Pick<AiModel, "price"> | null | undefined): AiPrice | null {
  if (isLocalPreset(preset)) return { input: 0, output: 0 };
  return model?.price ?? null;
}

/** Connected models as the UI shows them (prices free on a local preset). */
export function pricedModels(preset: string, models: AiModel[]): AiModel[] {
  return models.map((m) => ({ ...m, price: priceOf(preset, m) }));
}

/** Whether limits can count dollars: every model priced, and not all free. */
export function dollarsPossibleFor(models: AiModel[]) {
  return models.length > 0 && models.every((m) => m.price) && models.some((m) => dollarsPossible(m.price));
}

/** Dollars for some usage at a price, or null without a price. */
export function costOf(usage: AiUsage, price: AiPrice | null) {
  return price ? (usage.input * price.input + usage.output * price.output) / 1_000_000 : null;
}

/** "$0.02", "<$0.01", "$1.40". */
export function formatDollars(amount: number) {
  if (amount === 0) return "$0";
  if (amount < 0.01) return "<$0.01";
  return `$${amount.toFixed(2)}`;
}

/** "12.4k", "200k", "950": a token count without the word. */
export function formatCount(tokens: number) {
  if (tokens < 1000) return String(Math.round(tokens));
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0).replace(/\.0$/, "")}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0).replace(/\.0$/, "")}M`;
}

/** "12.4k tokens". */
export function formatTokens(tokens: number) {
  return `${formatCount(tokens)} tokens`;
}

// ---------------------------------------------------------------------------
// Usage and limits (server/ai-usage.ts keeps the ledger; Settings → AI and the sidebar ring show it)
// ---------------------------------------------------------------------------

export type LimitUnit = "dollars" | "tokens";

/** Dollars need a price that isn't free (local models and no price count in tokens). */
function dollarsPossible(price: AiPrice | null) {
  return !!price && (price.input > 0 || price.output > 0);
}

/** A limit as said in a sentence: "$5", "$2.50", "200k tokens". */
export function formatLimit(value: number, unit: LimitUnit) {
  if (unit === "tokens") return formatTokens(value);
  return Number.isInteger(value) ? `$${value}` : `$${value.toFixed(2)}`;
}

/** An amount used: "$1.20", "12.4k" (`bare`: no "tokens", the sentence says it). */
function formatUsed(value: number, unit: LimitUnit, bare = false) {
  if (unit === "dollars") return formatDollars(value);
  return bare ? formatCount(value) : formatTokens(value);
}

/** Every limit message ends with this; the app turns "Usage" into a link to Settings → AI. */
export const LIMIT_HINT = "Change it in Usage.";

export function limitMessage(period: "day" | "month", limit: number, unit: LimitUnit) {
  return `You've reached ${period === "day" ? "today's" : "this month's"} AI limit of ${formatLimit(limit, unit)}. ${LIMIT_HINT}`;
}

export type UsageTotals = { tokens: number; cost: number | null; calls: number; blocked: number };

/** The ring: share of the tighter limit used (null with no limit), and which one it is. */
export type UsageRingData = { share: number | null; period: "day" | "month" | null; used: number; limit: number | null; unit: LimitUnit };

/** What the sidebar and the AI page need, also sent live as the `ai` sync event. */
export type AiUsageSummary = {
  configured: boolean;
  preset: string | null;
  /** The default model's name. */
  model: string | null;
  /** Every connected model, prices as Kite counts them (free on a local preset). */
  models: AiModel[];
  local: boolean;
  /** The default model's price, null without one. */
  price: AiPrice | null;
  /** Every model has a price and they aren't all free, so limits can count dollars. */
  priceSet: boolean;
  /** The unit limits are counted in: dollars only with a price. */
  unit: LimitUnit;
  limits: { daily: number | null; monthly: number | null };
  today: UsageTotals;
  month: UsageTotals;
  ring: UsageRingData;
};

export type UsageOutcome = "ok" | "error" | "blocked";

/** GET /api/ai/usage: the summary plus this month by action and the latest calls. */
export type AiUsageReport = AiUsageSummary & {
  byAction: { action: string; calls: number; tokens: number; cost: number | null }[];
  recent: { id: number; at: string; action: string; model: string; tokens: number | null; cost: number | null; outcome: UsageOutcome; reason: string | null }[];
};

/** "62% of this month's $5", "$0.12 this month · no limit", "No AI used this month". */
export function ringLabel(usage: AiUsageSummary) {
  const { ring } = usage;
  if (ring.share !== null && ring.limit !== null && ring.period) {
    return `${Math.round(ring.share * 100)}% of ${ring.period === "day" ? "today's" : "this month's"} ${formatLimit(ring.limit, ring.unit)}`;
  }
  if (!usage.month.calls) return "No AI used this month";
  return `${formatUsed(ring.used, ring.unit)} this month · no limit`;
}
