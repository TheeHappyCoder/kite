"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Add01Icon, Cancel01Icon, CheckmarkCircle02Icon, LockIcon, ServerStack01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import { ANTHROPIC_MODELS, type AiModel, type AiPrice } from "@/lib/ai-pricing";
import { cn } from "@/lib/utils";
import { AiLogo } from "./ai-logos";
import { Icon } from "./icon";
import { Dialog } from "./ui/dialog";
import { Thinking } from "./ui/thinking";
import { Tooltip } from "./ui/tooltip";

// Bring your own AI: one provider and key, several models. Claude's models are tick boxes with
// their list prices prefilled; everywhere else the user adds model names. One model is the default;
// Settings → AI picks another per task.

type Provider = "anthropic" | "openai-compatible";

type Preset = {
  id: string;
  name: string;
  provider: Provider;
  baseUrl?: string;
  local?: boolean;
  needsKey: boolean;
  /** A model to start with when none is saved. */
  models?: string[];
  modelPlaceholder?: string;
  note: string;
};

const PRESETS: Preset[] = [
  { id: "anthropic", name: "Claude", provider: "anthropic", needsKey: true, note: "Anthropic API key from console.anthropic.com. Tick the models you want to use." },
  { id: "openai", name: "OpenAI", provider: "openai-compatible", baseUrl: "https://api.openai.com/v1", needsKey: true, modelPlaceholder: "Model name from your OpenAI account", note: "OpenAI API key." },
  { id: "openrouter", name: "OpenRouter", provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, modelPlaceholder: "e.g. provider/model-name", note: "One key, many models." },
  { id: "deepseek", name: "DeepSeek", provider: "openai-compatible", baseUrl: "https://api.deepseek.com", needsKey: true, models: ["deepseek-v4-flash"], note: "DeepSeek API key." },
  { id: "groq", name: "Groq", provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, modelPlaceholder: "Model name from Groq", note: "Groq API key." },
  { id: "ollama", name: "Ollama", provider: "openai-compatible", baseUrl: "http://localhost:11434/v1", local: true, needsKey: false, modelPlaceholder: "A model you've pulled, e.g. llama3.2", note: "Runs on this computer. Nothing leaves it." },
  { id: "lmstudio", name: "LM Studio", provider: "openai-compatible", baseUrl: "http://localhost:1234/v1", local: true, needsKey: false, modelPlaceholder: "The model loaded in LM Studio", note: "Runs on this computer. Nothing leaves it." },
  { id: "custom", name: "Other", provider: "openai-compatible", needsKey: false, modelPlaceholder: "Model name", note: "Any OpenAI-compatible server." },
];

export const presetName = (id: string) => PRESETS.find((p) => p.id === id)?.name ?? "Other";

type Saved = { provider: Provider; preset: string; models: AiModel[]; defaultModel: string; baseUrl?: string; hasKey: boolean; keyHint: string | null } | null;

/** A model as edited: prices as text so a half-typed number stays put. */
type Row = { id: string; name: string; input: string; output: string };

const priceText = (n: number | undefined) => (n === undefined ? "" : String(n));
const rowOf = (m: AiModel): Row => ({ id: m.id, name: m.name, input: priceText(m.price?.input), output: priceText(m.price?.output) });
const blankRow = (id = ""): Row => ({ id, name: id, input: "", output: "" });

/** Both prices or neither; null = no price. Undefined when the pair is half filled or not a number. */
function priceOfRow(row: Row): AiPrice | null | undefined {
  const input = row.input.trim();
  const output = row.output.trim();
  if (!input && !output) return null;
  const price = { input: Number(input), output: Number(output) };
  return input && output && Number.isFinite(price.input + price.output) && price.input >= 0 && price.output >= 0 ? price : undefined;
}

