"use client";

import { forwardRef, useCallback, useEffect, useState } from "react";
import {
  Add01Icon,
  AiMagicIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  ArrowUp01Icon,
  Clock01Icon,
  DatabaseIcon,
  FlowIcon,
} from "@hugeicons/core-free-icons";
import type { CollectionSummary } from "@/lib/automations/collections";
import { STARTERS, STARTER_GROUPS, type Starter } from "@/lib/automations/templates";
import type { AiModel } from "@/lib/ai-pricing";
import { presetAbout } from "@/lib/rules/presets";
import { describeAction, describeSchedule, usesAi, type RuleDraft, type RuleRunView, type RuleView } from "@/lib/rules/spec";
import type { Account, Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { MailPanes, usePaneBack } from "../mail/mail-panes";
import { AccentTitle } from "../ui/accent-title";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { Activity, AiDrafts, AutomationBuilder, DescribeRule, GmailChip, request, summary } from "./builder";
import { CollectionView } from "./collection-view";
import type { ComposeDraft } from "@/lib/mail/compose";
import { GuidedBuilder } from "./guided";

// Automations (View kind "automations", the rail): everything Kite does by itself, as automations
// of When → Read → Check → Do (stored as rules, server/rules.ts). The list on the left: yours, your
// collections, Kite's built-in ones and Activity. On the right: the gallery, the guided builder
// every automation is made in (guided.tsx; starters only fill it in), the full builder for
// fine-tuning, a collection, or Activity.

type Pane =
  | { kind: "gallery" }
  | { kind: "guided"; starter: Starter | null; n: number }
  | { kind: "edit"; id: string }
  | { kind: "new"; draft?: RuleDraft; described?: boolean }
  | { kind: "collection"; id: string }
  | { kind: "activity" };

type Label = { accountId: string; name: string };

export const AutomationsView = forwardRef<
  HTMLDivElement,
  {
    live: boolean;
    accounts: Account[];
    /** Demo mode: the sample threads the guided builder reads. */
    demoThreads: Thread[];
    single: boolean;
    width: number | null;
    refreshKey: string;
    onToast: (message: string) => void;
    /** The Screener and notification rules may have changed. */
    onChanged: () => void;
    onOpenConversation: (target: { threadId: string; accountId: string; subject: string }) => void;
    onOpenUsage: () => void;
    /** Opens a ready email in compose (a collection's month for your accountant). */
    onCompose: (draft: ComposeDraft) => void;
  }
>(function AutomationsView({ live, accounts, demoThreads, single, width, refreshKey, onToast, onChanged, onOpenConversation, onOpenUsage, onCompose }, ref) {
  const [rules, setRules] = useState<RuleView[] | null>(null);
  const [collections, setCollections] = useState<CollectionSummary[]>([]);
  const [labels, setLabels] = useState<Label[]>([]);
  const [models, setModels] = useState<AiModel[]>([]);
  const [runs, setRuns] = useState<RuleRunView[]>([]);
  const [pane, setPane] = useState<Pane>({ kind: "gallery" });
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const get = <T,>(url: string) => fetch(url, { signal: controller.signal }).then((r) => r.json() as Promise<T>);
    get<{ rules: RuleView[] }>("/api/rules").then((d) => setRules(d.rules)).catch(() => {});
    get<{ collections: CollectionSummary[] }>("/api/collections").then((d) => setCollections(d.collections ?? [])).catch(() => {});
    get<{ labels: Label[] }>("/api/labels").then((d) => setLabels(d.labels ?? [])).catch(() => {});
    get<{ settings: { models: AiModel[] } | null }>("/api/ai").then((d) => setModels(d.settings?.models ?? [])).catch(() => {});
    get<{ runs: RuleRunView[] }>("/api/rules/activity").then((d) => setRuns(d.runs ?? [])).catch(() => {});
    return () => controller.abort();
  }, [refreshKey]);

  const open = (next: Pane) => {
    setPane(next);
    setShown(true);
  };
  const refreshRuns = useCallback(() => {
    fetch("/api/rules/activity")
      .then((r) => r.json())
      .then((d: { runs: RuleRunView[] }) => setRuns(d.runs))
      .catch(() => {});
  }, []);
  const refreshCollections = useCallback(() => {
    fetch("/api/collections")
      .then((r) => r.json())
      .then((d: { collections: CollectionSummary[] }) => setCollections(d.collections ?? []))
      .catch(() => {});
  }, []);

  /** Applies a server answer with the new list (and lets the app re-read the Screener). */
  const apply = async (call: Promise<{ rules: RuleView[] }>) => {
    try {
      setRules((await call).rules);
      onChanged();
      return true;
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That didn't save. Try again.");
      return false;
    }
  };
  const createCollection = async (name: string) => {
    try {
      const res = await request<{ collection: CollectionSummary; collections: CollectionSummary[] }>("/api/collections", "POST", { name });
      setCollections(res.collections);
      return res.collection;
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That collection couldn't be made.");
      return null;
    }
  };
  const move = (id: string, by: -1 | 1) => {
    if (!rules) return;
    const order = [...rules];
    const at = order.findIndex((r) => r.id === id);
    const to = at + by;
    if (at < 0 || to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    void apply(request("/api/rules", "PUT", { order: order.map((r) => r.id) }));
  };
  const undo = async (ids: string[]) => {
    const inGmail = runs.some((r) => ids.includes(r.id) && r.inGmail);
    try {
      const res = await request<{ undone: number; runs: RuleRunView[] }>("/api/rules/activity", "POST", { undo: ids });
      setRuns(res.runs);
      refreshCollections();
      onToast(
        !res.undone
          ? "Already undone"
          : inGmail
            ? "Undone. Kite leaves those conversations alone now, but Gmail's filter still acts on new mail there."
            : `Undone. That automation leaves ${res.undone === 1 ? "that conversation" : "those conversations"} alone now.`,
      );
    } catch (error) {
      onToast(error instanceof Error ? error.message : "Undo didn't work. Try again.");
    }
  };

  const yours = rules?.filter((r) => !r.preset) ?? [];
  const builtIn = rules?.filter((r) => r.preset) ?? [];
  const editing = pane.kind === "edit" ? rules?.find((r) => r.id === pane.id) : undefined;

  const list = (
    <section className="flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      <header className="flex items-center gap-2 px-4 pb-2 pt-4">
        <h1 className="min-w-0 flex-1 truncate text-[20px] font-medium tracking-[-0.035em]">
          <AccentTitle text="Automations" />
        </h1>
        <button
          onClick={() => open({ kind: "gallery" })}
          className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-[filter] duration-150 hover:brightness-110"
        >
          <Icon icon={Add01Icon} size={13} />
          New
        </button>
      </header>
      {!rules ? (
        <div className="grid flex-1 place-items-center text-pane-muted">
          <Spinner size={18} />
        </div>
      ) : (
        <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          <ListHeading>Yours</ListHeading>
          {yours.length ? (
            <FluidList tone="pane" className="flex flex-col gap-px">
              {yours.map((rule) => (
                <AutomationRow
                  key={rule.id}
                  rule={rule}
                  collections={collections}
                  selected={pane.kind === "edit" && pane.id === rule.id}
                  onOpen={() => open({ kind: "edit", id: rule.id })}
                  onToggle={(enabled) => void apply(request(`/api/rules/${rule.id}`, "PATCH", { enabled }))}
                  onMove={(by) => move(rule.id, by)}
                />
              ))}
            </FluidList>
          ) : (
            <button onClick={() => open({ kind: "gallery" })} className="mx-2 block rounded-xl border border-dashed border-pane-border px-3 py-3 text-left text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
              None yet. Start from a ready-made one or from scratch.
            </button>
          )}

          <ListHeading>Collections</ListHeading>
          <FluidList tone="pane" className="flex flex-col gap-px">
            {collections.map((c) => (
              <ListRow
                key={c.id}
                icon={DatabaseIcon}
                title={c.name}
                detail={c.rows ? `${c.rows} row${c.rows === 1 ? "" : "s"}${c.last ? ` · last ${formatListDate(c.last)}` : ""}` : "Empty"}
                selected={pane.kind === "collection" && pane.id === c.id}
                onClick={() => open({ kind: "collection", id: c.id })}
              />
            ))}
            {!collections.length ? <p className="px-3 text-[12px] text-pane-muted">Lists your automations keep show here.</p> : null}
          </FluidList>

          <ListHeading>Built in</ListHeading>
          <FluidList tone="pane" className="flex flex-col gap-px">
            {builtIn.map((rule) => (
              <AutomationRow
                key={rule.id}
                rule={rule}
                selected={pane.kind === "edit" && pane.id === rule.id}
                onOpen={() => open({ kind: "edit", id: rule.id })}
                onToggle={(enabled) => void apply(request(`/api/rules/${rule.id}`, "PATCH", { enabled }))}
              />
            ))}
          </FluidList>

          <ListHeading>History</ListHeading>
          <FluidList tone="pane" className="flex flex-col gap-px">
            <ListRow icon={Clock01Icon} title="Activity" detail="What ran, with Undo" selected={pane.kind === "activity"} onClick={() => open({ kind: "activity" })} />
          </FluidList>
        </div>
      )}
    </section>
  );

  const detail =
    pane.kind === "gallery" ? (
      <Gallery
        onStart={(starter) => open({ kind: "guided", starter, n: Date.now() })}
        onScratch={() => open({ kind: "guided", starter: null, n: Date.now() })}
        onDescribed={(draft) => open({ kind: "new", draft, described: true })}
        onToast={onToast}
      />
    ) : pane.kind === "guided" ? (
      <WithBack label="Automations">
        <GuidedBuilder
          key={pane.n}
          live={live}
          accounts={accounts}
          demoThreads={demoThreads}
          starter={pane.starter}
          collections={collections}
          onCreateCollection={createCollection}
          onCancel={() => setPane({ kind: "gallery" })}
          onFineTune={(draft) => open({ kind: "new", draft })}
          onSaved={(next, made, collection) => {
            setRules(next);
            onChanged();
            refreshCollections();
            refreshRuns();
            setPane(collection ? { kind: "collection", id: collection } : made ? { kind: "edit", id: made.id } : { kind: "gallery" });
          }}
          onToast={onToast}
        />
      </WithBack>
    ) : pane.kind === "collection" ? (
      <WithBack label="Automations">
        <CollectionView
          key={pane.id}
          id={pane.id}
          refreshKey={refreshKey}
          onOpenConversation={onOpenConversation}
          onCompose={live ? onCompose : undefined}
          onChanged={refreshCollections}
          onDeleted={() => {
            refreshCollections();
            setPane({ kind: "gallery" });
          }}
          onToast={onToast}
        />
      </WithBack>
    ) : pane.kind === "activity" ? (
      <WithBack label="Automations">
        <section className="h-full overflow-y-auto bg-pane px-6 pb-8 pt-5 text-pane-fg">
          <h2 className="text-[24px] font-medium tracking-[-0.035em]">
            <AccentTitle text="Activity" />
          </h2>
          <p className="mt-1 text-[13px] text-pane-muted">The last 30 days. Undo puts the mail back, and that automation leaves those conversations alone from then on.</p>
          {rules?.some((r) => usesAi(r)) ? (
            <div className="mt-4">
              <AiDrafts onToast={onToast} onOpenUsage={onOpenUsage} />
            </div>
          ) : null}
          <Activity runs={runs} onUndo={(ids) => void undo(ids)} />
        </section>
      </WithBack>
    ) : (
      <WithBack label="Automations">
        <section className="h-full overflow-y-auto bg-pane text-pane-fg">
          <div className="mx-auto max-w-[760px]">
            <AutomationBuilder
              key={pane.kind === "edit" ? pane.id : JSON.stringify(pane.draft ?? "blank")}
              rule={editing}
              initial={pane.kind === "new" ? pane.draft : undefined}
              described={pane.kind === "new" && pane.described}
              accounts={accounts}
              labels={labels}
              models={models}
              collections={collections}
              onCreateCollection={createCollection}
              onCancel={() => setPane({ kind: "gallery" })}
              onSave={async (draft) => {
                if (editing) {
                  await apply(request(`/api/rules/${editing.id}`, "PATCH", { rule: draft }));
                } else {
                  const before = new Set(rules?.map((r) => r.id));
                  const res = await request<{ rules: RuleView[] }>("/api/rules", "POST", draft).catch((error: Error) => {
                    onToast(error.message);
                    return null;
                  });
                  if (!res) return;
                  setRules(res.rules);
                  onChanged();
                  const made = res.rules.find((r) => !before.has(r.id));
                  if (made) setPane({ kind: "edit", id: made.id });
                }
                onToast("Saved. It runs on new mail from now on.");
              }}
              onDelete={
                editing && !editing.preset
                  ? async () => {
                      if (await apply(request(`/api/rules/${editing.id}`, "DELETE"))) setPane({ kind: "gallery" });
                    }
                  : undefined
              }
              onRan={(changed) => {
                onToast(changed ? `Done on ${changed} conversation${changed === 1 ? "" : "s"}. Undo it from Activity.` : "Nothing needed changing");
                refreshRuns();
                refreshCollections();
              }}
              onError={onToast}
            />
          </div>
        </section>
      </WithBack>
    );

  return (
    <div ref={ref} className="h-full min-w-0">
      <MailPanes single={single} width={width} showDetail={shown} onBack={() => setShown(false)} list={list} detail={detail} />
    </div>
  );
});

