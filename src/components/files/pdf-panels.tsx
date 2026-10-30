"use client";

import { useState } from "react";
import { Cancel01Icon, SquareLock02Icon, UserIcon } from "@hugeicons/core-free-icons";
import { type FieldValue, type FormInfo, type Placed } from "@/lib/pdf/fill";
import { type Filled } from "@/lib/pdf/autofill";
import { type Blank } from "@/lib/pdf/labels";
import { asToday, formName, MIN_PRINT_LINES, type Layout, type LayoutSpec, type PageSizes } from "@/lib/pdf/layout";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { type FileRef } from "./file-preview";

export type Print = { pages: PageSizes; lines: string[] };

/** What "Fill from my profile" did, for the note, Undo and the highlights. */
export type ProfileFill = {
  filled: Filled[];
  total: number;
  values: Record<string, FieldValue>;
  itemIds: string[];
  /** Field names left empty when it ran (highlighted while still empty). */
  emptyFields: string[];
  emptyBlanks: Blank[];
};

/** Who sent the form, as the user knows them. */
export function senderLabel(file: FileRef) {
  const from = file.from;
  return from ? (from.name && from.name !== from.email ? from.name : from.email) : "";
}

function plural(n: number, one: string, many: string) {
  return n === 1 ? one : `${n} ${many}`;
}

/**
 * "Remember for <sender>": positions of the signature, ticks and dates are always kept; values
 * only per field the user ticks (a job number changes every time, a name doesn't). Dates are kept as "today".
 */
