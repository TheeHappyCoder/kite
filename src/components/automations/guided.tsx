"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, Search01Icon, Settings02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { format } from "date-fns";
import type { CollectionSummary } from "@/lib/automations/collections";
import { FIELD_TYPE_NAMES, opsFor, readFields, type CheckOp, type FieldSpec } from "@/lib/automations/fields";
import { factsOfExample, fieldFromPick, fieldFromSelection, pickables, type AutomationExample, type AutomationSender, type Pickable } from "@/lib/automations/pick";
import { newCollectionName, type Starter } from "@/lib/automations/templates";
import { blurFade } from "@/lib/motion";
import { NUDGES, RuleDraftSchema, describeAction, describeSchedule, type RuleAction, type RuleDraft, type RuleView, type Schedule, type Trigger } from "@/lib/rules/spec";
import type { Account, Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { Avatar } from "../mail/avatar";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { CollectionPick, ExpectEditor, ScheduleEditor, SpacePick, request, waitText } from "./builder";
import { inputClass } from "./read-step";

// The one way every automation is built (starters only fill it in): 1 pick whose emails (or, on a
// schedule, who it's for), 2 click what to read in a real one (Kite shows how it reads the others;
// a schedule picks its day here instead), 3 switch on what happens, 4 name it and save, optionally
// filling it from the last 30 days. Everything runs on the local copy; Fine-tune opens the same
// automation in the full builder.

const STEPS: Record<Trigger, readonly string[]> = {
  new_mail: ["Emails", "Read", "Do", "Finish"],
  sent: ["Emails", "Read", "Do", "Finish"],
  schedule: ["Who", "When", "Do", "Finish"],
};
type StepId = 0 | 1 | 2 | 3;

type ExpectAction = Extract<RuleAction, { verb: "expect" }>;
type PackAction = Extract<RuleAction, { verb: "pack" }>;

type Choices = {
  collect: { on: boolean; name: string; match: string | null };
  remind: { on: boolean; field: string; daysBefore: number; time: string };
  calendar: { on: boolean; field: string; title: string };
  archive: boolean;
  /** Into one of Kite's spaces (lib/spaces.ts). */
  space: { on: boolean; id: string };
  markRead: boolean;
  star: boolean;
  notify: boolean;
  reply: { on: boolean; template: string };
  check: { on: boolean; field: string; op: CheckOp; value: string };
  expect: { on: boolean; action: ExpectAction };
  pack: { on: boolean; action: PackAction };
  /** A starter's other steps (a snooze), kept as they are with a switch each. */
  extras: { on: boolean; action: RuleAction }[];
};

/** Verbs the wizard has its own switch for; anything else a starter brings is an extra. */
const OWN = new Set<RuleAction["verb"]>(["collect", "remind", "calendar", "archive", "space", "mark_read", "star", "notify", "prepare_reply", "expect", "pack"]);

const defaultExpect = (when: Trigger): ExpectAction => ({
  verb: "expect",
  days: 7,
  answer: "",
  askSubject: when === "schedule" ? "For {period}" : "",
  ask: "",
  nudges: [NUDGES[0]],
  every: 7,
  auto: false,
});

function choicesFrom(starter: Starter | null, name: string, when: Trigger): Choices {
  const acts = starter?.actions ?? [];
  const find = <V extends RuleAction["verb"]>(verb: V) => acts.find((a) => a.verb === verb) as Extract<RuleAction, { verb: V }> | undefined;
  const collect = find("collect");
  const remind = find("remind");
  const calendar = find("calendar");
  const reply = find("prepare_reply");
  const expect = find("expect");
  const pack = find("pack");
  const check = starter?.checks?.[0];
  return {
    collect: { on: !!collect || (!starter && when !== "schedule"), name: (collect && newCollectionName(collect.collection)) || name, match: collect?.match ?? null },
    remind: { on: !!remind, field: remind?.field ?? "", daysBefore: remind?.daysBefore ?? 2, time: remind?.time ?? "09:00" },
    calendar: { on: !!calendar, field: calendar?.field ?? "", title: calendar?.title ?? "{subject}" },
    archive: !!find("archive"),
    space: { on: !!find("space"), id: find("space")?.space ?? "" },
    markRead: !!find("mark_read"),
    star: !!find("star"),
    notify: acts.some((a) => a.verb === "notify" && a.mode === "now"),
    reply: { on: !!reply, template: reply?.template ?? "Hi {first_name},\n\n" },
    check: { on: !!check, field: check?.field ?? "", op: (check?.op as CheckOp) ?? "more", value: check?.value ?? "" },
    expect: { on: !!expect || (!starter && when === "schedule"), action: expect ?? defaultExpect(when) },
    pack: { on: !!pack, action: pack ?? { verb: "pack", collection: "", to: "", subject: "Invoices and receipts for {period}", auto: false } },
    extras: acts.filter((a) => !OWN.has(a.verb)).map((action) => ({ on: true, action })),
  };
}

const isMine = (from: { name: string; email: string }, own: Set<string>) => own.has(from.email.toLowerCase()) || from.name === "You";

/** Demo mode: senders (or, for mail you send, the people you wrote to) from the sample threads. */
function demoSenders(threads: Thread[], own: Set<string>, sent: boolean): AutomationSender[] {
  const by = new Map<string, AutomationSender>();
  const count = (person: { name: string; email: string }, date: string) => {
    const email = person.email.toLowerCase();
    if (own.has(email)) return;
    const s = by.get(email) ?? { email, name: person.name, emails: 0, lastDate: "" };
    s.emails++;
    if (date > s.lastDate) s.lastDate = date;
    by.set(email, s);
  };
  for (const t of threads)
    for (const m of t.messages) {
      if (sent) {
        if (isMine(m.from, own)) m.to.forEach((p) => count(p, m.date));
      } else if (!isMine(m.from, own)) count(m.from, m.date);
    }
  return [...by.values()].sort((a, b) => b.emails - a.emails);
}

function demoExamples(threads: Thread[], senders: string[], own: Set<string>, sent: boolean): AutomationExample[] {
  return threads
    .flatMap((t) =>
      t.messages
        .filter((m) => (sent ? isMine(m.from, own) && m.to.some((p) => senders.includes(p.email.toLowerCase())) : senders.includes(m.from.email.toLowerCase())))
        .map((m) => {
          const other = sent ? (m.to[0] ?? m.from) : m.from;
          return { threadId: t.id, accountId: t.accountId, subject: m.subject ?? t.subject, sender: other.name, senderEmail: other.email, date: m.date, text: m.body.join("\n\n") };
        }),
    )
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 10);
}

