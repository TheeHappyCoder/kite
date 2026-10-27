"use client";

import { useEffect, useState } from "react";
import { format, isToday } from "date-fns";
import {
  formatCount,
  formatDollars,
  formatLimit,
  formatTokens,
  type AiModel,
  type AiUsageReport,
  type AiUsageSummary,
  type LimitUnit,
  type UsageTotals,
} from "@/lib/ai-pricing";
import { AI_TASKS, AI_TASK_INFO, type AiModelChoices } from "@/lib/ai-tasks";
import type { AiLimits, PreferencesPatch } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { AiLogo } from "../ai-logos";
import { presetName } from "../ai-settings";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Select } from "../ui/select";
import { Tooltip } from "../ui/tooltip";
import { UsageRing } from "../ui/usage-ring";
import { Group, Note, Row, Segmented, buttonClass, quietButtonClass } from "./settings-ui";

// Settings → AI: what AI calls used (the ledger, server/ai-usage.ts), the daily and monthly limits
// Kite enforces before a call is sent, the AI it talks to and which model runs each task
// (lib/ai-tasks.ts), this month by action and the latest calls.

type Props = {
  /** Live from the `ai` sync event (null until the first one, and in demo mode). */
  usage: AiUsageSummary | null;
  /** Which model runs each task (preferences.aiModels). */
  models: AiModelChoices;
  onLimits: (patch: Partial<AiLimits>) => Promise<void>;
  onModels: (patch: NonNullable<PreferencesPatch["aiModels"]>) => Promise<void>;
  onOpenAi: () => void;
  demo: boolean;
};

const UNITS: { id: LimitUnit; label: string }[] = [
  { id: "dollars", label: "Dollars" },
  { id: "tokens", label: "Tokens" },
];

/** "$1.20 of $5", "12.4k of 200k tokens", "$1.20 · no limit". */
function usedLine(totals: UsageTotals, limit: number | null, unit: LimitUnit) {
  if (unit === "dollars") {
    const used = formatDollars(totals.cost ?? 0);
    return limit === null ? `${used} · no limit` : `${used} of ${formatLimit(limit, unit)}`;
  }
  return limit === null ? `${formatTokens(totals.tokens)} · no limit` : `${formatCount(totals.tokens)} of ${formatLimit(limit, unit)}`;
}

/** "200k" -> 200000, "1.5m" -> 1500000, "$2.50" -> 2.5. Null when it isn't a positive number. */
function parseLimit(text: string): number | null {
  const match = text.trim().replace(/[$,\s]/g, "").match(/^(\d*\.?\d+)([km]?)$/i);
  if (!match) return null;
  const value = Number(match[1]) * (match[2].toLowerCase() === "k" ? 1_000 : match[2].toLowerCase() === "m" ? 1_000_000 : 1);
  return value > 0 && Number.isFinite(value) ? value : null;
}

const limitText = (value: number | null, unit: LimitUnit) => (value === null ? "" : unit === "tokens" ? formatCount(value) : String(value));

/** "$0.10 in / $0.50 out", "free", or undefined without a price. */
const priceLine = (m: AiModel) => (m.price ? (m.price.input === 0 && m.price.output === 0 ? "free" : `${m.price.input} in / ${m.price.output} out`) : undefined);

const when = (iso: string) => {
  const date = new Date(iso);
  return isToday(date) ? `Today ${format(date, "HH:mm")}` : format(date, "d MMM HH:mm");
};