export function RememberPanel({
  file,
  sender,
  print,
  info,
  values,
  items,
  flatten,
  onCancel,
  onSaved,
}: {
  file: FileRef;
  sender: string;
  print: Print;
  info: FormInfo | null;
  values: Record<string, FieldValue>;
  items: Placed[];
  flatten: boolean;
  onCancel: () => void;
  onSaved: (layout: Layout) => void;
}) {
  const [name, setName] = useState(() => formName(file.attachment.name));
  const [ticked, setTicked] = useState<Set<string>>(() => new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const recognisable = new Set(print.lines).size >= MIN_PRINT_LINES;

  const fields = new Map((info?.fields ?? []).map((f) => [f.name, f]));
  const choices = [
    ...Object.entries(values).flatMap(([field, value]) => {
      const f = fields.get(field);
      if (!f || value === "" || value === false) return [];
      const today = asToday(value, new Date(), f.dateFormat);
      const shown = today ? "today's date" : value === true ? "ticked" : String(value);
      return [{ key: `field:${field}`, label: f.label ?? f.name, shown }];
    }),
    ...items.flatMap((i) =>
      i.kind === "text" && i.text?.trim() ? [{ key: `item:${i.id}`, label: `Text on page ${i.page + 1}`, shown: i.text.trim() }] : [],
    ),
  ];
  const kept = [
    items.some((i) => i.kind === "signature") ? "your signature" : null,
    items.some((i) => i.kind === "date") ? "the date (as today's)" : null,
    items.some((i) => i.kind === "tick") ? plural(items.filter((i) => i.kind === "tick").length, "the tick", "ticks") : null,
  ].filter((s): s is string => !!s);

  const toggle = (key: string) =>
    setTicked((set) => {
      const next = new Set(set);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    const spec: LayoutSpec = {
      version: 1,
      items: items.flatMap((i) => {
        const box = { kind: i.kind, page: i.page, x: i.x, y: i.y, w: i.w, h: i.h };
        if (i.kind !== "text") return [box];
        return ticked.has(`item:${i.id}`) && i.text?.trim() ? [{ ...box, text: i.text.trim() }] : [];
      }),
      values: Object.entries(values).flatMap(([field, value]) => {
        if (!ticked.has(`field:${field}`)) return [];
        const today = asToday(value, new Date(), fields.get(field)?.dateFormat);
        return [today ? { field, today } : { field, value }];
      }),
      flatten,
    };
    try {
      const res = await fetch("/api/fill-sign/layouts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, ...print, name: name.trim() || formName(file.attachment.name), spec }),
      });
      const body = (await res.json().catch(() => ({}))) as { layout?: Layout; error?: string };
      if (!res.ok || !body.layout) throw new Error(body.error ?? "Kite couldn't remember this layout. Try again.");
      onSaved(body.layout);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kite couldn't remember this layout. Try again.");
      setSaving(false);
    }
  };

  if (!recognisable) {
    return (
      <div className="blur-fade flex flex-wrap items-center gap-2 border-b border-pane-border bg-pane-2 px-4 py-2.5 text-[12.5px]">
        <p className="min-w-0 flex-1 text-pane-muted">
          This PDF has too little printed text for Kite to recognise it next time (scanned forms look like pictures), so there&apos;s nothing to remember.
        </p>
        <button onClick={onCancel} className="h-7 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
          OK
        </button>
      </div>
    );
  }

  return (
    <div className="blur-fade flex flex-col gap-2.5 border-b border-pane-border bg-pane-2 px-4 py-3 text-[12.5px]">
      <label className="flex flex-wrap items-center gap-2">
        <span className="text-pane-muted">Form name</span>
        <input
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          className="h-7 w-56 min-w-0 max-w-full rounded-full border border-pane-border bg-pane px-3 outline-none focus:border-accent"
        />
      </label>
      <p className="text-pane-muted">
        {kept.length ? `Kite keeps where you placed ${kept.join(", ")}. ` : ""}
        {choices.length ? "Tick the values that stay the same each time; they're filled in for you next time." : "Nothing you typed is kept."}
      </p>
      {choices.length ? (
        <div className="flex flex-col gap-1">
          {choices.map((c) => (
            <label key={c.key} className="flex min-w-0 cursor-pointer items-center gap-2">
              <input type="checkbox" checked={ticked.has(c.key)} onChange={() => toggle(c.key)} className="size-3.5 shrink-0 accent-[var(--accent)]" />
              <span className="shrink-0">{c.label}</span>
              <span className="min-w-0 truncate text-pane-muted">{c.shown}</span>
            </label>
          ))}
        </div>
      ) : null}
      {error ? <p className="text-warning">{error}</p> : null}
      <div className="flex flex-wrap justify-end gap-2">
        <button onClick={onCancel} className="h-7 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
          Cancel
        </button>
        <button
          onClick={() => void save()}
          disabled={saving}
          className="h-7 rounded-full bg-pane-fg px-3 font-medium text-pane hover:opacity-90 disabled:opacity-40"
        >
          {saving ? "Remembering…" : `Remember for ${senderLabel(file)}`}
        </button>
      </div>
    </div>
  );
}

/** "8 of 14 filled", what the profile put where, and Undo. */
export function ProfileFillNote({ fill, left, onUndo, onHide }: { fill: ProfileFill; left: number; onUndo: () => void; onHide: () => void }) {
  return (
    <div className="blur-fade flex items-start gap-2 border-b border-pane-border bg-accent-soft px-4 py-2 text-[12.5px]">
      <Icon icon={UserIcon} size={15} className="mt-px shrink-0 text-accent" />
      <div className="min-w-0 flex-1">
        {fill.total === 0 ? (
          <p>Kite found no fields or printed labels to fill on this PDF (scanned pages are pictures, with no text to read). Place your details by hand.</p>
        ) : (
          <>
            <p>
              <span className="font-medium">
                {fill.total - left} of {fill.total} filled
              </span>
              {fill.filled.length
                ? `. From your profile: ${fill.filled.map((f) => `${f.label} (${f.value.replace(/\n/g, ", ")})`).join(", ")}.`
                : ". Nothing on this form matched your profile closely enough to fill."}
            </p>
            <p className="text-pane-muted">
              {left ? `${left === 1 ? "The highlighted place is" : `The ${left} highlighted places are`} yours to fill. ` : ""}
              Check everything, then Save copy.
            </p>
          </>
        )}
      </div>
      {fill.filled.length ? (
        <button onClick={onUndo} className="-my-1 h-7 shrink-0 rounded-full px-3 text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
          Undo
        </button>
      ) : null}
      <Tooltip label="Hide">
        <button
          onClick={onHide}
          aria-label="Hide"
          className="-my-1 grid size-6 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
        >
          <Icon icon={Cancel01Icon} size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

export function PasswordForm({ wrong, onSubmit }: { wrong: boolean; onSubmit: (password: string) => void }) {
  const [value, setValue] = useState("");
  return (
    <form
      className="blur-fade mx-auto flex max-w-sm flex-col items-center gap-3 px-4 py-14 text-center"
      onSubmit={(e) => {
        e.preventDefault();
        if (value) onSubmit(value);
      }}
    >
      <span className="grid size-12 place-items-center rounded-2xl bg-pane text-pane-muted">
        <Icon icon={SquareLock02Icon} size={22} />
      </span>
      <p className="text-[12.5px] text-pane-muted">
        {wrong
          ? "That password didn't open it. Try again."
          : "This PDF needs a password to open. The sender usually includes it in the email or sends it separately."}
      </p>
      <div className="flex w-full gap-2">
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Password"
          className="h-9 min-w-0 flex-1 rounded-full border border-pane-border bg-pane px-4 text-[13px] outline-none focus:border-accent"
        />
        <button type="submit" className="h-9 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90">
          Open
        </button>
      </div>
    </form>
  );
}