function ListHeading({ children }: { children: React.ReactNode }) {
  return <p className="px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-[0.09em] text-pane-muted">{children}</p>;
}

function ListRow({ icon, title, detail, selected, onClick }: { icon: IconData; title: string; detail: string; selected?: boolean; onClick: () => void }) {
  return (
    <button
      {...FLUID_ITEM}
      onClick={onClick}
      className={cn("relative flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-[background-color] duration-150", selected && "bg-pane-selected")}
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-pane-2 text-pane-muted">
        <Icon icon={icon} size={16} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium">{title}</span>
        <span className="block truncate text-[12px] text-pane-muted">{detail}</span>
      </span>
      <Icon icon={ArrowRight01Icon} size={14} className="shrink-0 text-pane-muted/60" />
    </button>
  );
}

function AutomationRow({
  rule,
  collections = [],
  selected,
  onOpen,
  onToggle,
  onMove,
}: {
  rule: RuleView;
  collections?: CollectionSummary[];
  selected: boolean;
  onOpen: () => void;
  onToggle: (enabled: boolean) => void;
  onMove?: (by: -1 | 1) => void;
}) {
  return (
    <div
      {...FLUID_ITEM}
      onClick={onOpen}
      className={cn("group relative flex cursor-default items-center gap-3 rounded-xl px-3 py-2 transition-[background-color] duration-150", selected && "bg-pane-selected")}
    >
      <span className={cn("grid size-8 shrink-0 place-items-center rounded-[10px]", rule.enabled ? "bg-accent-soft text-accent" : "bg-pane-2 text-pane-muted")}>
        <Icon icon={rule.ai && usesAi(rule) ? AiMagicIcon : FlowIcon} size={16} />
      </span>
      <span className={cn("min-w-0 flex-1", !rule.enabled && "opacity-60")}>
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13.5px] font-medium">{rule.name}</span>
          {rule.gmail && rule.enabled ? <GmailChip states={rule.gmailFilters ?? []} /> : null}
        </span>
        <span className="block truncate text-[12px] text-pane-muted">{rule.preset ? presetAbout(rule.preset) : summary(rule, collections)}</span>
      </span>
      {onMove ? (
        <span {...FLUID_IGNORE} className="hidden shrink-0 flex-col group-hover:flex" onClick={(e) => e.stopPropagation()}>
          <Tooltip label="Run earlier" side="left">
            <button aria-label={`Move ${rule.name} up`} onClick={() => onMove(-1)} className="grid size-5 place-items-center rounded-full text-pane-muted hover:bg-pane-2 hover:text-pane-fg">
              <Icon icon={ArrowUp01Icon} size={12} />
            </button>
          </Tooltip>
          <Tooltip label="Run later" side="left">
            <button aria-label={`Move ${rule.name} down`} onClick={() => onMove(1)} className="grid size-5 place-items-center rounded-full text-pane-muted hover:bg-pane-2 hover:text-pane-fg">
              <Icon icon={ArrowDown01Icon} size={12} />
            </button>
          </Tooltip>
        </span>
      ) : null}
      <span {...FLUID_IGNORE} onClick={(e) => e.stopPropagation()} className="shrink-0">
        <Switch value={rule.enabled} size="sm" label={rule.enabled ? `Pause ${rule.name}` : `Switch on ${rule.name}`} onChange={onToggle} />
      </span>
    </div>
  );
}

