"use client";

import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import {
  BUILTINS,
  BUILTIN_NAMES,
  FIELD_TYPES,
  FIELD_TYPE_NAMES,
  keyFor,
  opsFor,
  type CheckOp,
  type FieldCheck,
  type FieldSpec,
  type FieldValues,
} from "@/lib/automations/fields";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Select } from "../ui/select";
import { Tooltip } from "../ui/tooltip";

// The builder's Read and Check steps (lib/automations/fields.ts). Read: each field is a name, a
// type and where it comes from, with what it found in the newest matching email beside it. Check:
// one field, a comparison that suits its type, and a value.

export const inputClass = "h-8 min-w-0 rounded-full border border-pane-border bg-transparent px-3 text-[12.5px] outline-none placeholder:text-pane-muted focus:border-accent/60";

type SourceKind = "after" | "first" | "pattern" | "fixed" | `builtin:${(typeof BUILTINS)[number]}`;

/** For mail you send, the "sender" fields read who it went to. */
const SENT_NAMES: Partial<Record<(typeof BUILTINS)[number], string>> = { sender_name: "Their name", sender_email: "Their address", received: "When you sent it" };

const sourceOptions = (sent: boolean): { value: SourceKind; label: string }[] => [
  { value: "after", label: "after the words" },
  { value: "first", label: "first one in the email" },
  { value: "pattern", label: "matching a pattern" },
  { value: "fixed", label: "always the same value" },
  ...BUILTINS.map((b) => ({ value: `builtin:${b}` as SourceKind, label: ((sent && SENT_NAMES[b]) || BUILTIN_NAMES[b]).toLowerCase() })),
];

const sourceKind = (f: FieldSpec): SourceKind => (f.from.kind === "builtin" ? `builtin:${f.from.builtin}` : f.from.kind);

function withSource(f: FieldSpec, kind: SourceKind): FieldSpec {
  if (kind.startsWith("builtin:")) {
    const builtin = kind.slice(8) as (typeof BUILTINS)[number];
    return { ...f, type: builtin === "received" ? "date" : builtin === "sender_email" ? "email" : "text", from: { kind: "builtin", builtin } };
  }
  if (kind === "after") return { ...f, from: { kind: "after", label: f.from.kind === "after" ? f.from.label : "" } };
  if (kind === "pattern") return { ...f, from: { kind: "pattern", pattern: f.from.kind === "pattern" ? f.from.pattern : "" } };
  if (kind === "fixed") return { ...f, type: "text", from: { kind: "fixed", value: f.from.kind === "fixed" ? f.from.value : "" } };
  return { ...f, type: f.type === "text" ? "money" : f.type, from: { kind: "first" } };
}

/** A new field: "Amount", the first amount in the email. */
function newField(taken: string[]): FieldSpec {
  const names = ["Amount", "Date", "Reference", "Link", "Code"];
  const name = names.find((n) => !taken.includes(keyFor(n))) ?? "Value";
  return { key: keyFor(name, taken), name, type: "money", from: { kind: "after", label: "" } };
}

/** `sample`: what Read found in the newest matching email (undefined while looking, null when nothing matches yet). */
export function FieldsEditor({ fields, sample, sent = false, onChange }: { fields: FieldSpec[]; sample?: FieldValues | null; sent?: boolean; onChange: (fields: FieldSpec[]) => void }) {
  const set = (i: number, next: FieldSpec) => onChange(fields.map((f, j) => (j === i ? next : f)));
  return (
    <div className="flex flex-col gap-2">
      {fields.map((f, i) => {
        const found = sample ? sample[f.key] : null;
        return (
          <div key={i} className="flex min-w-0 flex-col gap-1.5 rounded-xl border border-pane-border bg-pane-2/40 p-2.5">
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <input
                value={f.name}
                onChange={(e) => {
                  const name = e.target.value;
                  // The key follows the name until it's used elsewhere; renaming keeps blanks readable.
                  set(i, { ...f, name, key: keyFor(name || "field", fields.filter((_, j) => j !== i).map((x) => x.key)) });
                }}
                placeholder="Name, like Amount"
                aria-label="Field name"
                className={cn(inputClass, "w-36 font-medium")}
              />
              <span className="text-[12px] text-pane-muted">is the</span>
              {f.from.kind === "builtin" || f.from.kind === "fixed" ? null : (
                <Select label="Type" value={f.type} options={FIELD_TYPES.map((t) => ({ value: t, label: FIELD_TYPE_NAMES[t].toLowerCase() }))} onChange={(type) => set(i, { ...f, type })} />
              )}
              <Select label="Where" value={sourceKind(f)} options={sourceOptions(sent)} onChange={(kind) => set(i, withSource(f, kind))} />
              {f.from.kind === "fixed" ? (
                <input
                  value={f.from.value}
                  onChange={(e) => set(i, { ...f, from: { kind: "fixed", value: e.target.value } })}
                  placeholder="Applied"
                  aria-label="The value"
                  className={cn(inputClass, "w-32")}
                />
              ) : null}
              {f.from.kind === "after" ? (
                <input
                  value={f.from.label}
                  onChange={(e) => set(i, { ...f, from: { kind: "after", label: e.target.value } })}
                  placeholder="Amount due"
                  aria-label="The words before the value"
                  className={cn(inputClass, "w-40")}
                />
              ) : null}
              {f.from.kind === "pattern" ? (
                <input
                  value={f.from.pattern}
                  onChange={(e) => set(i, { ...f, from: { kind: "pattern", pattern: e.target.value } })}
                  placeholder="Order #(\d+)"
                  aria-label="Pattern"
                  spellCheck={false}
                  className={cn(inputClass, "w-44 tabular-nums")}
                />
              ) : null}
              <Tooltip label="Remove this field">
                <button
                  aria-label="Remove this field"
                  onClick={() => onChange(fields.filter((_, j) => j !== i))}
                  className="ml-auto grid size-7 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                >
                  <Icon icon={Cancel01Icon} size={12} />
                </button>
              </Tooltip>
            </div>
            <div className="flex min-w-0 items-center gap-2 px-1 text-[11.5px]">
              <span className="rounded-full bg-pane px-1.5 py-px tabular-nums text-pane-muted shadow-[inset_0_0_0_1px_var(--pane-border)]">{`{${f.key}}`}</span>
              {sample === undefined ? (
                <span className="text-pane-muted">Looks for it in the newest matching email…</span>
              ) : sample === null ? (
                <span className="text-pane-muted">No matching email in the last 30 days to try it on yet</span>
              ) : found ? (
                <span className="min-w-0 truncate" data-sensitive>
                  <span className="text-pane-muted">Found </span>
                  <span className="font-medium text-success">{found.text}</span>
                </span>
              ) : (
                <span className="text-warning">Not found in the newest matching email</span>
              )}
            </div>
          </div>
        );
      })}
      {fields.length < 12 ? (
        <button
          onClick={() => onChange([...fields, newField(fields.map((f) => f.key))])}
          className="flex items-center gap-1 self-start rounded-full py-0.5 text-[12px] font-medium text-accent transition-opacity hover:opacity-80"
        >
          <Icon icon={Add01Icon} size={12} />
          Read a value
        </button>
      ) : null}
    </div>
  );
}