export function AiSettings({ open, onClose, onChanged }: { open: boolean; onClose: () => void; onChanged: (connected: boolean) => void }) {
  const [saved, setSaved] = useState<Saved>(null);
  const [presetId, setPresetId] = useState("anthropic");
  const [rows, setRows] = useState<Row[]>(() => [rowOf(ANTHROPIC_MODELS[2])]);
  const [defaultModel, setDefaultModel] = useState(ANTHROPIC_MODELS[2].id);
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [status, setStatus] = useState<{ kind: "idle" | "testing" | "ok" | "error"; message?: string }>({ kind: "idle" });
  const preset = PRESETS.find((p) => p.id === presetId)!;

  useEffect(() => {
    if (!open) return;
    fetch("/api/ai")
      .then((res) => res.json())
      .then((data: { settings: Saved }) => {
        setSaved(data.settings);
        if (data.settings) {
          setPresetId(data.settings.preset);
          setRows(data.settings.models.map(rowOf));
          setDefaultModel(data.settings.defaultModel);
          setBaseUrl(data.settings.baseUrl ?? "");
        }
      });
  }, [open]);

  /** A preset's starting models: what's saved for it, else its suggestion, else one blank row. */
  const choose = (next: Preset) => {
    setPresetId(next.id);
    const kept = saved?.preset === next.id ? saved.models.map(rowOf) : [];
    const start = kept.length ? kept : next.id === "anthropic" ? [rowOf(ANTHROPIC_MODELS[2])] : (next.models ?? [""]).map(blankRow);
    setRows(start);
    setDefaultModel(kept.length && saved ? saved.defaultModel : start[0].id);
    setBaseUrl(next.baseUrl ?? (saved?.preset === next.id ? saved.baseUrl ?? "" : ""));
    setApiKey("");
    setStatus({ kind: "idle" });
  };

  const edit = (i: number, patch: Partial<Row>) => setRows((list) => list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => setRows((list) => list.filter((_, j) => j !== i));

  /** Claude: tick a model on or off (its list price comes along). */
  const tick = (m: AiModel) =>
    setRows((list) => {
      const at = list.findIndex((r) => r.id === m.id);
      if (at >= 0) return list.filter((_, j) => j !== at);
      const next = [...list, rowOf(m)];
      return ANTHROPIC_MODELS.filter((k) => next.some((r) => r.id === k.id)).map((k) => next.find((r) => r.id === k.id)!);
    });

  const keyOnFile = saved?.preset === presetId && saved.hasKey;
  const ids = rows.map((r) => r.id.trim());
  const idsOk = ids.length > 0 && ids.every(Boolean) && new Set(ids).size === ids.length;
  const pricesOk = preset.local || rows.every((r) => priceOfRow(r) !== undefined);
  const canSave = idsOk && pricesOk && (preset.provider === "anthropic" || !!baseUrl.trim()) && (!preset.needsKey || !!apiKey.trim() || keyOnFile);
  const chosenDefault = ids.includes(defaultModel) ? defaultModel : ids[0];

  const save = async () => {
    setStatus({ kind: "testing" });
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: preset.provider,
        preset: preset.id,
        models: rows.map((r) => ({ id: r.id.trim(), name: r.name.trim() || r.id.trim(), price: preset.local ? null : priceOfRow(r) ?? null })),
        defaultModel: chosenDefault,
        baseUrl: preset.provider === "anthropic" ? undefined : baseUrl.trim(),
        apiKey: apiKey.trim() || undefined,
        test: true,
      }),
    });
    const data = await res.json();
    setApiKey("");
    if (data.settings) {
      setSaved(data.settings);
      setRows(data.settings.models.map(rowOf));
      setDefaultModel(data.settings.defaultModel);
    }
    if (data.ok) {
      setStatus({ kind: "ok", message: `Connected in ${(data.test.latencyMs / 1000).toFixed(1)}s. It only runs when you ask, or for automations you let use AI.` });
      onChanged(true);
    } else {
      setStatus({ kind: "error", message: data.error ?? "That didn't work" });
    }
  };

  const disconnect = async () => {
    await fetch("/api/ai", { method: "DELETE", headers: { "content-type": "application/json" } });
    setSaved(null);
    setStatus({ kind: "idle" });
    onChanged(false);
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Bring your own AI"
      description="For summaries, drafted replies and rewrites when you ask, and automations you describe. Use any provider, or a model running on this computer."
      footer={
        <>
          {saved ? (
            <button onClick={disconnect} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
              Disconnect
            </button>
          ) : null}
          <button onClick={onClose} className="ml-auto h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
            Close
          </button>
          <button
            onClick={save}
            disabled={!canSave || status.kind === "testing"}
            className="flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane disabled:opacity-40"
          >
            {status.kind === "testing" ? <Thinking timer={false} steps={["Saying hello", "Waiting for a reply"]} /> : "Save and test"}
          </button>
        </>
      }
    >
      <div className="px-5 pb-4">
        <div className="grid grid-cols-4 gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              onClick={() => choose(p)}
              className={cn(
                "relative flex h-[76px] flex-col items-center justify-center gap-1.5 rounded-xl border text-[12.5px] font-medium transition-colors",
                presetId === p.id ? "border-accent/60 bg-accent-soft text-pane-fg" : "border-pane-border hover:bg-pane-hover",
              )}
            >
              {p.id === "custom" ? <Icon icon={ServerStack01Icon} size={22} /> : <AiLogo id={p.id} size={22} />}
              <span className="leading-none">{p.name}</span>
              {p.local ? <span className="-mt-0.5 text-[10px] font-normal leading-none text-success">On this device</span> : null}
              {saved?.preset === p.id ? <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-success" /> : null}
            </button>
          ))}
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={presetId} {...blurFade({ y: 6 })} className="mt-4 flex flex-col gap-3">
            <p className="text-[12.5px] text-pane-muted">{preset.note}</p>
            <Field label="Models" hint={preset.local ? "Pick the default; Settings → AI can send each task to another." : "Prices are what you pay, in dollars per million tokens, for usage and limits. Pick the default; Settings → AI can send each task to another."}>
              <div className="flex flex-col gap-1.5">
                {preset.id === "anthropic"
                  ? ANTHROPIC_MODELS.map((m) => {
                      const at = rows.findIndex((r) => r.id === m.id);
                      const on = at >= 0;
                      return (
                        <ModelRow key={m.id} on={on} onTick={() => tick(m)} isDefault={on && chosenDefault === m.id} onDefault={() => setDefaultModel(m.id)}>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">
                            {m.name} <span className="tabular-nums text-[11px] font-normal text-pane-muted">{m.id}</span>
                          </span>
                          {on ? <PricePair row={rows[at]} onChange={(patch) => edit(at, patch)} /> : null}
                        </ModelRow>
                      );
                    })
                  : rows.map((r, i) => (
                      <ModelRow
                        key={i}
                        isDefault={chosenDefault === r.id.trim() && !!r.id.trim()}
                        onDefault={() => setDefaultModel(r.id.trim())}
                        onRemove={rows.length > 1 ? () => remove(i) : undefined}
                      >
                        <input
                          value={r.id}
                          onChange={(e) => edit(i, { id: e.target.value, name: r.name === r.id ? e.target.value : r.name })}
                          placeholder={preset.modelPlaceholder}
                          aria-label="Model name"
                          className={cn(inputClass, "h-8 min-w-0 flex-1 tabular-nums text-[12px]")}
                        />
                        {preset.local ? null : <PricePair row={r} onChange={(patch) => edit(i, patch)} />}
                      </ModelRow>
                    ))}
                {preset.id !== "anthropic" && rows.length < 20 ? (
                  <button
                    type="button"
                    onClick={() => setRows((list) => [...list, blankRow()])}
                    className="flex h-8 items-center gap-1.5 self-start rounded-full px-2.5 text-[12px] font-medium text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
                  >
                    <Icon icon={Add01Icon} size={13} />
                    Add a model
                  </button>
                ) : null}
                {pricesOk ? null : <p className="text-[11.5px] text-warning">Fill in both prices for a model, or leave both empty.</p>}
                {idsOk || !rows.length ? null : <p className="text-[11.5px] text-warning">Every model needs a name, each one once.</p>}
              </div>
            </Field>
            {preset.provider === "openai-compatible" ? (
              <Field label="Server">
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…/v1" className={cn(inputClass, "tabular-nums text-[12px]")} />
              </Field>
            ) : null}
            {preset.needsKey || preset.id === "custom" ? (
              <Field label="API key" hint="Stays on this computer and is never shown again.">
                <input
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={keyOnFile ? `Saved (${saved?.keyHint}), leave blank to keep it` : "Paste your key"}
                  className={cn(inputClass, "tabular-nums text-[12px]")}
                />
              </Field>
            ) : null}
          </motion.div>
        </AnimatePresence>

        <AnimatePresence mode="popLayout">
          {status.kind === "ok" || status.kind === "error" ? (
            <motion.div
              key={status.message}
              {...blurFade({ y: 4 })}
              className={cn(
                "mt-4 flex items-start gap-2 rounded-xl px-3 py-2.5 text-[12.5px]",
                status.kind === "ok" ? "bg-success/10 text-success" : "bg-warning/10 text-warning",
              )}
            >
              {status.kind === "ok" ? <Icon icon={CheckmarkCircle02Icon} size={16} className="mt-px shrink-0" /> : null}
              {status.message}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <p className="mt-4 flex items-center gap-1.5 text-[11.5px] text-pane-muted">
          <Icon icon={LockIcon} size={12} className="shrink-0" />
          The AI only sees what you ask about. Every request shows in Settings → Privacy.
        </p>
      </div>
    </Dialog>
  );
}