/** With one pane at a time, a Back bar above the detail. */
function WithBack({ label, children }: { label: string; children: React.ReactNode }) {
  const back = usePaneBack();
  if (!back) return <>{children}</>;
  return (
    <div className="flex h-full flex-col bg-pane">
      <button onClick={back} className="flex h-10 shrink-0 items-center gap-1.5 px-4 text-[13px] text-pane-muted hover:text-pane-fg">
        <Icon icon={ArrowRight01Icon} size={14} className="rotate-180" />
        {label}
      </button>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}

/** What a starter does, on its card: when it runs, what it reads, what happens. */
function Flow({ starter }: { starter: Starter }) {
  const reads = [...(starter.fields ?? []).map((f) => f.name), ...starter.wants];
  const steps = [
    ...(starter.when === "schedule" && starter.schedule ? [{ label: "When", text: describeSchedule(starter.schedule) }] : starter.when === "sent" ? [{ label: "When", text: "You send one" }] : []),
    ...(reads.length ? [{ label: "Read", text: reads.join(", ") }] : []),
    {
      label: "Do",
      text: starter.actions
        .map((action) => (action.verb === "collect" ? `keep a list` : describeAction(action).replace(/\{([a-z_]+)\}/g, (_m, key: string) => key.replace(/_/g, " "))))
        .join(" · "),
    },
  ];
  return (
    <ol className="mt-3 flex flex-col gap-1.5">
      {steps.map((s) => (
        <li key={s.label} className="flex min-w-0 items-baseline gap-2 text-[12px]">
          <span className="w-9 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent">{s.label}</span>
          <span className="min-w-0 truncate text-pane-muted">{s.text}</span>
        </li>
      ))}
    </ol>
  );
}

function Gallery({ onStart, onScratch, onDescribed, onToast }: { onStart: (starter: Starter) => void; onScratch: () => void; onDescribed: (draft: RuleDraft) => void; onToast: (message: string) => void }) {
  let n = 0;
  return (
    <section className="@container h-full overflow-y-auto bg-pane text-pane-fg">
      <div className="mx-auto max-w-[880px] px-6 pb-10 pt-8">
        <h2 className="text-[30px] font-medium leading-tight tracking-[-0.04em]">
          Let Kite do it <span className="font-accent text-[1.1em]">for you</span>
        </h2>
        <p className="mt-2 max-w-[600px] text-[14px] leading-relaxed text-pane-muted">
          Pick whose emails, click what to read in one of them, and choose what happens: keep a list, wait for an answer and nudge, ask on a schedule, send your accountant the month, bring it
          back before a date, file it. Every automation is built the same way. Start from one of these or from scratch.
        </p>
        <div className="mt-4">
          <DescribeRule onDraft={onDescribed} onError={onToast} />
        </div>

        {STARTER_GROUPS.map((group) => (
          <div key={group.id} className="mt-7">
            <h3 className="mb-2.5 px-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">{group.name}</h3>
            <FluidList tone="pane" axis="xy" className="grid grid-cols-[minmax(0,1fr)] gap-3 @min-[560px]:grid-cols-[repeat(2,minmax(0,1fr))] @min-[900px]:grid-cols-[repeat(3,minmax(0,1fr))]">
              {STARTERS.filter((s) => s.group === group.id).map((starter) => (
                <button
                  key={starter.id}
                  {...FLUID_ITEM}
                  onClick={() => onStart(starter)}
                  style={{ "--i": n++ } as React.CSSProperties}
                  className="blur-fade-up relative flex min-w-0 flex-col rounded-2xl border border-pane-border p-4 text-left transition-[background-color,border-color] duration-150 data-[lit]:border-pane-muted/40 data-[lit]:bg-pane-hover"
                >
                  <span className="text-[15px] font-semibold tracking-tight">{starter.name}</span>
                  <span className="mt-1 text-[12.5px] leading-snug text-pane-muted">{starter.about}</span>
                  <Flow starter={starter} />
                </button>
              ))}
            </FluidList>
          </div>
        ))}
        <FluidList tone="pane" axis="xy" className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-3">
          <button
            {...FLUID_ITEM}
            onClick={onScratch}
            style={{ "--i": n } as React.CSSProperties}
            className="blur-fade-up relative flex min-h-28 min-w-0 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-pane-border p-4 text-center transition-[background-color] duration-150 data-[lit]:bg-pane-hover"
          >
            <span className="grid size-9 place-items-center rounded-full bg-pane-2 text-pane-muted">
              <Icon icon={Add01Icon} size={16} />
            </span>
            <span className="text-[14px] font-semibold tracking-tight">Start from scratch</span>
            <span className="text-[12px] text-pane-muted">Any emails, any values, anything to do</span>
          </button>
        </FluidList>
        <p className="mt-6 text-[12px] text-pane-muted">Reading happens on your computer with plain rules. AI is only used where you switch on Allow AI.</p>
      </div>
    </section>
  );
}
