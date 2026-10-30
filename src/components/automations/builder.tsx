"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { format } from "date-fns";
import { AiMagicIcon, ArrowDown01Icon, Cancel01Icon, Clock01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { accountName, type Account } from "@/lib/mail/types";
import type { AiModel } from "@/lib/ai-pricing";
import { blurFade } from "@/lib/motion";
import { gmailFilterFor, type GmailFilterState } from "@/lib/rules/gmail";
import { MESSAGE_BLANKS } from "@/lib/rules/prepared";
import type { FieldCheck, FieldSpec, FieldValues } from "@/lib/automations/fields";
import type { CollectionSummary } from "@/lib/automations/collections";
import { newCollectionName } from "@/lib/automations/templates";
import { RuleDraftSchema, SENDER_STATUSES, TRIGGER_NAMES, TRIGGER_VERBS, defaultAction, describeSchedule, describeCondition, referenceProblem, usesAi, type Condition, type RuleAction, type RuleDraft, type RuleView, type Schedule, type Trigger } from "@/lib/rules/spec";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { AccountFace } from "../mail/account-face";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { Spinner } from "../ui/spinner";
import { ChecksEditor, FieldsEditor } from "./read-step";
import { Segmented } from "../settings/settings-ui";
import { AddButton, type Blank, RemoveButton, Step, buttonClass, inputClass, request } from "./builder-ui";
import { PeopleEditor, ScheduleEditor, WAIT_OPTIONS } from "./builder-editors";
import { ActionRow } from "./action-row";

// The automation builder and its companions (Describe an automation, AI drafts, Activity), used by
// the Automations view (automations-view.tsx). An automation is When → Read → Check → Do
// (lib/rules/spec.ts); Kite runs them top to bottom on new mail, and on existing mail only when
// "Run on existing mail" is pressed.

/** What the builder shows under the steps: how many conversations would have matched, and what Read found. */
type Preview = { key: string; count: number; capped: boolean; subjects: string[]; screensNew: boolean; samples: { subject: string; values: FieldValues }[]; next: string | null };
type Label = { accountId: string; name: string };

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
    if (draft.actions.some((a) => a.verb === "space" && !a.space)) return setError("Pick a space to put it in");
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
