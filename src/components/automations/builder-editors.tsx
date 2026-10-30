"use client";

import { useEffect, useState } from "react";
import { Cancel01Icon, Clock01Icon } from "@hugeicons/core-free-icons";
import type { FieldSpec } from "@/lib/automations/fields";
import type { CollectionSummary } from "@/lib/automations/collections";
import { newCollectionName } from "@/lib/automations/templates";
import { NUDGES, describeSchedule, describeAction, describeCondition, type RuleAction, type RuleView, type Schedule, type Trigger } from "@/lib/rules/spec";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { TimePicker } from "../ui/date-time-picker";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Spinner } from "../ui/spinner";
import { spaceLabel, spaceTree, type Space } from "@/lib/spaces";
import { SpaceDot } from "../mail/space-picker";
import { AddButton, RemoveButton, inputClass } from "./builder-ui";

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
    a.verb === "collect"
      ? `Add to ${collections.find((c) => c.id === a.collection)?.name ?? "a collection"}`
      : a.verb === "space"
        ? `Put in ${spaceNames.get(a.space) ?? "a space"}`
        : named(describeAction(a)),
  );
  return `${when} → ${actions.join(", ")}${rule.stop ? ", then stop" : ""}`;
}

/** 90 -> "90 minutes"; 60 -> "1 hour"; 1440 -> "1 day". */
export function waitText(minutes: number) {
  if (minutes % 1440 === 0) return `${minutes / 1440} day${minutes === 1440 ? "" : "s"}`;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minutes`;
}

/** "Wait before acting" choices, in minutes. */
export const WAIT_OPTIONS = [0, 15, 60, 240, 1440].map((m) => ({ value: String(m), label: m ? `Act after ${waitText(m)}` : "Act straight away" }));

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

/** Space names for summaries ("Put in Acme / Website"), filled the first time a picker loads them. */
const spaceNames = new Map<string, string>();

/** "Put in a space": one of Kite's spaces or pockets (made in the sidebar or with `y`). */
export function SpacePick({ value, onChange }: { value: string; onChange: (id: string) => void }) {
  const [spaces, setSpaces] = useState<Space[] | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/spaces")
      .then((res) => res.json())
      .then((data: { spaces?: Space[] }) => {
        if (!live) return;
        const list = data.spaces ?? [];
        for (const s of list) spaceNames.set(s.id, spaceLabel(list, s.id));
        setSpaces(list);
      })
      .catch(() => live && setSpaces([]));
    return () => {
      live = false;
    };
  }, []);
  if (!spaces) return <Spinner size={14} className="text-pane-muted" />;
  if (!spaces.length) return <span className="text-[12px] text-pane-muted">Make a space in the sidebar first (Spaces, +)</span>;
  const known = spaces.some((s) => s.id === value);
  return (
    <Select
      label="Space"
      value={known ? value : "__pick"}
      options={[
        ...(known ? [] : [{ value: "__pick", label: value ? "That space was deleted" : "Pick a space" }]),
        ...spaceTree(spaces).map(({ space, depth }) => ({
          value: space.id,
          label: `${"\u2003".repeat(depth)}${space.name}`,
          icon: <SpaceDot space={space} />,
          detail: depth ? spaceLabel(spaces, space.parentId!) : undefined,
        })),
      ]}
      onChange={(id) => id !== "__pick" && onChange(id)}
    />
  );
}

/** A date the automation read (or when the email came), for reminders and events. */
export function DateFieldPick({ value, fields, onChange }: { value: string; fields: FieldSpec[]; onChange: (key: string) => void }) {
  const dates = fields.filter((f) => f.type === "date");
  const options = [...dates.map((f) => ({ value: f.key, label: f.name })), { value: "received", label: "when it arrived" }];
  return <Select label="Date" value={options.some((o) => o.value === value) ? value : "__pick"} options={options.some((o) => o.value === value) ? options : [{ value: "__pick", label: "Pick a date" }, ...options]} onChange={(key) => key !== "__pick" && onChange(key)} />;
}
