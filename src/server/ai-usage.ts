import "server-only";

import { EventEmitter } from "node:events";
import {
  costOf,
  dollarsPossibleFor,
  type AiModel,
  type AiPrice,
  type AiUsage,
  type AiUsageReport,
  type AiUsageSummary,
  type LimitUnit,
  type UsageOutcome,
  type UsageRingData,
  type UsageTotals,
} from "@/lib/ai-pricing";
import { getDb } from "./db";
import { getPreferences } from "./settings";

// The AI ledger: one row per AI call (clicks, rule drafts, the connection test), with tokens and
// cost, plus the hard limits checked before a call is sent (server/ai.ts). Rows hold ids only,
// never mail text or addresses. This module doesn't import ai.ts or sync.ts (cycles): ai.ts passes
// the AI setup in, and sync.ts re-emits `usageEvents` as the `ai` sync event.

/** Rows older than this are dropped. */
const KEEP_DAYS = 400;

type UsageRow = {
  action: string;
  preset: string;
  model: string;
  usage: AiUsage | null;
  cost: number | null;
  outcome: UsageOutcome;
  reason?: string | null;
  ruleId?: string | null;
  threadId?: string | null;
};

/**
 * The AI as the ledger needs it (server/ai.ts `usageSetup`); null when none is connected. `models`
 * carry the prices Kite counts with (free on a local preset), the default model first.
 */
export type UsageSetup = { configured: boolean; preset: string; models: AiModel[]; local: boolean } | null;

const g = globalThis as typeof globalThis & { __kiteAiUsageEvents?: EventEmitter };
/** Fires "usage" with an AiUsageSummary after every recorded call and after the limits change. */
export const usageEvents = (g.__kiteAiUsageEvents ??= new EventEmitter().setMaxListeners(20));

export function recordUsage(row: UsageRow) {
  const db = getDb();
  db.prepare(
    `INSERT INTO ai_usage (at, action, preset, model, input_tokens, output_tokens, cost, outcome, reason, rule_id, thread_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    new Date().toISOString(),
    row.action,
    row.preset,
    row.model,
    row.usage?.input ?? null,
    row.usage?.output ?? null,
    row.cost,
    row.outcome,
    row.reason?.slice(0, 200) ?? null,
    row.ruleId ?? null,
    row.threadId ?? null,
  );
  db.prepare("DELETE FROM ai_usage WHERE at < ?").run(new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString());
}

/** Local midnight today, and the first of this month (limits follow your clock). */
function windows() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const month = new Date(day);
  month.setDate(1);
  return { day: day.toISOString(), month: month.toISOString() };
}

/** What calls since `since` used. Refused calls are counted apart and use nothing. */
function usageSince(since: string): UsageTotals {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens,
         SUM(cost) AS cost,
         SUM(outcome != 'blocked') AS calls,
         SUM(outcome = 'blocked') AS blocked
       FROM ai_usage WHERE at >= ?`,
    )
    .get(since) as { tokens: number; cost: number | null; calls: number | null; blocked: number | null };
  return { tokens: row.tokens, cost: row.cost, calls: row.calls ?? 0, blocked: row.blocked ?? 0 };
}

/** The unit limits count in: dollars only when every connected model has a price and they aren't all free. */
function effectiveUnit(setup: UsageSetup): LimitUnit {
  return getPreferences().aiLimits.unit === "dollars" && dollarsPossibleFor(setup?.models ?? []) ? "dollars" : "tokens";
}

const amount = (totals: UsageTotals, unit: LimitUnit) => (unit === "dollars" ? (totals.cost ?? 0) : totals.tokens);

export type LimitHit = { period: "day" | "month"; limit: number; unit: LimitUnit };

/**
 * Whether a call that could use up to `estimate` at `price` (the model chosen for it) would cross
 * today's or this month's limit (what's used so far plus the worst case). Null when it fits.
 */
export function limitsCheck(estimate: AiUsage, price: AiPrice | null, setup: UsageSetup): LimitHit | null {
  const { daily, monthly } = getPreferences().aiLimits;
  if (daily === null && monthly === null) return null;
  const unit = effectiveUnit(setup);
  const next = unit === "dollars" ? (costOf(estimate, price) ?? 0) : estimate.input + estimate.output;
  const { day, month } = windows();
  if (daily !== null && amount(usageSince(day), unit) + next > daily) return { period: "day", limit: daily, unit };
  if (monthly !== null && amount(usageSince(month), unit) + next > monthly) return { period: "month", limit: monthly, unit };
  return null;
}

function ringOf(today: UsageTotals, month: UsageTotals, unit: LimitUnit, daily: number | null, monthly: number | null): UsageRingData {
  const candidates = [
    { period: "day" as const, used: amount(today, unit), limit: daily },
    { period: "month" as const, used: amount(month, unit), limit: monthly },
  ].filter((c): c is { period: "day" | "month"; used: number; limit: number } => c.limit !== null);
  if (!candidates.length) return { share: null, period: null, used: amount(month, unit), limit: null, unit };
  const tight = candidates.reduce((a, b) => (b.used / b.limit > a.used / a.limit ? b : a));
  return { share: Math.min(1, tight.used / tight.limit), period: tight.period, used: tight.used, limit: tight.limit, unit };
}

function usageSummary(setup: UsageSetup): AiUsageSummary {
  const models = setup?.models ?? [];
  const unit = effectiveUnit(setup);
  const { daily, monthly } = getPreferences().aiLimits;
  const { day, month } = windows();
  const today = usageSince(day);
  const thisMonth = usageSince(month);
  return {
    configured: !!setup?.configured,
    preset: setup?.preset ?? null,
    model: models[0]?.name ?? null,
    models,
    local: !!setup?.local,
    price: models[0]?.price ?? null,
    priceSet: dollarsPossibleFor(models),
    unit,
    limits: { daily, monthly },
    today,
    month: thisMonth,
    ring: ringOf(today, thisMonth, unit, daily, monthly),
  };
}

/** The summary plus this month by action and the latest calls (Settings → AI). */
export function usageReport(setup: UsageSetup): AiUsageReport {
  const db = getDb();
  const { month } = windows();
  const byAction = db
    .prepare(
      `SELECT action, COUNT(*) AS calls, COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens, SUM(cost) AS cost
       FROM ai_usage WHERE at >= ? AND outcome != 'blocked' GROUP BY action ORDER BY COALESCE(SUM(cost), 0) DESC, COUNT(*) DESC`,
    )
    .all(month) as AiUsageReport["byAction"];
  const recent = db
    .prepare(
      `SELECT id, at, action, model, CASE WHEN input_tokens IS NULL THEN NULL ELSE input_tokens + COALESCE(output_tokens, 0) END AS tokens, cost, outcome, reason
       FROM ai_usage ORDER BY id DESC LIMIT 50`,
    )
    .all() as AiUsageReport["recent"];
  return { ...usageSummary(setup), byAction, recent };
}

/** Tells open windows (via the sync engine's `ai` event). */
export function announceUsage(setup: UsageSetup) {
  usageEvents.emit("usage", usageSummary(setup));
}

/** Disconnect AI. */
export function clearUsage() {
  getDb().prepare("DELETE FROM ai_usage").run();
}

/** Disconnect an account: rows about its conversations go. */
export function clearUsageForAccount(accountId: string) {
  getDb().prepare("DELETE FROM ai_usage WHERE substr(thread_id, 1, length(?) + 1) = ? || ':'").run(accountId, accountId);
}