const OP_NAMES: Record<CheckOp, string> = {
  is: "is",
  is_not: "isn't",
  contains: "contains",
  not_contains: "doesn't contain",
  more: "is more than",
  less: "is less than",
  within_days: "is within the next",
  present: "was found",
  missing: "wasn't found",
};

export function ChecksEditor({ checks, fields, onChange }: { checks: FieldCheck[]; fields: FieldSpec[]; onChange: (checks: FieldCheck[]) => void }) {
  if (!fields.length) return <p className="text-[12px] text-pane-muted">Read a value above to check it here, like: only bills over R 1 000.</p>;
  const set = (i: number, next: FieldCheck) => onChange(checks.map((c, j) => (j === i ? next : c)));
  return (
    <div className="flex flex-col gap-1.5">
      {checks.map((c, i) => {
        const type = fields.find((f) => f.key === c.field)?.type;
        const ops = opsFor(type);
        const needsValue = c.op !== "present" && c.op !== "missing";
        return (
          <div key={i} className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="w-10 text-[12px] text-pane-muted">{i === 0 ? "Only if" : "and"}</span>
            <Select
              label="Field"
              value={fields.some((f) => f.key === c.field) ? c.field : fields[0].key}
              options={fields.map((f) => ({ value: f.key, label: f.name }))}
              onChange={(field) => {
                const nextOps = opsFor(fields.find((f) => f.key === field)?.type);
                set(i, { ...c, field, op: nextOps.includes(c.op) ? c.op : nextOps[0] });
              }}
            />
            <Select label="Comparison" value={ops.includes(c.op) ? c.op : ops[0]} options={ops.map((op) => ({ value: op, label: OP_NAMES[op] }))} onChange={(op) => set(i, { ...c, op })} />
            {needsValue ? (
              <input
                value={c.value}
                onChange={(e) => set(i, { ...c, value: e.target.value })}
                placeholder={c.op === "within_days" ? "7" : type === "money" || type === "number" ? "1000" : "text"}
                aria-label="Value"
                className={cn(inputClass, c.op === "within_days" || type === "money" || type === "number" ? "w-20 tabular-nums" : "w-40")}
              />
            ) : null}
            {c.op === "within_days" ? <span className="text-[12px] text-pane-muted">days</span> : null}
            <Tooltip label="Remove this check">
              <button
                aria-label="Remove this check"
                onClick={() => onChange(checks.filter((_, j) => j !== i))}
                className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
              >
                <Icon icon={Cancel01Icon} size={12} />
              </button>
            </Tooltip>
          </div>
        );
      })}
      {checks.length < 8 ? (
        <button
          onClick={() => {
            const first = fields[0];
            onChange([...checks, { field: first.key, op: opsFor(first.type)[0], value: "" }]);
          }}
          className="flex items-center gap-1 self-start rounded-full py-0.5 text-[12px] font-medium text-accent transition-opacity hover:opacity-80"
        >
          <Icon icon={Add01Icon} size={12} />
          Add a check
        </button>
      ) : null}
    </div>
  );
}