export function AiSection({ usage, models, onLimits, onModels, onOpenAi, demo }: Props) {
  const [report, setReport] = useState<AiUsageReport | null>(null);
  // Every `ai` event (a call recorded, the limits changed) reads the whole page again.
  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    fetch("/api/ai/usage", { signal: controller.signal })
      .then((res) => res.json() as Promise<AiUsageReport>)
      .then(setReport)
      .catch(() => {});
    return () => controller.abort();
  }, [demo, usage]);

  const live = report ? { ...report, ...usage } : null;
  if (!live || !live.configured) {
    return (
      <Group title="Usage">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
          <Note className="min-w-0 flex-1 basis-48">{demo ? "AI works on your own mail. Connect an account, then an AI, to see usage." : "Connect an AI to see usage."}</Note>
          {demo || !report ? null : (
            <button onClick={onOpenAi} className={buttonClass}>
              Connect
            </button>
          )}
        </div>
      </Group>
    );
  }

  // The limits come with the usage (live, so a change anywhere shows here).
  const { unit } = live;
  const top = live.byAction[0];
  const measure = (a: AiUsageReport["byAction"][number]) => (live.priceSet && a.cost !== null ? a.cost : a.tokens);
  const topValue = top ? measure(top) : 0;

  return (
    <>
      <Group title="Usage">
        <div className="flex min-w-0 items-center gap-4 px-4 py-4">
          <span className="relative grid shrink-0 place-items-center text-pane-muted">
            <UsageRing share={live.ring.share} size={56} stroke={5} />
            <span className="absolute text-[11.5px] font-semibold tabular-nums text-pane-fg">
              {live.ring.share === null ? "–" : `${Math.round(live.ring.share * 100)}%`}
            </span>
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <UsageLine label="This month" totals={live.month} text={usedLine(live.month, live.limits.monthly, unit)} cost={unit === "tokens" && live.priceSet} />
            <UsageLine label="Today" totals={live.today} text={usedLine(live.today, live.limits.daily, unit)} cost={unit === "tokens" && live.priceSet} />
          </div>
        </div>
      </Group>

      <Group title="Limits">
        {live.local ? null : (
          <Row
            label="Count in"
            detail={live.priceSet ? "Dollars use the price in AI setup. Switching clears the limits." : "Set a price in AI setup to limit dollars."}
            control={
              <Segmented
                label="Count limits in"
                value={unit}
                options={UNITS.map((u) => (u.id === "dollars" && !live.priceSet ? { ...u, disabled: "Set a price in AI setup" } : u))}
                onChange={(next) => void (next !== unit && onLimits({ unit: next, daily: null, monthly: null }))}
              />
            }
          />
        )}
        <LimitRow label="Daily" value={live.limits.daily} unit={unit} onSave={(daily) => onLimits({ unit, daily })} />
        <LimitRow label="Monthly" value={live.limits.monthly} unit={unit} onSave={(monthly) => onLimits({ unit, monthly })} />
        <div className="px-4 py-3">
          <Note>Kite refuses an AI request before it&apos;s sent when it could cross a limit. Automation drafts count too.</Note>
        </div>
      </Group>

      <Group title="Setup">
        <Row
          label={
            <span className="flex min-w-0 items-center gap-2">
              {live.preset && live.preset !== "custom" ? <AiLogo id={live.preset} size={16} /> : null}
              <span className="truncate">{live.model}</span>
            </span>
          }
          detail={`${presetName(live.preset ?? "custom")} · ${live.models.length > 1 ? `default of ${live.models.length} models · ` : ""}${
            live.local ? "runs on this computer, no cost" : live.price ? `${live.price.input} in / ${live.price.output} out per million tokens` : "no price set, so usage is in tokens"
          }`}
          control={
            <button onClick={onOpenAi} className={buttonClass}>
              Change
            </button>
          }
        />
        {live.models.length > 1
          ? AI_TASKS.map((task) => {
              const chosen = live.models.find((m) => m.id === models[task]);
              return (
                <Row
                  key={task}
                  label={AI_TASK_INFO[task].label}
                  detail={AI_TASK_INFO[task].detail}
                  control={
                    <Select
                      label={`Model for ${AI_TASK_INFO[task].label}`}
                      value={chosen?.id ?? ""}
                      options={[{ value: "", label: `Default (${live.model})` }, ...live.models.map((m) => ({ value: m.id, label: m.name, detail: priceLine(m) }))]}
                      onChange={(id) => void onModels({ [task]: id || null })}
                    />
                  }
                />
              );
            })
          : null}
      </Group>

      {live.byAction.length ? (
        <Group title="By action" description="This month.">
          <div className="flex flex-col gap-2.5 px-4 py-3.5">
            {live.byAction.map((a) => {
              const value = measure(a);
              const share = topValue > 0 ? value / topValue : 0;
              return (
                <div key={a.action} className="flex min-w-0 items-center gap-3 text-[12.5px]">
                  <span className="w-[clamp(6rem,28%,10rem)] shrink-0 truncate">{a.action}</span>
                  <span className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="h-1.5 min-w-0 rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.max(2, share * 70)}%` }} />
                    <span className="shrink-0 tabular-nums text-pane-fg">{live.priceSet && a.cost !== null ? formatDollars(a.cost) : formatTokens(a.tokens)}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-pane-muted">
                    {a.calls} call{a.calls === 1 ? "" : "s"}
                  </span>
                </div>
              );
            })}
          </div>
        </Group>
      ) : null}

      <Group title="Recent" description="The latest 50 AI requests. No mail is kept here.">
        {live.recent.length ? (
          <FluidList tone="pane" className="flex flex-col p-1.5">
            {live.recent.map((r) => (
              <div
                key={r.id}
                {...FLUID_ITEM}
                className="flex min-w-0 items-center gap-3 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors duration-150 data-[lit]:bg-pane-hover"
              >
                <span className="w-[6.5rem] shrink-0 tabular-nums text-pane-muted">{when(r.at)}</span>
                <span className="min-w-0 shrink-0 basis-28 truncate">{r.action}</span>
                <span className="min-w-0 flex-1 truncate text-pane-muted">{live.models.find((m) => m.id === r.model)?.name ?? r.model}</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-pane-muted">{r.tokens === null ? "–" : formatCount(r.tokens)}</span>
                <span className="w-14 shrink-0 text-right tabular-nums text-pane-muted">{r.cost === null ? "–" : formatDollars(r.cost)}</span>
                <Outcome outcome={r.outcome} reason={r.reason} />
              </div>
            ))}
          </FluidList>
        ) : (
          <p className="px-4 py-3.5 text-[12.5px] text-pane-muted">No AI requests yet.</p>
        )}
      </Group>
    </>
  );
}

