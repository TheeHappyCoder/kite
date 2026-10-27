"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { format } from "date-fns";
import { Add01Icon, AiMagicIcon, ArrowDown01Icon, Cancel01Icon, Clock01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { accountName, type Account } from "@/lib/mail/types";
import type { AiModel } from "@/lib/ai-pricing";
import { blurFade } from "@/lib/motion";
import { gmailFilterFor, type GmailFilterState } from "@/lib/rules/gmail";
import { MESSAGE_BLANKS, blanksIn, fillBlanks } from "@/lib/rules/prepared";
import type { FieldCheck, FieldSpec, FieldValues } from "@/lib/automations/fields";
import type { CollectionSummary } from "@/lib/automations/collections";
import { newCollectionName } from "@/lib/automations/templates";
import { bodyToText } from "@/lib/mail/body";
import {
  NOTIFY_MODES,
  NUDGES,
  RuleDraftSchema,
  SENDER_STATUSES,
  TRIGGER_NAMES,
  TRIGGER_VERBS,
  VERBS,
  defaultAction,
  describeSchedule,
  describeAction,
  describeCondition,
  referenceProblem,
  usesAi,
  type Condition,
  type RuleAction,
  type RuleDraft,
  type RuleRunView,
  type RuleView,
  type Schedule,
  type SnoozeFor,
  type Trigger,
} from "@/lib/rules/spec";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { AccountFace } from "../mail/account-face";
import { TimePicker } from "../ui/date-time-picker";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { FormatBar, RichEditor, type FormatState, type RichEditorHandle } from "../mail/rich-editor";
import { Thinking } from "../ui/thinking";
import { Spinner } from "../ui/spinner";
import { ChecksEditor, FieldsEditor } from "./read-step";
import { Segmented } from "../settings/settings-ui";

// The automation builder and its companions (Describe an automation, AI drafts, Activity), used by
// the Automations view (automations-view.tsx). An automation is When → Read → Check → Do
// (lib/rules/spec.ts); Kite runs them top to bottom on new mail, and on existing mail only when
// "Run on existing mail" is pressed.

export const buttonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors hover:bg-pane-hover disabled:opacity-40";
const inputClass = "h-8 min-w-0 rounded-full border border-pane-border bg-transparent px-3 text-[12.5px] outline-none placeholder:text-pane-muted focus:border-accent/60";

type Blank = { key: string; label: string };

/** What the builder shows under the steps: how many conversations would have matched, and what Read found. */
type Preview = { key: string; count: number; capped: boolean; subjects: string[]; screensNew: boolean; samples: { subject: string; values: FieldValues }[]; next: string | null };
type Label = { accountId: string; name: string };

export async function request<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't work. Try again.");
  return data as T;
}

/** One line: "from:shop.co, Sender is new to you → Archive, Add label Receipts". */
export function summary(rule: RuleView, collections: CollectionSummary[] = []) {
  const ifs = [rule.query, ...rule.conditions.map((c) => describeCondition(c, rule.when))].filter(Boolean);
  const when =
    rule.when === "schedule" && rule.schedule
      ? `${describeSchedule(rule.schedule)}${ifs.length ? `, ${ifs.join(", ")}` : ""}`
      : rule.when === "sent"
        ? `Mail I send${ifs.length ? `: ${ifs.join(", ")}` : ""}`
        : `${ifs.length ? ifs.join(", ") : "Any new mail"}${rule.delay ? `, after ${waitText(rule.delay)}` : ""}`;
  // Field keys read as their names ("due date"), collections by name.
  const named = (text: string) => text.replace(/\{([a-z][a-z0-9_]*)\}/g, (whole, key: string) => rule.fields.find((f) => f.key === key)?.name.toLowerCase() ?? (key === "received" ? "arrival" : whole));
  const actions = rule.actions.map((a) =>
    a.verb === "collect" ? `Add to ${collections.find((c) => c.id === a.collection)?.name ?? "a collection"}` : named(describeAction(a)),
  );
  return `${when} → ${actions.join(", ")}${rule.stop ? ", then stop" : ""}`;
}

const DESCRIBE_STEPS = ["Reading what you want", "Writing the automation", "Checking it"];

