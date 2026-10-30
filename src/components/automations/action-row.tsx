"use client";

import { useRef, useState } from "react";
import { Clock01Icon } from "@hugeicons/core-free-icons";
import { blanksIn, fillBlanks } from "@/lib/rules/prepared";
import type { FieldSpec } from "@/lib/automations/fields";
import type { CollectionSummary } from "@/lib/automations/collections";
import { bodyToText } from "@/lib/mail/body";
import { NOTIFY_MODES, defaultAction, type RuleAction, type SnoozeFor, type Trigger } from "@/lib/rules/spec";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { TimePicker } from "../ui/date-time-picker";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { FormatBar, RichEditor, type FormatState, type RichEditorHandle } from "../mail/rich-editor";
import { type Blank, RemoveButton, inputClass, verbOptions } from "./builder-ui";
import { CollectionPick, DateFieldPick, ExpectEditor, SpacePick } from "./builder-editors";

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

export function ActionRow({
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
      {action.verb === "space" ? <SpacePick value={action.space} onChange={(space) => onChange({ ...action, space })} /> : null}
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