const PICK_TITLES: Record<Trigger, string> = { new_mail: "Whose emails?", sent: "Who do you send them to?", schedule: "Who is it for?" };
const PICK_LINES: Record<Trigger, string> = {
  new_mail: "Pick who sends the emails this is about. Pick several if you like.",
  sent: "Pick the people you send these emails to. Pick several if you like.",
  schedule: "Pick the people to ask each time. Kite waits for each one separately.",
};

export function GuidedBuilder({
  live,
  accounts,
  demoThreads,
  starter,
  collections,
  onCreateCollection,
  onSaved,
  onFineTune,
  onCancel,
  onToast,
}: {
  live: boolean;
  accounts: Account[];
  demoThreads: Thread[];
  starter: Starter | null;
  collections: CollectionSummary[];
  onCreateCollection: (name: string) => Promise<CollectionSummary | null>;
  /** Saved: the new list of automations, the one made, and the collection it fills (if any). */
  onSaved: (rules: RuleView[], made: RuleView | undefined, collection: string | null) => void;
  /** Open what's built so far in the full builder. */
  onFineTune: (draft: RuleDraft) => void;
  onCancel: () => void;
  onToast: (message: string) => void;
}) {
  const when: Trigger = starter?.when ?? "new_mail";
  const steps = STEPS[when];
  const packOnly = !!starter?.actions.some((a) => a.verb === "pack");
  const [step, setStep] = useState<StepId>(0);
  const [back, setBack] = useState(false);
  const go = (next: StepId) => {
    setBack(next < step);
    setStep(next);
  };

  // 1 · Emails (or who a schedule is for)
  const own = useMemo(() => new Set(accounts.map((a) => a.email.toLowerCase())), [accounts]);
  const sent = when !== "new_mail";
  const [fetchedSenders, setFetchedSenders] = useState<AutomationSender[] | null>(null);
  useEffect(() => {
    if (!live || packOnly) return;
    fetch(`/api/automations/examples?senders=1${sent ? "&sent=1" : ""}`)
      .then((r) => r.json())
      .then((d: { senders: AutomationSender[] }) => setFetchedSenders(d.senders ?? []))
      .catch(() => setFetchedSenders([]));
  }, [live, sent, packOnly]);
  const senders = useMemo(() => (live ? fetchedSenders : demoSenders(demoThreads, own, sent)), [live, fetchedSenders, demoThreads, own, sent]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [find, setFind] = useState("");
  const [words, setWords] = useState(starter?.query ?? "");
  const [schedule, setSchedule] = useState<Schedule>(starter?.schedule ?? { every: "month", day: 1, time: "09:00" });

  // 2 · Read
  const [fetched, setFetched] = useState<{ key: string; examples: AutomationExample[] } | null>(null);
  const examplesKey = `${chosen.join(",")}|${words}|${when}`;
  const canExample = when !== "schedule" && (chosen.length > 0 || words.trim().length > 1);
  useEffect(() => {
    if (!live || !canExample) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/automations/examples?from=${encodeURIComponent(chosen.join(","))}&q=${encodeURIComponent(words)}${when === "sent" ? "&sent=1" : ""}`, { signal: controller.signal })
        .then((r) => r.json())
        .then((d: { examples: AutomationExample[] }) => setFetched({ key: examplesKey, examples: d.examples ?? [] }))
        .catch(() => {});
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [live, chosen, words, examplesKey, canExample, when]);
  const examples = live ? (fetched?.key === examplesKey ? fetched.examples : null) : demoExamples(demoThreads, chosen, own, when === "sent");
  const [shownAt, setShownAt] = useState(0);
  const example = examples?.[Math.min(shownAt, Math.max(0, (examples?.length ?? 1) - 1))] ?? null;
  const [fields, setFields] = useState<FieldSpec[]>(starter?.fields ?? []);
  const [selection, setSelection] = useState<string | null>(null);
  const wants = starter?.wants ?? [];
  const nextName = wants.find((w) => !fields.some((f) => f.name.toLowerCase() === w.toLowerCase()));

  // 3 · Do, 4 · Finish
  const [name, setName] = useState(starter?.name ?? "");
  const [choices, setChoices] = useState<Choices>(() => choicesFrom(starter, starter?.name ?? "My collection", when));
  const [fill, setFill] = useState(true);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<Choices>) => setChoices((c) => ({ ...c, ...patch }));
  const dateFields = fields.filter((f) => f.type === "date");

  const pick = (p: Pickable) => {
    const at = fields.findIndex((f) => f.from.kind === "after" && f.from.label === p.label && f.type === p.type);
    if (at >= 0) return setFields(fields.filter((_, i) => i !== at));
    const field = fieldFromPick(p, fields.map((f) => f.key), nextName);
    setFields([...fields, field]);
    // A starter's steps name the fields they use (`due_date`): the first date read fills them in.
    if (field.type === "date") {
      setChoices((c) => ({
        ...c,
        remind: { ...c.remind, field: c.remind.field && fields.some((f) => f.key === c.remind.field) ? c.remind.field : field.key },
        calendar: { ...c.calendar, field: c.calendar.field && fields.some((f) => f.key === c.calendar.field) ? c.calendar.field : field.key },
      }));
    }
  };
  const readSelection = () => {
    if (!example || !selection) return;
    const field = fieldFromSelection(example.text, selection, fields.map((f) => f.key), nextName);
    if (!field) return onToast("Kite needs a few words in front of the text to find it in other emails. Pick text that follows a label, like “Shop:”.");
    setFields([...fields, field]);
    setSelection(null);
    getSelection()?.removeAllRanges();
  };

  /** The automation the choices make. */
  const draft = (): RuleDraft => {
    const actions: RuleAction[] = [];
    if (when === "schedule") {
      if (choices.expect.on) actions.push(choices.expect.action);
      if (choices.pack.on) actions.push(choices.pack.action);
      return {
        name: name.trim() || starter?.name || "My automation",
        when,
        schedule,
        accounts: [],
        query: "",
        conditions: chosen.length ? [{ kind: "senders", emails: chosen, negate: false }] : [],
        fields: [],
        checks: [],
        actions,
      };
    }
    const match = choices.collect.match && fields.some((f) => f.key === choices.collect.match) ? choices.collect.match : null;
    if (choices.collect.on) actions.push({ verb: "collect", collection: `new:${choices.collect.name.trim() || name.trim() || "Collection"}`, match });
    // Steps on a date need a date that's read: the one chosen, else the first one.
    const dateOf = (key: string) => (dateFields.some((f) => f.key === key) ? key : dateFields[0]?.key);
    const remindOn = choices.remind.on && dateOf(choices.remind.field);
    const calendarOn = choices.calendar.on && dateOf(choices.calendar.field);
    if (remindOn) actions.push({ verb: "remind", field: dateOf(choices.remind.field)!, daysBefore: choices.remind.daysBefore, time: choices.remind.time });
    if (calendarOn) actions.push({ verb: "calendar", field: dateOf(choices.calendar.field)!, title: choices.calendar.title.trim() || "{subject}" });
    if (choices.expect.on) actions.push(choices.expect.action);
    if (when === "new_mail" && choices.reply.on && choices.reply.template.trim()) actions.push({ verb: "prepare_reply", template: choices.reply.template });
    if (when === "new_mail" && choices.markRead) actions.push({ verb: "mark_read" });
    if (choices.star) actions.push({ verb: "star" });
    if (choices.space.on && choices.space.id) actions.push({ verb: "space", space: choices.space.id });
    if (choices.archive) actions.push({ verb: "archive" });
    if (when === "new_mail" && choices.notify) actions.push({ verb: "notify", mode: "now" });
    for (const extra of choices.extras) if (extra.on) actions.push(extra.action);
    const checkField = fields.find((f) => f.key === choices.check.field) ?? fields[0];
    return {
      name: name.trim() || starter?.name || "My automation",
      when,
      delay: when === "new_mail" ? (starter?.delay ?? 0) : 0,
      query: words.trim(),
      conditions: chosen.length ? [{ kind: "senders", emails: chosen, negate: false }] : [],
      fields,
      checks: choices.check.on && checkField ? [{ field: checkField.key, op: choices.check.op, value: choices.check.value }] : [],
      actions,
    };
  };
  const doCount = draft().actions.length;

  const save = async () => {
    const d = draft();
    if (!d.actions.length) return onToast("Switch on at least one thing to do.");
    if (choices.pack.on && (!choices.pack.action.collection || !choices.pack.action.to.includes("@"))) return onToast("Pick the list to send and who gets it.");
    setSaving(true);
    try {
      let collection: string | null = null;
      const actions: RuleAction[] = [];
      for (const a of RuleDraftSchema.parse(d).actions) {
        const fresh = a.verb === "collect" ? newCollectionName(a.collection) : null;
        if (a.verb !== "collect" || !fresh) {
          actions.push(a);
          continue;
        }
        const made = collections.find((c) => c.name.toLowerCase() === fresh.toLowerCase()) ?? (await onCreateCollection(fresh));
        if (!made) return;
        collection = made.id;
        actions.push({ ...a, collection: made.id });
      }
      const before = new Set<string>();
      const res = await request<{ rules: RuleView[] }>("/api/rules", "GET").catch(() => ({ rules: [] as RuleView[] }));
      res.rules.forEach((r) => before.add(r.id));
      const saved = await request<{ rules: RuleView[] }>("/api/rules", "POST", { ...d, actions });
      const made = saved.rules.find((r) => !before.has(r.id));
      const from = when === "sent" ? "mail you send" : "new mail";
      if (live && fill && made) {
        const ran = await request<{ changed: number }>(`/api/rules/${made.id}`, "POST", {}).catch(() => null);
        if (when === "schedule") onToast(ran ? `Saved, and run for this period: ${ran.changed ? "done" : "nothing new to do"}.` : `Saved. It runs ${describeSchedule(schedule).toLowerCase()}.`);
        else onToast(ran ? (ran.changed ? `Saved, and done on ${ran.changed} email${ran.changed === 1 ? "" : "s"} from the last 30 days.` : "Saved. Nothing in the last 30 days needed it.") : `Saved. It runs on ${from} from now on.`);
      } else onToast(when === "schedule" ? `Saved. It runs ${describeSchedule(schedule).toLowerCase()}.` : `Saved. It runs on ${from} from now on.`);
      onSaved(saved.rules, made, collection);
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const canNext =
    step === 0
      ? packOnly
        ? !!choices.pack.action.collection && choices.pack.action.to.includes("@")
        : chosen.length > 0 || (when !== "schedule" && words.trim().length > 1)
      : step === 2
        ? doCount > 0
        : true;

  return (
    <section className="flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      <header className="flex shrink-0 items-center gap-3 border-b border-pane-border px-5 py-3">
        <button onClick={onCancel} aria-label="Close" className="grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
          <Icon icon={Cancel01Icon} size={14} />
        </button>
        <ol className="flex min-w-0 flex-1 items-center justify-center gap-2" aria-label="Steps">
          {steps.map((label, i) => (
            <li key={label} className="flex items-center gap-2">
              <span
                className={cn(
                  "grid size-6 place-items-center rounded-full text-[11px] font-semibold transition-colors duration-150",
                  i < step ? "bg-accent text-accent-fg" : i === step ? "bg-pane-fg text-pane" : "bg-pane-2 text-pane-muted",
                )}
              >
                {i < step ? <Icon icon={Tick02Icon} size={12} /> : i + 1}
              </span>
              <span className={cn("hidden text-[12.5px] sm:inline", i === step ? "font-medium" : "text-pane-muted")}>{label}</span>
              {i < steps.length - 1 ? <span className="mx-1 hidden h-px w-6 bg-pane-border sm:block" /> : null}
            </li>
          ))}
        </ol>
        <button
          onClick={() => onFineTune(draft())}
          className="flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
        >
          <Icon icon={Settings02Icon} size={13} />
          <span className="hidden sm:inline">Fine-tune</span>
        </button>
      </header>

      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.div key={step} {...blurFade({ x: back ? -16 : 16, speed: "moderate" })} className="mx-auto w-full max-w-[760px] px-5 pb-10 pt-7">
            {step === 0 && packOnly ? (
              <>
                <Title title="Which list, to whom?" line="Pick the list that holds your invoices and receipts (an automation fills it), and your accountant's address." />
                <div className="flex flex-col gap-3 rounded-2xl border border-pane-border p-4">
                  <label className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="w-24 text-pane-muted">The list</span>
                    <CollectionPick
                      value={choices.pack.action.collection}
                      collections={collections}
                      onCreate={onCreateCollection}
                      onChange={(collection) => set({ pack: { ...choices.pack, action: { ...choices.pack.action, collection } } })}
                    />
                  </label>
                  <label className="flex flex-wrap items-center gap-2 text-[13px]">
                    <span className="w-24 text-pane-muted">Send it to</span>
                    <input
                      type="email"
                      value={choices.pack.action.to}
                      onChange={(e) => set({ pack: { ...choices.pack, action: { ...choices.pack.action, to: e.target.value.trim() } } })}
                      placeholder="accountant@example.com"
                      className={cn(inputClass, "w-64")}
                    />
                  </label>
                  {!collections.length ? (
                    <p className="text-[12px] text-pane-muted">No lists yet. Make one with the Receipts starter first, so there&apos;s something to send.</p>
                  ) : null}
                </div>
              </>
            ) : step === 0 ? (
              <>
                <Title title={starter && !starter.bySearch ? `${starter.name}: ${PICK_TITLES[when].toLowerCase()}` : starter ? starter.name : PICK_TITLES[when]} line={starter?.pick || PICK_LINES[when]} />
                {starter?.bySearch ? (
                  <div className="mb-5 flex flex-col gap-1.5">
                    <input value={words} onChange={(e) => setWords(e.target.value)} className={cn(inputClass, "h-10 w-full text-[13.5px]")} aria-label="Words to match" />
                    <span className="px-1 text-[12px] text-pane-muted">OR means either word. You can also pick people below.</span>
                  </div>
                ) : null}
                {chosen.length ? (
                  <div className="mb-3 flex flex-wrap gap-1.5">
                    {chosen.map((email) => (
                      <button
                        key={email}
                        onClick={() => setChosen(chosen.filter((e) => e !== email))}
                        className="flex h-7 items-center gap-1.5 rounded-full bg-accent-soft pl-2.5 pr-2 text-[12.5px] font-medium text-accent"
                      >
                        <span data-sensitive>{email}</span>
                        <Icon icon={Cancel01Icon} size={11} />
                      </button>
                    ))}
                  </div>
                ) : null}
                <label className="flex h-10 items-center gap-2 rounded-full border border-pane-border px-3.5 text-[13.5px] focus-within:border-accent/60">
                  <Icon icon={Search01Icon} size={15} className="text-pane-muted" />
                  <input
                    value={find}
                    onChange={(e) => setFind(e.target.value)}
                    onKeyDown={(e) => {
                      // An address nobody has written yet can be added as typed.
                      const typed = find.trim().toLowerCase();
                      if (e.key === "Enter" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(typed) && !chosen.includes(typed)) {
                        setChosen([...chosen, typed]);
                        setFind("");
                      }
                    }}
                    placeholder={when === "new_mail" ? "Find a sender by name or address" : "Find someone, or type an address and press Enter"}
                    className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
                  />
                </label>
                {!senders ? (
                  <div className="grid h-32 place-items-center text-pane-muted">
                    <Spinner size={18} />
                  </div>
                ) : (
                  <FluidList tone="pane" className="mt-2 flex max-h-[420px] flex-col overflow-y-auto">
                    {senders
                      .filter((s) => !find.trim() || `${s.name} ${s.email}`.toLowerCase().includes(find.trim().toLowerCase()))
                      .slice(0, 80)
                      .map((s) => {
                        const on = chosen.includes(s.email);
                        return (
                          <button
                            key={s.email}
                            {...FLUID_ITEM}
                            onClick={() => setChosen(on ? chosen.filter((e) => e !== s.email) : [...chosen, s.email])}
                            className={cn("relative flex items-center gap-3 rounded-xl px-3 py-2 text-left", on && "bg-pane-selected")}
                          >
                            <Avatar name={s.name || s.email} email={s.email} className="size-8 rounded-[10px] text-[10.5px]" />
                            <span className="min-w-0 flex-1" data-sensitive>
                              <span className="block truncate text-[13.5px] font-medium">{s.name || s.email}</span>
                              <span className="block truncate text-[12px] text-pane-muted">{s.email}</span>
                            </span>
                            <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">
                              {s.emails} email{s.emails === 1 ? "" : "s"}
                              {sent ? " sent" : ""} · {formatListDate(s.lastDate)}
                            </span>
                            <span className={cn("grid size-5 shrink-0 place-items-center rounded-full border transition-colors", on ? "border-accent bg-accent text-accent-fg" : "border-pane-border")}>
                              {on ? <Icon icon={Tick02Icon} size={11} /> : null}
                            </span>
                          </button>
                        );
                      })}
                  </FluidList>
                )}
                {when !== "schedule" && !starter?.bySearch ? (
                  <details className="mt-4 text-[12.5px] text-pane-muted" open={!!starter?.query}>
                    <summary className="cursor-pointer select-none hover:text-pane-fg">Narrow it with words too (optional)</summary>
                    <input
                      value={words}
                      onChange={(e) => setWords(e.target.value)}
                      placeholder="subject:statement, or words in the email (OR for either)"
                      className={cn(inputClass, "mt-2 h-9 w-full")}
                    />
                  </details>
                ) : null}
              </>
            ) : null}

            {step === 1 && when === "schedule" ? (
              <>
                <Title title="When should it run?" line="Kite runs it once on that day while it's open (or as soon as it next opens)." />
                <div className="rounded-2xl border border-pane-border p-4">
                  <ScheduleEditor value={schedule} onChange={setSchedule} />
                </div>
              </>
            ) : step === 1 ? (
              <>
                <Title
                  title="Click what Kite should read"
                  line={
                    wants.length
                      ? `In this email, click ${wants.map((w) => `the ${w.toLowerCase()}`).join(", ").replace(/, ([^,]*)$/, " and $1")}. Or select any other text to read it too.`
                      : fields.length
                        ? `Kite already reads ${fields.map((f) => f.name.toLowerCase()).join(", ").replace(/, ([^,]*)$/, " and $1")}. Click anything else you want in the list.`
                        : "Amounts, dates, codes and links are highlighted: click the ones you want. Select any other text (a shop, a name) to read it too."
                  }
                />
                {!examples ? (
                  <div className="grid h-40 place-items-center text-pane-muted">
                    <Spinner size={18} />
                  </div>
                ) : !example ? (
                  <p className="rounded-2xl bg-pane-2 px-4 py-6 text-center text-[13px] text-pane-muted">
                    {when === "sent" ? "None of these in your sent mail on this computer yet." : "No emails from them on this computer yet."} You can still go on: the automation reads them as they come.
                  </p>
                ) : (
                  <>
                    <ExampleCard
                      example={example}
                      fields={fields}
                      nextName={nextName}
                      onPick={pick}
                      onSelect={setSelection}
                      count={examples.length}
                      at={Math.min(shownAt, examples.length - 1)}
                      onShow={setShownAt}
                    />
                    <AnimatePresence>
                      {selection ? (
                        <motion.div {...blurFade({ y: 6, blur: 4 })} className="mt-2 flex flex-wrap items-center gap-2 rounded-xl bg-pane-fg px-3 py-2 text-[12.5px] text-pane">
                          <span className="min-w-0 truncate">
                            Read “<span data-sensitive>{selection.slice(0, 60)}</span>”{nextName ? ` as ${nextName}` : ""}?
                          </span>
                          <button onClick={readSelection} className="ml-auto h-7 rounded-full bg-pane px-3 font-medium text-pane-fg">
                            Read it
                          </button>
                          <button onClick={() => setSelection(null)} className="h-7 rounded-full px-2 opacity-70 hover:opacity-100">
                            Not this
                          </button>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </>
                )}
                {fields.length && examples?.length ? (
                  <ReadTable fields={fields} examples={examples} onRename={(i, n) => setFields(fields.map((f, j) => (j === i ? { ...f, name: n } : f)))} onRemove={(i) => setFields(fields.filter((_, j) => j !== i))} />
                ) : null}
              </>
            ) : null}

            {step === 2 ? (
              <>
                <Title
                  title="What should happen?"
                  line={
                    when === "schedule"
                      ? "Each time it runs."
                      : when === "sent"
                        ? "Switch on as many as you like. Each one happens to every email you send that matches."
                        : "Switch on as many as you like. Each one happens to every new email that matches."
                  }
                />
                <div className="flex flex-col gap-2">
                  {when === "schedule" ? (
                    <>
                      {!packOnly ? (
                        <Choice
                          on={choices.expect.on}
                          onChange={(on) => set({ expect: { ...choices.expect, on } })}
                          title="Ask each of them, and wait"
                          line="Waiting on shows who has sent theirs and who hasn't. Their email back settles it."
                        >
                          <ExpectEditor trigger="schedule" action={choices.expect.action} onChange={(a) => set({ expect: { ...choices.expect, action: a as ExpectAction } })} />
                        </Choice>
                      ) : null}
                      {packOnly ? (
                        <Choice on={choices.pack.on} onChange={(on) => set({ pack: { ...choices.pack, on } })} title="Pack the list for your accountant" line="Every file attached; emails that only had a link listed to download.">
                          <input
                            value={choices.pack.action.subject}
                            onChange={(e) => set({ pack: { ...choices.pack, action: { ...choices.pack.action, subject: e.target.value } } })}
                            placeholder="Invoices for {period}"
                            aria-label="Subject"
                            className={cn(inputClass, "w-full")}
                          />
                          <label className="flex items-center justify-between gap-3 rounded-lg bg-pane-2 px-3 py-2 text-[12px] text-pane-muted">
                            {choices.pack.action.auto ? "Sent by itself on the day." : "Waits in Drafts for you to look over and send."}
                            <Switch value={choices.pack.action.auto} label="Send it by itself" size="sm" onChange={(auto) => set({ pack: { ...choices.pack, action: { ...choices.pack.action, auto } } })} />
                          </label>
                        </Choice>
                      ) : null}
                    </>
                  ) : (
                    <>
                      <Choice on={choices.collect.on} onChange={(on) => set({ collect: { ...choices.collect, on } })} title="Keep a list" line="Each email becomes a row, with what was read. Amounts get monthly totals, dates a coming-up list.">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <input value={choices.collect.name} onChange={(e) => set({ collect: { ...choices.collect, name: e.target.value } })} placeholder="Name the list" className={cn(inputClass, "w-56")} />
                          {fields.length ? (
                            <Select
                              label="Rows"
                              value={choices.collect.match ?? ""}
                              options={[{ value: "", label: "a row per email" }, ...fields.map((f) => ({ value: f.key, label: `one row per ${f.name.toLowerCase()}` }))]}
                              onChange={(match) => set({ collect: { ...choices.collect, match: match || null } })}
                            />
                          ) : null}
                        </span>
                      </Choice>
                      <Choice
                        on={choices.expect.on}
                        onChange={(on) => set({ expect: { ...choices.expect, on } })}
                        title={when === "sent" ? "Wait for an answer" : "Wait for something back"}
                        line={when === "sent" ? "If they don't answer in time, a nudge is ready in Waiting on and in the conversation." : "If nothing comes back in time, a nudge is ready."}
                      >
                        <ExpectEditor trigger={when} action={choices.expect.action} onChange={(a) => set({ expect: { ...choices.expect, action: a as ExpectAction } })} />
                      </Choice>
                      <Choice
                        on={choices.remind.on && dateFields.length > 0}
                        disabled={!dateFields.length}
                        onChange={(on) => set({ remind: { ...choices.remind, on, field: choices.remind.field || dateFields[0]?.key || "" } })}
                        title="Bring it back before a date"
                        line={dateFields.length ? "The email leaves your inbox and comes back when it's time to act." : "Read a date in step 2 to use this."}
                      >
                        <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-pane-muted">
                          <input
                            type="number"
                            min={0}
                            max={60}
                            value={choices.remind.daysBefore}
                            onChange={(e) => set({ remind: { ...choices.remind, daysBefore: Math.max(0, Math.min(60, Number(e.target.value) || 0)) } })}
                            className={cn(inputClass, "w-14 tabular-nums")}
                          />
                          days before
                          <Select label="Date" value={choices.remind.field || dateFields[0]?.key || ""} options={dateFields.map((f) => ({ value: f.key, label: f.name }))} onChange={(field) => set({ remind: { ...choices.remind, field } })} />
                        </span>
                      </Choice>
                      <Choice
                        on={choices.calendar.on && dateFields.length > 0}
                        disabled={!dateFields.length}
                        onChange={(on) => set({ calendar: { ...choices.calendar, on, field: choices.calendar.field || dateFields[0]?.key || "" } })}
                        title="Put it on my calendar"
                        line={dateFields.length ? "An event in Kite's calendar on that date." : "Read a date in step 2 to use this."}
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <input value={choices.calendar.title} onChange={(e) => set({ calendar: { ...choices.calendar, title: e.target.value } })} placeholder="Title, like Pay {amount}" className={cn(inputClass, "w-60")} />
                          <Select label="Date" value={choices.calendar.field || dateFields[0]?.key || ""} options={dateFields.map((f) => ({ value: f.key, label: f.name }))} onChange={(field) => set({ calendar: { ...choices.calendar, field } })} />
                        </span>
                      </Choice>
                      {when === "new_mail" ? <Choice on={choices.notify} onChange={(notify) => set({ notify })} title="Tell me straight away" line="A notification the moment one arrives." /> : null}
                      <Choice
                        on={choices.archive}
                        onChange={(archive) => set({ archive })}
                        title={when === "sent" ? "File the conversation" : "Skip the inbox"}
                        line={starter?.delay ? `After ${waitText(starter.delay)} in your inbox (still in All mail and your list).` : "Filed straight away (still in All mail and your list)."}
                      />
                      <Choice
                        on={choices.space.on}
                        onChange={(on) => set({ space: { ...choices.space, on } })}
                        title="Put it in a space"
                        line="Kite's own place for it, beside the rest of that client or job. Only in Kite."
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <SpacePick value={choices.space.id} onChange={(id) => set({ space: { on: true, id } })} />
                        </span>
                      </Choice>
                      {when === "new_mail" ? <Choice on={choices.markRead} onChange={(markRead) => set({ markRead })} title="Mark it read" /> : null}
                      <Choice on={choices.star} onChange={(star) => set({ star })} title="Star it" />
                      {choices.extras.map((extra, i) => (
                        <Choice
                          key={i}
                          on={extra.on}
                          onChange={(on) => set({ extras: choices.extras.map((x, j) => (j === i ? { ...x, on } : x)) })}
                          title={describeAction(extra.action)}
                        />
                      ))}
                      {when === "new_mail" ? (
                        <Choice on={choices.reply.on} onChange={(on) => set({ reply: { ...choices.reply, on } })} title="Prepare a reply" line="Waits in the quick reply for you to send. Never sent by itself.">
                          <textarea
                            value={choices.reply.template}
                            onChange={(e) => set({ reply: { ...choices.reply, template: e.target.value } })}
                            rows={3}
                            className="w-full rounded-xl border border-pane-border bg-transparent px-3 py-2 text-[12.5px] outline-none focus:border-accent/60"
                          />
                          <span className="text-[11.5px] text-pane-muted">Blanks: {["first_name", "subject", ...fields.map((f) => f.key)].map((k) => `{${k}}`).join(" ")}</span>
                        </Choice>
                      ) : null}
                      {fields.length ? (
                        <Choice
                          on={choices.check.on}
                          onChange={(on) => set({ check: { ...choices.check, on, field: choices.check.field || fields[0].key, op: opsFor(fields.find((f) => f.key === (choices.check.field || fields[0].key))?.type)[0] } })}
                          title="Only some of them"
                          line="Do all this only when what was read passes a check."
                        >
                          <CheckRow fields={fields} check={choices.check} onChange={(check) => set({ check })} />
                        </Choice>
                      ) : null}
                    </>
                  )}
                </div>
              </>
            ) : null}

            {step === 3 ? (
              <>
                <Title
                  title="Name it and switch it on"
                  line={when === "schedule" ? `It runs ${describeSchedule(schedule).toLowerCase()}. You can change any of it later.` : `It runs on ${when === "sent" ? "mail you send" : "new mail"} from now on. You can change any of it later.`}
                />
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Name, like Bills"
                  className="h-12 w-full rounded-2xl border border-pane-border bg-transparent px-4 text-[17px] font-medium outline-none focus:border-accent/60"
                />
                <Summary draft={draft()} senders={chosen} fields={fields} />
                {live ? (
                  <label className="mt-4 flex items-center justify-between gap-3 rounded-2xl bg-pane-2 px-4 py-3">
                    <span>
                      <span className="block text-[13.5px] font-medium">{when === "schedule" ? "Also run it now, for this period" : "Also do it for the last 30 days"}</span>
                      <span className="block text-[12px] text-pane-muted">
                        {when === "schedule"
                          ? packOnly
                            ? "Makes this month's pack now."
                            : "Asks everyone now instead of waiting for the day. Nothing goes out without you unless you switched that on."
                          : "Fills your list now from mail already here. Waiting and nudges only start with new mail. You can undo it in Activity."}
                      </span>
                    </span>
                    <Switch value={fill} label="Run it now too" onChange={setFill} />
                  </label>
                ) : (
                  <p className="mt-4 rounded-2xl bg-pane-2 px-4 py-3 text-[12.5px] text-pane-muted">This is the demo, so it&apos;s saved but nothing runs. Connect your mail and it works on real email.</p>
                )}
              </>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>

      <footer className="flex shrink-0 items-center gap-2 border-t border-pane-border px-5 py-3">
        {step > 0 ? (
          <button onClick={() => go((step - 1) as StepId)} className="flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
            <Icon icon={ArrowLeft01Icon} size={14} />
            Back
          </button>
        ) : null}
        <span className="flex-1 text-[12px] text-pane-muted">
          {step === 0 && chosen.length
            ? `${chosen.length} ${when === "new_mail" ? "sender" : "person"}${chosen.length === 1 ? "" : when === "new_mail" ? "s" : ""}`.replace(/persons$/, "people")
            : step === 1 && fields.length && when !== "schedule"
              ? `Reading ${fields.map((f) => f.name.toLowerCase()).join(", ")}`
              : step === 2
                ? `${doCount} on`
                : ""}
        </span>
        {step < 3 ? (
          <button
            onClick={() => go((step + 1) as StepId)}
            disabled={!canNext}
            className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-medium text-accent-fg transition-[filter] duration-150 hover:brightness-110 disabled:opacity-40"
          >
            {step === 1 && when !== "schedule" && !fields.length ? "Skip, read nothing" : "Next"}
            <Icon icon={ArrowRight01Icon} size={14} />
          </button>
        ) : (
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex h-9 items-center gap-2 rounded-full bg-accent px-5 text-[13px] font-medium text-accent-fg transition-[filter] duration-150 hover:brightness-110 disabled:opacity-70"
          >
            {saving ? <Spinner size={13} /> : null}
            {saving ? "Saving" : "Save and switch on"}
          </button>
        )}
      </footer>
    </section>
  );
}

function Title({ title, line }: { title: string; line: string }) {
  return (
    <div className="mb-5">
      <h2 className="text-[26px] font-medium leading-tight tracking-[-0.04em]">{title}</h2>
      <p className="mt-1.5 max-w-[600px] text-[13.5px] leading-relaxed text-pane-muted">{line}</p>
    </div>
  );
}

/** A real email with its values highlighted: click one to read it, select any text to read that. */
function ExampleCard({
  example,
  fields,
  nextName,
  onPick,
  onSelect,
  count,
  at,
  onShow,
}: {
  example: AutomationExample;
  fields: FieldSpec[];
  nextName?: string;
  onPick: (p: Pickable) => void;
  onSelect: (text: string | null) => void;
  count: number;
  at: number;
  onShow: (i: number) => void;
}) {
  const picks = useMemo(() => pickables(example.text), [example.text]);
  const pickedBy = (p: Pickable) => fields.find((f) => f.from.kind === "after" && f.from.label === p.label && f.type === p.type);
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  picks.forEach((p, i) => {
    if (p.start > cursor) parts.push(example.text.slice(cursor, p.start));
    const field = pickedBy(p);
    parts.push(
      <button
        key={i}
        onClick={() => onPick(p)}
        title={field ? `Reading as ${field.name}. Click to stop.` : `Read this ${FIELD_TYPE_NAMES[p.type].toLowerCase()}${nextName ? ` as ${nextName}` : ""}`}
        className={cn(
          "relative mx-px rounded-md px-1 py-px font-medium transition-colors duration-150",
          field ? "bg-accent text-accent-fg" : "bg-lime/60 text-lime-fg hover:bg-lime",
        )}
      >
        {p.text}
        {field ? <span className="absolute -top-4 left-0 whitespace-nowrap rounded bg-accent px-1 text-[9.5px] font-semibold uppercase tracking-wide text-accent-fg">{field.name}</span> : null}
      </button>,
    );
    cursor = p.end;
  });
  if (cursor < example.text.length) parts.push(example.text.slice(cursor));
  return (
    <div className="rounded-2xl border border-pane-border bg-pane shadow-[0_10px_30px_-20px_rgb(10_30_60/0.35)]">
      <div className="flex items-center gap-3 border-b border-pane-border px-4 py-3">
        <Avatar name={example.sender} email={example.senderEmail} className="size-8 rounded-[10px] text-[10.5px]" />
        <div className="min-w-0 flex-1" data-sensitive>
          <p className="truncate text-[13.5px] font-semibold">{example.subject}</p>
          <p className="truncate text-[12px] text-pane-muted">
            {example.sender} · {format(new Date(example.date), "d MMM yyyy, HH:mm")}
          </p>
        </div>
        {count > 1 ? (
          <span className="flex shrink-0 items-center gap-1 text-[12px] text-pane-muted">
            <button aria-label="Newer example" disabled={at === 0} onClick={() => onShow(at - 1)} className="grid size-7 place-items-center rounded-full hover:bg-pane-hover disabled:opacity-30">
              <Icon icon={ArrowLeft01Icon} size={13} />
            </button>
            <span className="tabular-nums">
              {at + 1} of {count}
            </span>
            <button aria-label="Older example" disabled={at >= count - 1} onClick={() => onShow(at + 1)} className="grid size-7 place-items-center rounded-full hover:bg-pane-hover disabled:opacity-30">
              <Icon icon={ArrowRight01Icon} size={13} />
            </button>
          </span>
        ) : null}
      </div>
      <div
        data-sensitive
        onMouseUp={() => {
          const text = getSelection()?.toString().trim() ?? "";
          onSelect(text.length >= 2 && text.length <= 120 && !text.includes("\n") ? text : null);
        }}
        className="max-h-[360px] overflow-y-auto whitespace-pre-wrap px-5 pb-5 pt-6 font-reading text-[13.5px] leading-[1.9]"
      >
        {parts}
      </div>
    </div>
  );
}

/** How the fields read every example: proof it works beyond the one clicked. */
function ReadTable({ fields, examples, onRename, onRemove }: { fields: FieldSpec[]; examples: AutomationExample[]; onRename: (i: number, name: string) => void; onRemove: (i: number) => void }) {
  const rows = examples.map((e) => ({ e, values: readFields(fields, factsOfExample(e)) }));
  return (
    <div className="mt-5">
      <div className="mb-2 flex flex-wrap gap-1.5">
        {fields.map((f, i) => {
          const found = rows.filter((r) => r.values[f.key]).length;
          return (
            <span key={f.key} className="flex h-8 items-center gap-1.5 rounded-full border border-pane-border pl-3 pr-1.5 text-[12.5px]">
              <input value={f.name} onChange={(e) => onRename(i, e.target.value)} aria-label="Field name" className="w-28 bg-transparent font-medium outline-none" />
              <span className={cn("tabular-nums", found === rows.length ? "text-success" : "text-warning")}>
                {found}/{rows.length}
              </span>
              <button aria-label={`Stop reading ${f.name}`} onClick={() => onRemove(i)} className="grid size-5 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
                <Icon icon={Cancel01Icon} size={10} />
              </button>
            </span>
          );
        })}
      </div>
      <div className="overflow-x-auto rounded-2xl border border-pane-border">
        <table className="w-full min-w-[480px] text-left text-[12.5px]">
          <thead>
            <tr className="bg-pane-2 text-[11px] uppercase tracking-[0.06em] text-pane-muted">
              <th className="px-3 py-2 font-semibold">Email</th>
              {fields.map((f) => (
                <th key={f.key} className="px-3 py-2 font-semibold">
                  {f.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody data-sensitive>
            {rows.map(({ e, values }) => (
              <tr key={`${e.threadId}:${e.date}`} className="border-t border-pane-border">
                <td className="max-w-56 truncate px-3 py-2 text-pane-muted">{e.subject}</td>
                {fields.map((f) => (
                  <td key={f.key} className={cn("max-w-48 truncate px-3 py-2", values[f.key] ? "font-medium" : "text-pane-muted/60")}>
                    {values[f.key]?.text ?? "not found"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Choice({ on, disabled, onChange, title, line, children }: { on: boolean; disabled?: boolean; onChange: (on: boolean) => void; title: string; line?: string; children?: React.ReactNode }) {
  return (
    <div className={cn("rounded-2xl border px-4 py-3 transition-colors duration-150", on ? "border-accent/40 bg-accent-soft/40" : "border-pane-border", disabled && "opacity-60")}>
      <label className="flex items-center gap-3">
        <span className="min-w-0 flex-1">
          <span className="block text-[13.5px] font-medium">{title}</span>
          {line ? <span className="block text-[12px] text-pane-muted">{line}</span> : null}
        </span>
        <Switch value={on} disabled={disabled} label={title} onChange={onChange} />
      </label>
      <AnimatePresence initial={false}>
        {on && children ? (
          <motion.div {...blurFade({ y: -4, blur: 4 })} className="mt-2.5 flex flex-col gap-1.5">
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const OPS: Record<CheckOp, string> = {
  is: "is",
  is_not: "isn't",
  contains: "contains",
  not_contains: "doesn't contain",
  more: "is more than",
  less: "is less than",
  within_days: "is within the next (days)",
  present: "was found",
  missing: "wasn't found",
};

function CheckRow({ fields, check, onChange }: { fields: FieldSpec[]; check: Choices["check"]; onChange: (c: Choices["check"]) => void }) {
  const field = fields.find((f) => f.key === check.field) ?? fields[0];
  const ops = opsFor(field.type);
  return (
    <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-pane-muted">
      Only when
      <Select label="Field" value={field.key} options={fields.map((f) => ({ value: f.key, label: f.name }))} onChange={(key) => onChange({ ...check, field: key, op: opsFor(fields.find((f) => f.key === key)?.type)[0] })} />
      <Select label="Comparison" value={ops.includes(check.op) ? check.op : ops[0]} options={ops.map((op) => ({ value: op, label: OPS[op] }))} onChange={(op) => onChange({ ...check, op })} />
      {check.op !== "present" && check.op !== "missing" ? (
        <input value={check.value} onChange={(e) => onChange({ ...check, value: e.target.value })} placeholder="1000" className={cn(inputClass, "w-24 tabular-nums")} />
      ) : null}
    </span>
  );
}

/** The finished automation in four lines, before it's saved. */
function Summary({ draft, senders, fields }: { draft: RuleDraft; senders: string[]; fields: FieldSpec[] }) {
  const who = senders.length === 1 ? senders[0] : `${senders.length} people`;
  const when =
    draft.when === "schedule" && draft.schedule
      ? `${describeSchedule(draft.schedule as Schedule)}${senders.length ? `, for ${who}` : ""}`
      : draft.when === "sent"
        ? `you send mail${senders.length ? ` to ${who}` : ""}${draft.query ? `${senders.length ? "," : ""} matching ${draft.query}` : ""}`
        : senders.length
          ? `${who} email${draft.query ? `, matching ${draft.query}` : ""}${draft.delay ? `, after ${waitText(draft.delay)}` : ""}`
          : `mail matching ${draft.query}`;
  const lines = [
    { label: "When", text: when },
    ...(fields.length ? [{ label: "Read", text: fields.map((f) => f.name).join(", ") }] : []),
    ...(draft.checks?.length ? [{ label: "If", text: `${fields.find((f) => f.key === draft.checks![0].field)?.name ?? ""} ${OPS[draft.checks[0].op]} ${draft.checks[0].value}`.trim() }] : []),
    {
      label: "Do",
      text: draft.actions
        .map((a) =>
          a.verb === "collect"
            ? `keep a list (${newCollectionName(a.collection) ?? "list"}${a.match ? `, one row per ${fields.find((f) => f.key === a.match)?.name.toLowerCase() ?? "thing"}` : ""})`
            : a.verb === "remind"
              ? `bring it back ${a.daysBefore} days before ${fields.find((f) => f.key === a.field)?.name.toLowerCase() ?? "the date"}`
              : a.verb === "calendar"
                ? "put it on my calendar"
                : a.verb === "notify"
                  ? "tell me straight away"
                  : a.verb === "archive"
                    ? "skip the inbox"
                    : a.verb === "mark_read"
                      ? "mark it read"
                      : a.verb === "star"
                        ? "star it"
                        : a.verb === "prepare_reply"
                          ? "prepare a reply"
                          : a.verb === "pack"
                            ? `pack the list for ${a.to || "your accountant"}${a.auto ? " and send it" : " (a draft)"}`
                            : describeAction(a as RuleAction).toLowerCase(),
        )
        .join(", "),
    },
  ];
  return (
    <ol className="mt-4 flex flex-col gap-2 rounded-2xl border border-pane-border px-4 py-3">
      {lines.map((l) => (
        <li key={l.label} className="flex items-baseline gap-3 text-[13px]">
          <span className="w-10 shrink-0 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-accent">{l.label}</span>
          <span className="min-w-0" data-sensitive>
            {l.text}
          </span>
        </li>
      ))}
    </ol>
  );
}