const inputClass =
  "h-9 w-full rounded-lg border border-pane-border bg-pane-2 px-3 text-[13px] outline-none placeholder:text-pane-muted focus:border-accent/60";

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12px] font-medium">{label}</span>
      {children}
      {hint ? <span className="text-[11.5px] text-pane-muted">{hint}</span> : null}
    </div>
  );
}

/** One model: an optional tick box (Claude), the content, the Default pill and an optional remove. */
function ModelRow({
  on = true,
  onTick,
  isDefault,
  onDefault,
  onRemove,
  children,
}: {
  on?: boolean;
  onTick?: () => void;
  isDefault: boolean;
  onDefault: () => void;
  onRemove?: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors", on ? "border-pane-border" : "border-transparent text-pane-muted")}>
      {onTick ? (
        <button
          type="button"
          role="checkbox"
          aria-checked={on}
          aria-label="Use this model"
          onClick={onTick}
          className={cn("grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors duration-150", on ? "border-accent bg-accent" : "border-pane-border")}
        >
          {on ? <Icon icon={Tick02Icon} size={11} className="text-white" /> : null}
        </button>
      ) : null}
      {children}
      {on ? (
        <button
          type="button"
          onClick={onDefault}
          aria-pressed={isDefault}
          className={cn(
            "h-7 shrink-0 rounded-full border px-2.5 text-[11.5px] transition-[color,background-color,font-weight] duration-150",
            isDefault ? "border-accent/60 bg-accent-soft font-semibold text-pane-fg" : "border-transparent text-pane-muted hover:text-pane-fg",
          )}
        >
          Default
        </button>
      ) : null}
      {onRemove ? (
        <Tooltip label="Remove">
          <button type="button" onClick={onRemove} aria-label="Remove model" className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
            <Icon icon={Cancel01Icon} size={13} />
          </button>
        </Tooltip>
      ) : null}
    </div>
  );
}

/** "$ In / $ Out" per million tokens. */
function PricePair({ row, onChange }: { row: Row; onChange: (patch: Partial<Row>) => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-[12px] text-pane-muted">
      <PriceInput label="Dollars per million input tokens" placeholder="In" value={row.input} onChange={(input) => onChange({ input })} />
      <span>/</span>
      <PriceInput label="Dollars per million output tokens" placeholder="Out" value={row.output} onChange={(output) => onChange({ output })} />
    </span>
  );
}

function PriceInput({ label, placeholder, value, onChange }: { label: string; placeholder: string; value: string; onChange: (value: string) => void }) {
  return (
    <span className="flex h-8 w-[4.75rem] items-center gap-1 rounded-lg border border-pane-border bg-pane-2 px-2 focus-within:border-accent/60">
      <span className="text-pane-muted">$</span>
      <input
        type="text"
        inputMode="decimal"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ""))}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[12.5px] tabular-nums text-pane-fg outline-none placeholder:text-pane-muted"
      />
    </span>
  );
}