function UsageLine({ label, totals, text, cost }: { label: string; totals: UsageTotals; text: string; cost: boolean }) {
  return (
    <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-[12.5px]">
      <span className="w-20 shrink-0 text-pane-muted">{label}</span>
      <span className="font-medium tabular-nums">{text}</span>
      <span className="text-[11.5px] tabular-nums text-pane-muted">
        {cost && totals.cost !== null ? `${formatDollars(totals.cost)} · ` : ""}
        {totals.calls} request{totals.calls === 1 ? "" : "s"}
        {totals.blocked ? ` · ${totals.blocked} refused` : ""}
      </span>
    </p>
  );
}

function Outcome({ outcome, reason }: { outcome: AiUsageReport["recent"][number]["outcome"]; reason: string | null }) {
  const chip = (
    <span
      className={cn(
        "w-[3.75rem] shrink-0 rounded-full px-1.5 py-px text-center text-[11px]",
        outcome === "ok" ? "text-pane-muted" : outcome === "blocked" ? "bg-warning/10 text-warning" : "bg-danger/10 text-danger",
      )}
    >
      {outcome}
    </span>
  );
  return outcome !== "ok" && reason ? (
    <Tooltip label={reason} className="inline-flex shrink-0">
      {chip}
    </Tooltip>
  ) : (
    chip
  );
}

/** Daily / Monthly: a pill number field that saves on Enter or when you leave it, and "No limit". */
function LimitRow({ label, value, unit, onSave }: { label: string; value: number | null; unit: LimitUnit; onSave: (value: number | null) => Promise<void> }) {
  const [text, setText] = useState(limitText(value, unit));
  const [seen, setSeen] = useState({ value, unit });
  if (seen.value !== value || seen.unit !== unit) {
    setSeen({ value, unit });
    setText(limitText(value, unit));
  }
  const commit = () => {
    if (!text.trim()) return value === null ? undefined : void onSave(null);
    const next = parseLimit(text);
    if (next === null) return setText(limitText(value, unit));
    if (next !== value) void onSave(next);
  };
  return (
    <Row
      label={label}
      detail={value === null ? "No limit." : `Up to ${formatLimit(value, unit)} ${label === "Daily" ? "a day" : "a month"}.`}
      control={
        <span className="flex shrink-0 items-center gap-1">
          <label className="flex h-8 w-36 items-center gap-1 rounded-full border border-pane-border px-3 text-[12.5px] focus-within:border-accent/60">
            {unit === "dollars" ? <span className="text-pane-muted">$</span> : null}
            <input
              inputMode="decimal"
              value={text}
              placeholder="No limit"
              aria-label={`${label} limit`}
              onChange={(e) => setText(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="min-w-0 flex-1 bg-transparent tabular-nums outline-none placeholder:text-pane-muted"
            />
            {unit === "tokens" ? <span className="text-pane-muted">tokens</span> : null}
          </label>
          {value === null ? null : (
            <button onClick={() => void onSave(null)} className={quietButtonClass}>
              No limit
            </button>
          )}
        </span>
      }
    />
  );
}