/** "Describe an automation": one sentence in, an automation out, opened in the builder for you to check and save. Sends no mail. */
export function DescribeRule({ onDraft, onError }: { onDraft: (draft: RuleDraft) => void; onError: (message: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      const res = await request<{ draft: RuleDraft }>("/api/rules/design", "POST", { description: text });
      setText("");
      onDraft(res.draft);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Couldn't draft that automation");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-8 min-w-0 flex-1 basis-64 items-center gap-1.5 rounded-full border border-pane-border pl-3 pr-1 focus-within:border-accent/60">
      {busy ? (
        <Thinking steps={DESCRIBE_STEPS} className="min-w-0 flex-1 text-[12.5px] text-pane-fg" />
      ) : (
        <>
          <Icon icon={AiMagicIcon} size={14} className="shrink-0 text-accent" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            maxLength={500}
            placeholder="Describe one: “label receipts from Takealot and archive them”"
            aria-label="Describe an automation for your AI to draft"
            className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-pane-muted"
          />
          {text.trim().length >= 3 ? (
            <button onClick={() => void submit()} className="blur-fade h-6 shrink-0 rounded-full bg-accent px-2.5 text-[11.5px] font-medium text-accent-fg">
              Draft
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

type AiDraftsView = {
  on: boolean;
  model: string | null;
  configured: boolean;
  pausedReason: string | null;
  retryAt: string | null;
  waiting: number;
  recent: { id: string; ruleName: string; subject: string; status: "queued" | "done" | "failed" | "skipped" | "cancelled"; reason: string | null; at: string }[];
};

const JOB_WORDS = { queued: "waiting", done: "drafted", failed: "failed", skipped: "skipped", cancelled: "called off" } as const;

/** Rules' "Draft with AI": the one switch for all of it, Resume after errors, and the latest jobs. What it uses is on the AI page. */
export function AiDrafts({ onToast, onOpenUsage }: { onToast: (message: string) => void; onOpenUsage: () => void }) {
  const [view, setView] = useState<AiDraftsView | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ai/drafts", { signal: controller.signal })
      .then((r) => r.json() as Promise<AiDraftsView>)
      .then(setView)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!view) return null;

  const save = async (body: { on?: boolean; resume?: boolean }) => {
    try {
      setView(await request<AiDraftsView>("/api/ai/drafts", "POST", body));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That didn't save. Try again.");
    }
  };

  return (
    <div className="blur-fade-up flex flex-col gap-3 rounded-xl border border-pane-border p-4">
      <label className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-start gap-2.5">
          <Icon icon={AiMagicIcon} size={16} className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">Draft with AI</span>
            <span className="block text-[11.5px] text-pane-muted">
              {view.configured
                ? `Automations with “Allow AI” send the new email’s text to ${view.model ?? "your AI"} and leave a draft in the quick reply. Nothing is sent by itself.`
                : "Connect an AI (sidebar → AI) for these automations to draft replies."}
            </span>
          </span>
        </span>
        <Switch value={view.on} label={view.on ? "Pause all AI drafts" : "Switch AI drafts on"} onChange={(on) => void save({ on })} />
      </label>

      <AnimatePresence initial={false}>
        {view.pausedReason ? (
          <motion.div key="paused" {...blurFade({ y: -4 })} className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1">Paused after three errors in a row: {view.pausedReason}</span>
            <button onClick={() => void save({ resume: true })} className="h-7 rounded-full bg-pane-fg px-3 text-[12px] font-medium text-pane">
              Resume
            </button>
          </motion.div>
        ) : view.retryAt ? (
          <motion.p key="retry" {...blurFade({ y: -4 })} className="rounded-lg bg-pane-2 px-3 py-2 text-[12px] text-pane-muted">
            The last request failed. Trying again after {format(new Date(view.retryAt), "HH:mm")}.
          </motion.p>
        ) : null}
      </AnimatePresence>

      <p className="text-[11.5px] text-pane-muted">
        Automation drafts count against your AI limits in{" "}
        <button onClick={onOpenUsage} className="font-medium text-pane-fg underline decoration-pane-border underline-offset-2 hover:decoration-current">
          Settings → AI
        </button>
        . Requests are spaced out; errors wait and retry, and three in a row pause everything.
        {view.waiting ? ` ${view.waiting} waiting.` : ""}
      </p>

      {view.recent.length ? (
        <ul className="flex flex-col gap-1 border-t border-pane-border pt-2.5">
          {view.recent.map((job) => (
            <li key={job.id} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="shrink-0 tabular-nums text-pane-muted">{format(new Date(job.at), "d MMM HH:mm")}</span>
              <span data-sensitive className="min-w-0 flex-1 truncate">
                {job.subject} <span className="text-pane-muted">· {job.ruleName}</span>
              </span>
              <span className={cn("shrink-0", job.status === "failed" ? "text-warning" : "text-pane-muted")}>
                {JOB_WORDS[job.status]}
                {job.reason && job.status !== "done" ? `: ${job.reason}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type Draft = {
  name: string;
  enabled: boolean;
  when: Trigger;
  schedule: Schedule | null;
  delay: number;
  query: string;
  conditions: Condition[];
  fields: FieldSpec[];
  checks: FieldCheck[];
  actions: RuleAction[];
  stop: boolean;
  accounts: string[];
  gmail: boolean;
  ai: boolean;
  aiModel: string | null;
};

const conditionKey = (c: Condition) => (c.kind === "sender" ? `sender:${c.status}` : c.kind);

function conditionFrom(key: string, negate: boolean): Condition {
  const at = key.indexOf(":");
  const kind = at < 0 ? key : key.slice(0, at);
  const value = key.slice(at + 1);
  if (kind === "sender") return { kind: "sender", status: value as (typeof SENDER_STATUSES)[number], negate };
  return { kind: kind as "vip" | "muted", negate };
}

const verbOptions = (trigger: Trigger) => TRIGGER_VERBS[trigger].map((v) => ({ value: v, label: VERBS[v].label }));

export function AutomationBuilder({
  rule,
  initial,
  described,
  accounts,
  labels,
  models,
  collections,
  onCreateCollection,
  onSave,
  onCancel,
  onDelete,
  onRan,
  onError,
}: {
  rule?: RuleView;
  /** A new automation's starting point (a starter, or "Describe an automation"). */
  initial?: RuleDraft;
  /** `initial` was written by your AI. */
  described?: boolean;
  accounts: Account[];
  labels: Label[];
  /** The connected AI models, the default first. */
  models: AiModel[];
  collections: CollectionSummary[];
  /** Makes a collection from "Add to a collection" (null: it didn't work, already explained). */
  onCreateCollection: (name: string) => Promise<CollectionSummary | null>;
  onSave: (draft: RuleDraft) => Promise<void>;
  onCancel: () => void;
  onDelete?: () => Promise<void>;
  onRan?: (changed: number) => void;
  onError: (message: string) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    const from = rule ?? (initial ? RuleDraftSchema.parse(initial) : undefined);
    return {
      name: from?.name ?? "",
      enabled: from?.enabled ?? true,
      when: from?.when ?? "new_mail",
      schedule: from?.schedule ?? null,
      delay: from?.delay ?? 0,
      query: from?.query ?? "",
      conditions: from?.conditions ?? [],
      fields: from?.fields ?? [],
      checks: from?.checks ?? [],
      actions: from?.actions ?? [{ verb: "archive" }],
      stop: from?.stop ?? false,
      accounts: from?.accounts ?? [],
      gmail: from?.gmail ?? false,
      ai: from?.ai ?? false,
      aiModel: from?.aiModel ?? null,
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"delete" | "run" | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const queryRef = useRef<HTMLInputElement>(null);
  const patch = (p: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...p }));
    setError(null);
  };
  const parsed = useMemo(() => RuleDraftSchema.safeParse(draft), [draft]);
  /** A new trigger keeps the steps it can run, and starts a schedule on the 1st at 09:00. */
  const setTrigger = (when: Trigger) => {
    const kept = draft.actions.filter((a) => TRIGGER_VERBS[when].includes(a.verb));
    patch({
      when,
      schedule: when === "schedule" ? (draft.schedule ?? { every: "month", day: 1, time: "09:00" }) : null,
      delay: when === "new_mail" ? draft.delay : 0,
      query: when === "schedule" ? "" : draft.query,
      fields: when === "schedule" ? [] : draft.fields,
      checks: when === "schedule" ? [] : draft.checks,
      conditions: when === "schedule" ? draft.conditions.filter((c) => c.kind === "senders") : draft.conditions,
      actions: kept.length ? kept : [defaultAction(when === "new_mail" ? "archive" : "expect")],
      gmail: when === "new_mail" && draft.gmail,
    });
  };
  // Only what decides the matches and what's read: the count isn't asked again for a new name or action.
  const previewKey = JSON.stringify([draft.query, draft.conditions, draft.accounts, draft.fields, draft.checks, draft.when, draft.schedule]);
  const queryError = parsed.success ? null : parsed.error.issues.find((i) => i.path[0] === "query")?.message ?? null;

  useEffect(() => {
    if (queryError) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const [query, conditions, scope, fields, checks, when, schedule] = JSON.parse(previewKey) as [string, Condition[], string[], FieldSpec[], FieldCheck[], Trigger, Schedule | null];
      request<Omit<Preview, "key">>("/api/rules/preview", "POST", {
        name: "Preview",
        when,
        schedule,
        query,
        conditions,
        accounts: scope,
        // Fields still being written (no words yet) aren't sent until they're whole.
        fields: fields.filter((f) => (f.from.kind !== "after" || f.from.label.trim()) && (f.from.kind !== "pattern" || f.from.pattern)),
        checks: checks.filter((c) => fields.some((f) => f.key === c.field)),
        actions: [{ verb: "notify", mode: "silent" }],
      })
        .then((res) => !controller.signal.aborted && setPreview({ key: previewKey, ...res }))
        .catch(() => {});
    }, 350);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [previewKey, queryError]);

  const conditionOptions = [
    { value: "vip", label: draft.when === "sent" ? "They're a VIP" : "Sender is a VIP" },
    ...SENDER_STATUSES.map((s) => ({ value: `sender:${s}`, label: describeCondition({ kind: "sender", status: s, negate: false }) })),
    { value: "muted", label: "Conversation is muted" },
  ];
  const blanks: Blank[] = [...MESSAGE_BLANKS, ...draft.fields.map((f) => ({ key: f.key, label: f.name }))];
  const preparesReply = draft.actions.some((a) => a.verb === "prepare_reply");
  const labelNames = [...new Set(labels.filter((l) => !draft.accounts.length || draft.accounts.includes(l.accountId)).map((l) => l.name))].sort();
  const current = preview?.key === previewKey ? preview : null;
  const gmailCheck = gmailFilterFor(draft);
  const gmailAccounts = accounts.filter((a) => a.provider === "gmail" && (!draft.accounts.length || draft.accounts.includes(a.id)));

  const save = async () => {
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the automation");
    if (draft.actions.some((a) => (a.verb === "label" || a.verb === "unlabel") && !a.label.trim())) return setError("Pick a label");
    if (usesAi(draft) && !draft.ai) return setError("Turn on “Allow AI” to let this automation draft with AI, or remove that action.");
    const problem = referenceProblem(draft);
    if (problem) return setError(problem);
    if (draft.actions.some((a) => a.verb === "collect" && !a.collection)) return setError("Pick a collection to add to");
    setBusy(true);
    try {
      // A starter's collection ("new:Bills") is made now: one that already has the name is used instead.
      const actions: RuleAction[] = [];
      for (const a of draft.actions) {
        const name = a.verb === "collect" ? newCollectionName(a.collection) : null;
        if (a.verb !== "collect" || !name) {
          actions.push(a);
          continue;
        }
        const existing = collections.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? (await onCreateCollection(name));
        if (!existing) return;
        actions.push({ ...a, collection: existing.id });
      }
      // A rule edited into something Gmail can't express stops running there.
      const ai = draft.ai && usesAi(draft);
      await onSave({ ...draft, actions, gmail: draft.gmail && gmailCheck.ok, ai, aiModel: ai ? draft.aiModel : null });
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!rule) return;
    setBusy(true);
    setConfirm(null);
    try {
      const res = await request<{ changed: number; problems?: string[] }>(`/api/rules/${rule.id}`, "POST", {});
      if (res.problems?.length) onError(res.problems[0]);
      onRan?.(res.changed);
    } catch (e) {
      onError(e instanceof Error ? e.message : "That didn't work. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const insert = (term: string) => {
    const q = draft.query.trimEnd();
    patch({ query: q ? `${q} ${term}` : term });
    requestAnimationFrame(() => {
      const el = queryRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  };
  // Options start folded unless one is already on.
  const [moreOpen, setMoreOpen] = useState(() => draft.stop || draft.gmail);
  const optionCount = [draft.stop, draft.gmail && gmailCheck.ok].filter(Boolean).length;

  return (
    <div className="blur-fade-up flex min-w-0 flex-col gap-5 p-4 sm:p-5">
      <div className="flex flex-col gap-1">
        {described ? (
          <p className="flex items-center gap-1.5 text-[12px] text-pane-muted">
            <Icon icon={AiMagicIcon} size={13} className="shrink-0 text-accent" />
            Drafted by your AI from your description. Check it, then Save; nothing runs until you do.
          </p>
        ) : null}
        <input
          autoFocus={!rule}
          value={draft.name}
          onChange={(e) => patch({ name: e.target.value })}
          placeholder="Name this automation"
          aria-label="Automation name"
          className="-mx-1 h-9 w-full min-w-0 rounded-lg bg-transparent px-1 text-[16px] font-semibold tracking-tight outline-none placeholder:text-pane-muted/70 focus:bg-pane-2"
        />
      </div>

      <div className="flex flex-col">
        <Step n={1} title={draft.when === "schedule" ? "When it runs" : draft.when === "sent" ? "When you send mail" : "When new mail arrives"} note={TRIGGER_NOTES[draft.when]}>
          <Segmented label="What starts it" value={draft.when} options={TRIGGER_OPTIONS} onChange={setTrigger} />
          {accounts.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[12px] text-pane-muted">{draft.when === "schedule" ? "Send from" : "In"}</span>
              {draft.when === "schedule" ? null : (
                <AccountChip on={!draft.accounts.length} onClick={() => patch({ accounts: [] })}>
                  All accounts
                </AccountChip>
              )}
              {accounts.map((a) => (
                <AccountChip
                  key={a.id}
                  on={draft.when === "schedule" ? (draft.accounts[0] ?? accounts[0]?.id) === a.id : draft.accounts.includes(a.id)}
                  account={a}
                  onClick={() =>
                    patch({
                      accounts: draft.when === "schedule" ? [a.id] : draft.accounts.includes(a.id) ? draft.accounts.filter((x) => x !== a.id) : [...draft.accounts, a.id],
                    })
                  }
                >
                  {accounts.filter((x) => accountName(x) === accountName(a)).length > 1 ? a.email : accountName(a)}
                </AccountChip>
              ))}
            </div>
          ) : null}
          {draft.when === "schedule" ? (
            <>
              <ScheduleEditor value={draft.schedule ?? { every: "month", day: 1, time: "09:00" }} onChange={(schedule) => patch({ schedule })} />
              <PeopleEditor
                emails={draft.conditions.flatMap((c) => (c.kind === "senders" && !c.negate ? c.emails : []))}
                onChange={(emails) => patch({ conditions: emails.length ? [{ kind: "senders", emails, negate: false }] : [] })}
              />
            </>
          ) : (
            <>
            <div className="flex flex-col gap-2">
              <input
                ref={queryRef}
                value={draft.query}
                onChange={(e) => patch({ query: e.target.value })}
                placeholder="Any mail, or narrow it: from:shop.co subject:receipt"
                aria-label="Search to match"
                spellCheck={false}
                className={cn(inputClass, "h-9 w-full tabular-nums", queryError && "border-warning/60")}
              />
              {queryError ? (
                <p className="px-1 text-[11.5px] text-warning">{queryError}</p>
              ) : (
                <div className="flex flex-wrap items-center gap-1">
                  {QUERY_HINTS.map((hint) => (
                    <Tooltip key={hint.term} label={hint.about}>
                      <button
                        onClick={() => insert(hint.term)}
                        className="h-6 rounded-full bg-pane-2 px-2 tabular-nums text-[11px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
                      >
                        {hint.term}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              )}
            </div>
            {draft.conditions.length ? (
              <div className="flex flex-col gap-1.5">
                {draft.conditions.map((c, i) =>
                  c.kind === "senders" ? (
                    <div key={i} className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="text-[12px] text-pane-muted">{draft.when === "sent" ? (c.negate ? "Not to" : "To") : c.negate ? "Not from" : "From"}</span>
                      {c.emails.map((email) => (
                        <span key={email} data-sensitive className="flex h-7 items-center gap-1 rounded-full bg-accent-soft pl-2.5 pr-1.5 text-[12px] font-medium text-accent">
                          {email}
                          {c.emails.length > 1 ? (
                            <button
                              aria-label={`Remove ${email}`}
                              onClick={() => patch({ conditions: draft.conditions.map((x, j) => (j === i && x.kind === "senders" ? { ...x, emails: x.emails.filter((e) => e !== email) } : x)) })}
                              className="grid size-4 place-items-center rounded-full hover:bg-accent/15"
                            >
                              <Icon icon={Cancel01Icon} size={9} />
                            </button>
                          ) : null}
                        </span>
                      ))}
                      <RemoveButton label="Remove these senders" onClick={() => patch({ conditions: draft.conditions.filter((_, j) => j !== i) })} />
                    </div>
                  ) : (
                  <div key={i} className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Select
                      label="And or but not"
                      value={c.negate ? "not" : "is"}
                      options={[
                        { value: "is", label: "And" },
                        { value: "not", label: "But not" },
                      ]}
                      onChange={(v) => patch({ conditions: draft.conditions.map((x, j) => (j === i ? { ...x, negate: v === "not" } : x)) })}
                    />
                    <Select
                      label="Condition"
                      value={conditionKey(c)}
                      options={conditionOptions}
                      onChange={(v) => patch({ conditions: draft.conditions.map((x, j) => (j === i ? conditionFrom(v, x.negate) : x)) })}
                    />
                    <RemoveButton label="Remove this condition" onClick={() => patch({ conditions: draft.conditions.filter((_, j) => j !== i) })} />
                  </div>
                  ),
                )}
              </div>
            ) : null}
            {draft.conditions.length < 8 ? (
              <AddButton onClick={() => patch({ conditions: [...draft.conditions, { kind: "vip", negate: false }] })}>Add a condition</AddButton>
            ) : null}
            </>
          )}
          {draft.when === "new_mail" ? (
            <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-pane-muted">
              <Icon icon={Clock01Icon} size={13} />
              <Select label="When to act" value={String(draft.delay)} options={WAIT_OPTIONS} onChange={(v) => patch({ delay: Number(v) })} />
              {draft.delay ? <span>Notify still tells you straight away.</span> : null}
            </div>
          ) : null}
        </Step>

        {draft.when === "schedule" ? null : (
          <>
            <Step n={2} title="Read from the email" note={draft.when === "sent" ? "Optional. Values from what you sent; “their name” is who it went to." : "Optional. Pull values out so the steps below can use them as {blanks}."}>
              <FieldsEditor
                fields={draft.fields}
                sent={draft.when === "sent"}
                sample={current ? (current.samples[0]?.values ?? (current.count ? {} : null)) : undefined}
                onChange={(fields) => patch({ fields, checks: draft.checks.filter((c) => fields.some((f) => f.key === c.field)) })}
              />
            </Step>

            <Step n={3} title="Only go on if" note="Optional. Check what was read.">
              <ChecksEditor checks={draft.checks} fields={draft.fields} onChange={(checks) => patch({ checks })} />
            </Step>
          </>
        )}

        <Step n={draft.when === "schedule" ? 2 : 4} title="Do" last>
          <datalist id="rule-labels">
            {labelNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
          {draft.actions.map((a, i) => (
            <ActionRow
              key={i}
              trigger={draft.when}
              action={a}
              blanks={blanks}
              fields={draft.fields}
              collections={collections}
              onCreateCollection={onCreateCollection}
              sampleSubject={current?.subjects[0]}
              onChange={(next) => patch({ actions: draft.actions.map((x, j) => (j === i ? next : x)) })}
              onRemove={draft.actions.length > 1 ? () => patch({ actions: draft.actions.filter((_, j) => j !== i) }) : undefined}
            />
          ))}
          {draft.actions.length < 8 ? (
            <AddButton onClick={() => patch({ actions: [...draft.actions, defaultAction(TRIGGER_VERBS[draft.when].find((v) => !draft.actions.some((a) => a.verb === v)) ?? TRIGGER_VERBS[draft.when][0])] })}>
              Add an action
            </AddButton>
          ) : null}
          {usesAi(draft) ? (
            <div className="blur-fade flex flex-col gap-2.5 rounded-lg bg-accent-soft/60 px-3 py-2.5">
              <label className="flex items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="flex items-center gap-1.5 text-[12.5px] font-medium">
                    <Icon icon={AiMagicIcon} size={13} className="text-accent" />
                    Allow AI
                  </span>
                  <span className="block text-[11.5px] text-pane-muted">
                    Sends only the new email&apos;s text (no quotes, no addresses) to your AI, within your AI limits. The draft waits in the quick reply and is never sent
                    by itself.
                  </span>
                </span>
                <Switch value={draft.ai} label="Allow AI" size="sm" onChange={(ai) => patch({ ai })} />
              </label>
              {draft.ai && models.length > 1 ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[12px] text-pane-muted">Model for this automation</span>
                  <Select
                    label="Model for this automation"
                    value={models.some((m) => m.id === draft.aiModel) ? draft.aiModel! : ""}
                    options={[{ value: "", label: "Automation drafts model" }, ...models.map((m) => ({ value: m.id, label: m.name }))]}
                    onChange={(aiModel) => patch({ aiModel: aiModel || null })}
                  />
                </div>
              ) : null}
            </div>
          ) : null}
        </Step>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        <motion.div
          key={current ? `${current.count}` : "counting"}
          {...blurFade({ y: 3, blur: 3 })}
          className="flex items-start gap-2.5 rounded-xl border border-pane-border bg-pane-2/60 px-3.5 py-3 text-[12px] leading-snug"
        >
          <Icon icon={Search01Icon} size={14} className="mt-px shrink-0 text-pane-muted" />
          <div className="min-w-0 flex-1">
            {draft.when === "schedule" ? (
              <span className="font-medium">
                {draft.schedule ? describeSchedule(draft.schedule) : "Pick when it runs"}
                {current?.next ? `. Next: ${format(new Date(current.next), "EEE d MMM, HH:mm")}` : ""}
                {draft.actions.some((a) => a.verb === "expect") ? ` · ${current?.count ?? 0} ${current?.count === 1 ? "person" : "people"}` : ""}
              </span>
            ) : queryError ? (
              <span className="text-pane-muted">Fix the search to see what it would match.</span>
            ) : !current ? (
              <span className="flex items-center gap-2 text-pane-muted">
                <Spinner size={12} />
                Counting…
              </span>
            ) : (
              <>
                <span className="font-medium">
                  {current.count === 2000 ? "2,000+" : current.count}
                  {current.capped ? "+" : ""} conversation{current.count === 1 ? "" : "s"} in the last 30 days would have matched{draft.when === "sent" ? " (mail you sent)" : ""}
                </span>
                {current.subjects.length ? (
                  <span data-sensitive className="mt-1 block truncate text-pane-muted">
                    {current.subjects.join(" · ")}
                  </span>
                ) : null}
                {current.screensNew ? <span className="mt-1 block text-pane-muted">New senders only count from now on: everyone already here is known.</span> : null}
              </>
            )}
          </div>
        </motion.div>
      </AnimatePresence>

      <div className="flex flex-col gap-2">
        <button
          onClick={() => setMoreOpen((o) => !o)}
          aria-expanded={moreOpen}
          className="flex items-center gap-1.5 self-start text-[12px] font-medium text-pane-muted transition-colors hover:text-pane-fg"
        >
          <Icon icon={ArrowDown01Icon} size={13} className={cn("transition-transform duration-150", !moreOpen && "-rotate-90")} />
          More options
          {optionCount && !moreOpen ? <span className="rounded-full bg-accent-soft px-1.5 text-[10.5px] text-accent">{optionCount} on</span> : null}
        </button>
        <AnimatePresence initial={false}>
          {moreOpen ? (
            <motion.div {...blurFade({ y: -4 })} className="flex flex-col divide-y divide-pane-border rounded-xl border border-pane-border">
              <label className="flex items-center justify-between gap-3 px-3.5 py-3">
                <span className="min-w-0">
                  <span className="block text-[12.5px] font-medium">Stop here</span>
                  <span className="block text-[11.5px] text-pane-muted">Automations below don&apos;t run on mail this one matched.</span>
                </span>
                <Switch value={draft.stop} label="Stop here" size="sm" onChange={(stop) => patch({ stop })} />
              </label>
              {gmailAccounts.length ? (
                <div className="px-3.5 py-3">
                  <GmailOption
                    on={draft.gmail && gmailCheck.ok}
                    reason={gmailCheck.ok ? null : gmailCheck.reason}
                    saved={rule?.gmail && draft.gmail && gmailCheck.ok ? rule : undefined}
                    accounts={gmailAccounts}
                    onChange={(gmail) => patch({ gmail })}
                  />
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-pane-border pt-4">
        <p className={cn("min-w-0 flex-1 basis-40 text-[12px]", error ? "text-warning" : "text-pane-muted")}>
          {error ??
            (draft.when === "schedule"
              ? `Runs on its day from when you save.${draft.actions.some((a) => (a.verb === "expect" || a.verb === "pack") && a.auto) ? " Sends by itself, as you switched on." : " Anything it writes waits for you to send."}`
              : `${rule ? `Runs on ${draft.when === "sent" ? "mail you send" : "new mail"}. Existing mail is left as it is.` : `Runs on ${draft.when === "sent" ? "mail you send" : "new mail"} from when you save.`}${preparesReply ? " Replies are prepared for new mail only and never sent by themselves." : ""}`)}
        </p>
        <AnimatePresence mode="popLayout" initial={false}>
          {confirm ? (
            <motion.div key="confirm" {...blurFade({ x: 6, blur: 4 })} className="flex items-center gap-1.5">
              <span className="text-[12px] text-pane-muted">
                {confirm === "delete"
                  ? "Delete this automation?"
                  : draft.when === "schedule"
                    ? "Run it now for this period?"
                    : `Apply to ${current?.count ?? "these"} conversations? You can undo it.`}
              </span>
              <button onClick={() => setConfirm(null)} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
                Cancel
              </button>
              <button onClick={() => (confirm === "delete" ? void onDelete?.() : void run())} className="h-8 rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane">
                {confirm === "delete" ? "Delete" : "Run"}
              </button>
            </motion.div>
          ) : (
            <motion.div key="actions" {...blurFade({ x: -6, blur: 4 })} className="flex flex-wrap items-center gap-1.5">
              {rule && onDelete && !rule.preset ? (
                <button onClick={() => setConfirm("delete")} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
                  Delete
                </button>
              ) : null}
              {rule ? (
                <button onClick={() => setConfirm("run")} disabled={busy || (draft.when !== "schedule" && !current?.count)} className={buttonClass}>
                  {draft.when === "schedule" ? "Run now" : "Run on existing mail"}
                </button>
              ) : null}
              <button onClick={onCancel} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
                Cancel
              </button>
              <button onClick={() => void save()} disabled={busy} className="h-8 rounded-full bg-accent px-3.5 text-[12.5px] font-medium text-accent-fg disabled:opacity-60">
                Save
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

const TRIGGER_OPTIONS: { id: Trigger; label: string }[] = (["new_mail", "sent", "schedule"] as const).map((id) => ({ id, label: TRIGGER_NAMES[id] }));

const TRIGGER_NOTES: Record<Trigger, string> = {
  new_mail: "Any mail, or narrow it with a search and conditions.",
  sent: "Mail you send, from Kite or anywhere else: an invoice, an application. Narrow it with a search.",
  schedule: "A day each week or month, for the people you pick.",
};

/** 90 -> "90 minutes"; 60 -> "1 hour"; 1440 -> "1 day". */
export function waitText(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

/** "Wait before acting" choices, in minutes. */
const WAIT_OPTIONS = [0, 15, 60, 240, 1440].map((m) => ({ value: String(m), label: m ? `Act after ${waitText(m)}` : "Act straight away" }));

const WEEKDAY_OPTIONS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((label, i) => ({ value: String(i), label }));

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

const MONTH_DAY_OPTIONS = [...Array.from({ length: 28 }, (_, i) => ({ value: String(i + 1), label: `the ${ordinal(i + 1)}` })), { value: "31", label: "the last day" }];

/** Every week on a weekday, or every month on a day, at a time. */
export function ScheduleEditor({ value, onChange }: { value: Schedule; onChange: (s: Schedule) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-pane-muted">
      <Select
        label="How often"
        value={value.every}
        options={[
          { value: "month", label: "Every month" },
          { value: "week", label: "Every week" },
        ]}
        onChange={(every) => onChange({ ...value, every, day: 1 })}
      />
      <span>on</span>
      <Select
        label="Day"
        value={String(value.every === "week" ? value.day % 7 : value.day >= 29 ? 31 : value.day)}
        options={value.every === "week" ? WEEKDAY_OPTIONS : MONTH_DAY_OPTIONS}
        onChange={(day) => onChange({ ...value, day: Number(day) })}
      />
      <span>at</span>
      <TimePicker
        label="At"
        value={value.time}
        onChange={(time) => onChange({ ...value, time })}
        trigger={(props) => (
          <button {...props} className={cn(inputClass, "flex items-center gap-1.5 tabular-nums hover:bg-pane-hover", props["aria-expanded"] && "border-accent/60")}>
            <Icon icon={Clock01Icon} size={13} className="text-pane-muted" />
            {value.time}
          </button>
        )}
      />
    </div>
  );
}

const ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The people a schedule is for: an address per chip, typed or pasted (several at once, split on commas or spaces). */
export function PeopleEditor({ emails, onChange }: { emails: string[]; onChange: (emails: string[]) => void }) {
  const [text, setText] = useState("");
  const add = () => {
    const found = text
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => ADDRESS.test(e) && !emails.includes(e));
    if (found.length) onChange([...emails, ...found].slice(0, 50));
    setText("");
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[12px] text-pane-muted">For each of</span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {emails.map((email) => (
          <span key={email} data-sensitive className="flex h-7 items-center gap-1 rounded-full bg-accent-soft pl-2.5 pr-1.5 text-[12px] font-medium text-accent">
            {email}
            <button aria-label={`Remove ${email}`} onClick={() => onChange(emails.filter((e) => e !== email))} className="grid size-4 place-items-center rounded-full hover:bg-accent/15">
              <Icon icon={Cancel01Icon} size={9} />
            </button>
          </span>
        ))}
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" && e.key !== ",") return;
            e.preventDefault();
            add();
          }}
          onBlur={add}
          placeholder={emails.length ? "Add another address" : "client@example.com, another@example.com"}
          aria-label="Add a person by address"
          className={cn(inputClass, "w-60")}
        />
      </div>
    </div>
  );
}

/** Search terms offered under the match field: a click adds the term to the search. */
const QUERY_HINTS: { term: string; about: string }[] = [
  { term: "from:", about: "Sender address or domain" },
  { term: "to:", about: "Who it was sent to" },
  { term: "subject:", about: "Words in the subject" },
  { term: "has:attachment", about: "Has files attached" },
  { term: "filename:", about: "An attached file's name" },
  { term: "label:", about: "Already has this label" },
  { term: "is:unread", about: "Not read yet" },
  { term: "OR", about: "Either the term before it or the one after" },
  { term: "-", about: "Put in front of a term to leave those out" },
];

/** One step of a rule: a numbered dot on a rail that runs down to the next step. */
function Step({ n, title, note, last, children }: { n: number; title: string; note?: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <div className="flex shrink-0 flex-col items-center">
        <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-[11.5px] font-semibold text-accent">{n}</span>
        {last ? null : <span className="my-1 w-px flex-1 bg-pane-border" />}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2.5", !last && "pb-5")}>
        <div className="pt-0.5">
          <p className="text-[13.5px] font-semibold tracking-tight">{title}</p>
          {note ? <p className="text-[11.5px] text-pane-muted">{note}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 self-start rounded-full py-0.5 text-[12px] font-medium text-accent transition-opacity hover:opacity-80">
      <Icon icon={Add01Icon} size={12} />
      {children}
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <button aria-label={label} onClick={onClick} className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
        <Icon icon={Cancel01Icon} size={12} />
      </button>
    </Tooltip>
  );
}

/** An account to run the rule in: its face (colour ring and provider mark) and a name that tells it apart. */
function AccountChip({ on, account, onClick, children }: { on: boolean; account?: Account; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        "flex h-8 max-w-64 min-w-0 items-center gap-2 rounded-full border text-[12px] transition-colors duration-150",
        account ? "pl-1 pr-3" : "px-3",
        on ? "border-accent/50 bg-accent-soft font-medium text-pane-fg" : "border-pane-border text-pane-muted hover:bg-pane-hover hover:text-pane-fg",
      )}
    >
      {account ? <AccountFace account={account} className="size-5 text-[9px]" /> : null}
      <span className="min-w-0 truncate" data-sensitive={account ? true : undefined}>
        {children}
      </span>
    </button>
  );
}

const GMAIL_OK = new Set<GmailFilterState["state"]>(["on", "exists"]);

/** "In Gmail" in the rules list, or a nudge when a filter needs something from you. */
export function GmailChip({ states }: { states: GmailFilterState[] }) {
  const ok = states.length > 0 && states.every((s) => GMAIL_OK.has(s.state));
  return (
    <span className={cn("shrink-0 rounded-full px-1.5 py-px text-[10.5px]", ok ? "bg-pane-2 text-pane-muted" : "bg-warning/10 text-warning")}>
      {ok ? "In Gmail" : "Gmail needs a look"}
    </span>
  );
}

function filterLine(s: GmailFilterState) {
  switch (s.state) {
    case "on":
      return "On in Gmail, so it runs while Kite is closed.";
    case "reconnect":
      return "Google needs your permission before Kite can add filters.";
    case "no-label":
      return `No label “${s.detail ?? ""}” here, so Gmail doesn't run it.`;
    case "gone":
      return "Removed in Gmail. Switch this off and on to add it back.";
    case "exists":
      return "Gmail already has this filter (one you made), so Kite left it alone.";
    case "failed":
      return `Gmail didn't accept it${s.detail ? ` (${s.detail})` : ""}. Save again to retry.`;
  }
}

/** "Also run in Gmail": offered only when the whole rule translates, with how each account's filter stands once saved. */
function GmailOption({
  on,
  reason,
  saved,
  accounts,
  onChange,
}: {
  on: boolean;
  reason: string | null;
  saved?: RuleView;
  accounts: Account[];
  onChange: (on: boolean) => void;
}) {
  const states = (saved?.gmailFilters ?? []).filter((s) => accounts.some((a) => a.id === s.accountId));
  const many = accounts.length > 1;
  const nameOf = (id: string) => {
    const account = accounts.find((a) => a.id === id);
    return account ? accountName(account) : "";
  };
  return (
    <div className="flex flex-col gap-1.5 pt-1">
      <label className="flex items-center justify-between gap-3">
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium">Also run in Gmail</span>
          <span className="block text-[11.5px] text-pane-muted">
            {reason ??
              (on
                ? "Kite keeps a Gmail filter for this automation, so it runs while Kite is closed. What it did still shows in Activity, with Undo."
                : "Adds a Gmail filter so this automation runs while Kite is closed. The first time, Google asks you to let Kite manage filters.")}
          </span>
        </span>
        <Switch value={on} disabled={!!reason} label="Also run in Gmail" size="sm" onChange={onChange} />
      </label>
      <AnimatePresence initial={false}>
        {saved && !saved.enabled ? (
          <motion.p key="paused" {...blurFade({ y: -4 })} className="rounded-lg bg-pane-2 px-3 py-2 text-[11.5px] text-pane-muted">
            Paused, so the Gmail filter is removed until you switch the automation back on.
          </motion.p>
        ) : saved && states.length ? (
          <motion.ul key="states" {...blurFade({ y: -4 })} className="flex flex-col gap-1.5 rounded-lg bg-pane-2 px-3 py-2">
            {states.map((s) => {
              const account = accounts.find((a) => a.id === s.accountId);
              return (
                <li key={s.accountId} className={cn("flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px]", GMAIL_OK.has(s.state) ? "text-pane-muted" : "text-warning")}>
                  <span className="min-w-0">
                    {many ? <span className="font-medium text-pane-fg">{nameOf(s.accountId)}: </span> : null}
                    {filterLine(s)}
                  </span>
                  {s.state === "reconnect" && account ? (
                    <a href={`/api/auth/google?hint=${encodeURIComponent(account.email)}`} className="font-medium text-accent hover:opacity-80">
                      Reconnect
                    </a>
                  ) : null}
                </li>
              );
            })}
          </motion.ul>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const SNOOZE_KINDS: { value: SnoozeFor["kind"]; label: string }[] = [
  { value: "tomorrow", label: "until tomorrow" },
  { value: "weekend", label: "until Saturday" },
  { value: "next_week", label: "until Monday" },
  { value: "after", label: "for a while" },
];

const NOTIFY_OPTIONS: { value: (typeof NOTIFY_MODES)[number]; label: string }[] = [
  { value: "now", label: "straight away" },
  { value: "batch", label: "with the next batch" },
  { value: "silent", label: "never (stay quiet)" },
];

function ActionRow({
  trigger,
  action,
  blanks,
  fields,
  collections,
  onCreateCollection,
  sampleSubject,
  onChange,
  onRemove,
}: {
  trigger: Trigger;
  action: RuleAction;
  blanks: Blank[];
  fields: FieldSpec[];
  collections: CollectionSummary[];
  onCreateCollection: (name: string) => Promise<CollectionSummary | null>;
  sampleSubject?: string;
  onChange: (a: RuleAction) => void;
  onRemove?: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <Select label="Action" value={action.verb} options={verbOptions(trigger)} onChange={(v) => onChange(defaultAction(v))} />
      {action.verb === "label" || action.verb === "unlabel" ? (
        <input
          list="rule-labels"
          value={action.label}
          onChange={(e) => onChange({ ...action, label: e.target.value })}
          placeholder="Label name"
          aria-label="Label"
          className={cn(inputClass, "w-44")}
        />
      ) : null}
      {action.verb === "notify" ? (
        <Select label="How" value={action.mode} options={NOTIFY_OPTIONS} onChange={(mode) => onChange({ ...action, mode })} />
      ) : null}
      {action.verb === "snooze" ? (
        <>
          <Select
            label="Snooze until"
            value={action.for.kind}
            options={SNOOZE_KINDS}
            onChange={(kind) => onChange({ ...action, for: kind === "after" ? { kind, amount: 4, unit: "hours" } : { kind, time: "08:00" } })}
          />
          {action.for.kind === "after" ? (
            <>
              <input
                type="number"
                min={1}
                max={365}
                aria-label="How long"
                value={action.for.amount}
                onChange={(e) => onChange({ ...action, for: { kind: "after", unit: action.for.kind === "after" ? action.for.unit : "hours", amount: Math.max(1, Math.min(365, Number(e.target.value) || 1)) } })}
                className={cn(inputClass, "w-16 tabular-nums")}
              />
              <Select
                label="Unit"
                value={action.for.unit}
                options={[
                  { value: "hours", label: "hours" },
                  { value: "days", label: "days" },
                ]}
                onChange={(unit) => onChange({ ...action, for: { kind: "after", amount: action.for.kind === "after" ? action.for.amount : 1, unit } })}
              />
            </>
          ) : (
            <TimePicker
              label="At"
              value={action.for.time}
              onChange={(time) => onChange({ ...action, for: { kind: action.for.kind as "tomorrow", time } })}
              trigger={(props) => (
                <button {...props} className={cn(inputClass, "flex items-center gap-1.5 tabular-nums hover:bg-pane-hover", props["aria-expanded"] && "border-accent/60")}>
                  <Icon icon={Clock01Icon} size={13} className="text-pane-muted" />
                  {action.for.kind === "after" ? null : action.for.time}
                </button>
              )}
            />
          )}
        </>
      ) : null}
      {action.verb === "collect" ? (
        <>
          <CollectionPick value={action.collection} collections={collections} onCreate={onCreateCollection} onChange={(collection) => onChange({ ...action, collection })} />
          {fields.length ? (
            <Select
              label="Rows"
              value={action.match ?? ""}
              options={[{ value: "", label: "a new row per email" }, ...fields.map((f) => ({ value: f.key, label: `one row per ${f.name.toLowerCase()}` }))]}
              onChange={(match) => onChange({ ...action, match: match || null })}
            />
          ) : null}
        </>
      ) : null}
      {action.verb === "pack" ? (
        <>
          <CollectionPick value={action.collection} collections={collections} onCreate={onCreateCollection} onChange={(collection) => onChange({ ...action, collection })} />
          <span className="text-[12px] text-pane-muted">to</span>
          <input
            type="email"
            value={action.to}
            onChange={(e) => onChange({ ...action, to: e.target.value.trim() })}
            placeholder="accountant@example.com"
            aria-label="Who gets the pack"
            className={cn(inputClass, "w-56")}
          />
          <input
            value={action.subject}
            onChange={(e) => onChange({ ...action, subject: e.target.value })}
            placeholder="Invoices for {period}"
            aria-label="Subject"
            className={cn(inputClass, "w-full basis-full")}
          />
          <label className="flex basis-full items-center justify-between gap-3 rounded-lg bg-pane-2 px-3 py-2">
            <span className="min-w-0 text-[11.5px] text-pane-muted">
              The last month&apos;s rows (the last week&apos;s for a weekly schedule), every file attached, emails with only a link listed. {"{period}"} is the month&apos;s name.
              {action.auto ? " Sent by itself." : " Waits in Drafts for you to send."}
            </span>
            <Switch value={action.auto} label="Send it by itself" size="sm" onChange={(auto) => onChange({ ...action, auto })} />
          </label>
        </>
      ) : null}
      {action.verb === "expect" ? <ExpectEditor trigger={trigger} action={action} onChange={onChange} /> : null}
      {action.verb === "remind" ? (
        <>
          <input
            type="number"
            min={0}
            max={60}
            aria-label="Days before"
            value={action.daysBefore}
            onChange={(e) => onChange({ ...action, daysBefore: Math.max(0, Math.min(60, Number(e.target.value) || 0)) })}
            className={cn(inputClass, "w-14 tabular-nums")}
          />
          <span className="text-[12px] text-pane-muted">days before</span>
          <DateFieldPick value={action.field} fields={fields} onChange={(field) => onChange({ ...action, field })} />
          <span className="text-[12px] text-pane-muted">at</span>
          <TimePicker
            label="At"
            value={action.time}
            onChange={(time) => onChange({ ...action, time })}
            trigger={(props) => (
              <button {...props} className={cn(inputClass, "flex items-center gap-1.5 tabular-nums hover:bg-pane-hover", props["aria-expanded"] && "border-accent/60")}>
                <Icon icon={Clock01Icon} size={13} className="text-pane-muted" />
                {action.time}
              </button>
            )}
          />
        </>
      ) : null}
      {action.verb === "calendar" ? (
        <>
          <span className="text-[12px] text-pane-muted">on</span>
          <DateFieldPick value={action.field} fields={fields} onChange={(field) => onChange({ ...action, field })} />
          <input
            value={action.title}
            onChange={(e) => onChange({ ...action, title: e.target.value })}
            placeholder="Pay {sender} {amount}"
            aria-label="Event title"
            className={cn(inputClass, "w-full basis-full")}
          />
          <p className="basis-full px-1 text-[11.5px] text-pane-muted">Kept only in Kite&apos;s calendar. Blanks: {blanks.map((b) => `{${b.key}}`).join(" ")}</p>
        </>
      ) : null}
      {onRemove ? <RemoveButton label="Remove this action" onClick={onRemove} /> : null}
      {action.verb === "draft_reply" ? (
        <input
          value={action.instruction}
          onChange={(e) => onChange({ ...action, instruction: e.target.value })}
          placeholder="How to answer (optional), like: thank them, say I'll reply properly by Friday"
          aria-label="How your AI should answer"
          maxLength={1000}
          className={cn(inputClass, "w-full basis-full")}
        />
      ) : null}
      {action.verb === "prepare_reply" ? (
        <ReplyTemplate template={action.template} blanks={blanks} sampleSubject={sampleSubject} onChange={(template) => onChange({ ...action, template })} />
      ) : null}
    </div>
  );
}

const ASK_PLACEHOLDER = "Hi {first_name},\n\nCould you send me your bank statement for {period}?\n\nThanks";

const EXPECT_WHO: Record<Trigger, string> ={ new_mail: "the sender", sent: "the people you wrote to", schedule: "each person" };

/** The expect verb: how long to wait, what counts as the answer, the request (schedules) and the nudge ladder. */
export function ExpectEditor({ trigger, action, onChange }: { trigger: Trigger; action: Extract<RuleAction, { verb: "expect" }>; onChange: (a: RuleAction) => void }) {
  const set = (p: Partial<typeof action>) => onChange({ ...action, ...p });
  const number = (value: string, min: number, max: number) => Math.max(min, Math.min(max, Number(value) || min));
  return (
    <div className="flex min-w-0 basis-full flex-col gap-2.5 rounded-xl border border-pane-border p-3">
      {trigger === "schedule" ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-[12px] font-medium">Ask first</span>
          <input value={action.askSubject} onChange={(e) => set({ askSubject: e.target.value })} placeholder="Your documents for {period}" aria-label="Request subject" className={cn(inputClass, "w-full")} />
          <textarea
            value={action.ask}
            onChange={(e) => set({ ask: e.target.value })}
            rows={6}
            placeholder={ASK_PLACEHOLDER}
            aria-label="Request"
            className="w-full rounded-xl border border-pane-border bg-transparent px-3 py-2 text-[12.5px] leading-relaxed outline-none placeholder:text-pane-muted focus:border-accent/60"
          />
          <span className="text-[11.5px] text-pane-muted">Leave it empty to only wait (they send it without being asked). Blanks: {"{first_name} {name} {period}"}</span>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-pane-muted">
        <span>Expect an answer from {EXPECT_WHO[trigger]} within</span>
        <input type="number" min={1} max={90} value={action.days} aria-label="Days to wait" onChange={(e) => set({ days: number(e.target.value, 1, 90) })} className={cn(inputClass, "w-14 tabular-nums")} />
        <span>days</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        <input
          value={action.answer}
          onChange={(e) => set({ answer: e.target.value })}
          placeholder={trigger === "sent" ? "What counts, like: subject:paid OR “payment received” (empty: any reply)" : "What counts (empty: any email from them)"}
          aria-label="What counts as the answer"
          spellCheck={false}
          className={cn(inputClass, "h-9 w-full")}
        />
        <span className="px-1 text-[11.5px] text-pane-muted">A search. Put from: in it when the answer comes from someone else (your bank, a payment service).</span>
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[12px] font-medium">If nothing comes</span>
        {action.nudges.map((text, i) => (
          <div key={i} className="flex min-w-0 items-start gap-1.5">
            <span className="mt-2 w-12 shrink-0 text-[11.5px] text-pane-muted">{["First", "Then", "Last"][i]}</span>
            <textarea
              value={text}
              onChange={(e) => set({ nudges: action.nudges.map((n, j) => (j === i ? e.target.value : n)) })}
              rows={4}
              aria-label={`Nudge ${i + 1}`}
              className="min-w-0 flex-1 rounded-xl border border-pane-border bg-transparent px-3 py-2 text-[12.5px] leading-relaxed outline-none focus:border-accent/60"
            />
            <RemoveButton label="Remove this nudge" onClick={() => set({ nudges: action.nudges.filter((_, j) => j !== i) })} />
          </div>
        ))}
        {action.nudges.length < 3 ? <AddButton onClick={() => set({ nudges: [...action.nudges, NUDGES[action.nudges.length]] })}>{action.nudges.length ? "Add a firmer nudge" : "Add a nudge"}</AddButton> : null}
        {action.nudges.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-pane-muted">
            <span>One every</span>
            <input type="number" min={1} max={30} value={action.every} aria-label="Days between nudges" onChange={(e) => set({ every: number(e.target.value, 1, 30) })} className={cn(inputClass, "w-14 tabular-nums")} />
            <span>days</span>
          </div>
        ) : null}
      </div>
      <label className="flex items-center justify-between gap-3 rounded-lg bg-pane-2 px-3 py-2">
        <span className="min-w-0">
          <span className="block text-[12.5px] font-medium">Send {trigger === "schedule" && action.ask ? "the request and nudges" : "nudges"} by itself</span>
          <span className="block text-[11.5px] text-pane-muted">
            {action.auto
              ? "Kite sends each one when it's due, from your account. Waiting on shows every step."
              : "Off: each one waits in Waiting on (and in the conversation's quick reply) for one tap."}
          </span>
        </span>
        <Switch value={action.auto} label="Send by itself" size="sm" onChange={(auto) => set({ auto })} />
      </label>
    </div>
  );
}

/** The reply a rule prepares: markup like snippets, with blanks filled when the rule matches. */
function ReplyTemplate({ template, blanks, sampleSubject, onChange }: { template: string; blanks: Blank[]; sampleSubject?: string; onChange: (template: string) => void }) {
  const editor = useRef<RichEditorHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const [format, setFormat] = useState<FormatState>({ bold: false, italic: false, bulletList: false, numberList: false });
  const known = new Set(blanks.map((b) => b.key));
  const unknown = blanksIn(template).filter((k) => !known.has(k));
  // How it reads: the message's blanks with a sample.
  const sample: Record<string, string> = Object.fromEntries(blanks.map((b) => [b.key, `[${b.label}]`]));
  Object.assign(sample, { first_name: "Sam", name: "Sam Dlamini", subject: sampleSubject?.replace(/^\s*((re|fwd?)\s*:\s*)+/i, "") || "Your order" });
  const preview = bodyToText(fillBlanks(template, sample).body).trim();

  const insert = (key: string) => {
    const el = box.current?.querySelector<HTMLElement>("[contenteditable]");
    if (!el) return;
    if (!el.contains(document.activeElement)) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
    document.execCommand("insertText", false, `{${key}}`);
  };

  return (
    <div className="flex min-w-0 basis-full flex-col gap-2 pt-1">
      <div ref={box} className="rounded-xl border border-pane-border focus-within:border-accent/50">
        <RichEditor
          ref={editor}
          initial={template}
          onChange={onChange}
          onFormat={setFormat}
          placeholder="Hi {first_name}, thanks for…"
          ariaLabel="Reply to prepare"
          className="max-h-60 min-h-20 overflow-y-auto px-3 py-2 text-[13px] leading-6"
        />
        <div className="border-t border-pane-border px-2 py-1">
          <FormatBar editor={editor} state={format} />
        </div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="pr-1 text-[11.5px] text-pane-muted">Blanks</span>
        {blanks.map((b) => (
          <Tooltip key={b.key} label={b.label}>
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insert(b.key)}
              className="h-6 rounded-full border border-pane-border px-2 tabular-nums text-[11px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
            >
              {`{${b.key}}`}
            </button>
          </Tooltip>
        ))}
      </div>
      <p className={cn("text-[11.5px]", unknown.length ? "text-warning" : "text-pane-muted")}>
        {unknown.length
          ? `${unknown.map((k) => `{${k}}`).join(", ")} ${unknown.length === 1 ? "isn't a blank" : "aren't blanks"} here, so ${unknown.length === 1 ? "it stays" : "they stay"} as typed.`
          : "Blanks with no value stay in the reply for you to fill."}
      </p>
      {preview ? (
        <div className="whitespace-pre-line rounded-lg bg-pane-2 px-3 py-2.5 text-[12.5px] leading-relaxed" data-sensitive>
          <span className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-pane-muted">Preview</span>
          {preview}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

type Group = { key: string; ruleName: string; at: string; done: string[]; runs: RuleRunView[]; existing: boolean };

function groupRuns(runs: RuleRunView[]): Group[] {
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const key = run.batchId ?? `${run.ruleId}:${run.at.slice(0, 10)}`;
    const group = groups.get(key) ?? { key, ruleName: run.ruleName, at: run.at, done: [], runs: [], existing: run.trigger === "existing" };
    group.runs.push(run);
    run.done.forEach((d) => !group.done.includes(d) && group.done.push(d));
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function Activity({ runs, onUndo }: { runs: RuleRunView[]; onUndo: (ids: string[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = groupRuns(runs).slice(0, 30);
  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-[13px] font-medium">Activity</p>
      {groups.length ? (
        <div className="flex flex-col divide-y divide-pane-border rounded-xl border border-pane-border">
          {groups.map((g) => {
            const pending = g.runs.filter((r) => r.undoable && !r.undoneAt);
            const failed = g.runs.some((r) => r.failed);
            return (
              <div key={g.key} className="flex min-w-0 flex-col px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <button onClick={() => setOpen(open === g.key ? null : g.key)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12.5px]">
                      <span className="font-medium">{g.ruleName}</span> {g.done.join(", ") || (failed ? "couldn't change" : "ran on")} {g.runs.length} conversation
                      {g.runs.length === 1 ? "" : "s"}
                      {g.existing ? " (existing mail)" : ""}
                    </span>
                    <span className={cn("block text-[11.5px]", failed ? "text-warning" : "text-pane-muted")}>
                      {format(new Date(g.at), "d MMM, HH:mm")}
                      {g.runs.some((r) => r.inGmail) ? " · Gmail's filter did it before Kite saw the mail" : ""}
                      {failed ? " · Gmail didn't accept some changes" : ""}
                    </span>
                  </button>
                  {pending.length ? (
                    <button onClick={() => onUndo(pending.map((r) => r.id))} className={buttonClass}>
                      Undo
                    </button>
                  ) : g.runs.some((r) => r.undoneAt) ? (
                    <span className="shrink-0 text-[12px] text-pane-muted">Undone</span>
                  ) : null}
                </div>
                {open === g.key ? (
                  <ul data-sensitive className="blur-fade mt-1.5 flex flex-col gap-0.5">
                    {g.runs.map((r) => (
                      <li key={r.id} className="truncate text-[12px] text-pane-muted">
                        {r.subject}
                        {r.undoneAt ? " (undone)" : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[12px] text-pane-muted">Nothing yet. When an automation changes mail, it shows here with Undo.</p>
      )}
    </div>
  );
}

/** "Add to a collection": pick one, or make one on the spot. */
export function CollectionPick({
  value,
  collections,
  onCreate,
  onChange,
}: {
  value: string;
  collections: CollectionSummary[];
  onCreate: (name: string) => Promise<CollectionSummary | null>;
  onChange: (id: string) => void;
}) {
  // No collections yet: name one straight away (a starter's own new collection shows as itself).
  const [making, setMaking] = useState(!collections.length && !newCollectionName(value));
  const [name, setName] = useState("");
  if (making) {
    const make = async () => {
      if (!name.trim()) return;
      const made = await onCreate(name);
      if (made) {
        onChange(made.id);
        setMaking(false);
        setName("");
      }
    };
    return (
      <span className="flex items-center gap-1.5">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void make()}
          placeholder="New collection, like Bills"
          aria-label="New collection's name"
          className={cn(inputClass, "w-48")}
        />
        <button onClick={() => void make()} disabled={!name.trim()} className="h-8 rounded-full bg-accent px-3 text-[12px] font-medium text-accent-fg disabled:opacity-50">
          Make
        </button>
        {collections.length ? (
          <button onClick={() => setMaking(false)} className="h-8 rounded-full px-2 text-[12px] text-pane-muted hover:text-pane-fg">
            Cancel
          </button>
        ) : null}
      </span>
    );
  }
  const fresh = newCollectionName(value);
  return (
    <Select
      label="Collection"
      value={collections.some((c) => c.id === value) || fresh ? value : "__pick"}
      options={[
        ...(fresh ? [{ value, label: `${fresh} (made when you save)` }] : collections.some((c) => c.id === value) ? [] : [{ value: "__pick", label: "Pick a collection" }]),
        ...collections.map((c) => ({ value: c.id, label: c.name })),
        { value: "__new", label: "New collection…" },
      ]}
      onChange={(id) => (id === "__new" ? setMaking(true) : id !== "__pick" ? onChange(id) : undefined)}
    />
  );
}

/** A date the automation read (or when the email came), for reminders and events. */
function DateFieldPick({ value, fields, onChange }: { value: string; fields: FieldSpec[]; onChange: (key: string) => void }) {
  const dates = fields.filter((f) => f.type === "date");
  const options = [...dates.map((f) => ({ value: f.key, label: f.name })), { value: "received", label: "when it arrived" }];
  return <Select label="Date" value={options.some((o) => o.value === value) ? value : "__pick"} options={options.some((o) => o.value === value) ? options : [{ value: "__pick", label: "Pick a date" }, ...options]} onChange={(key) => key !== "__pick" && onChange(key)} />;
}
