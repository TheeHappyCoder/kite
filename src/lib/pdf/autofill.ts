import { TEXT_BASELINE, type FieldValue, type FormField, type FormInfo, type Placed } from "./fill";
import type { Blank } from "./labels";
import type { Profile } from "./profile";
import { matchLabel, matchLabelText, profileValue, ruleFor, type LabelMatch } from "./profile-rules";

// "Fill from my profile": what the profile can fill on this form, decided by plain rules
// (profile-rules.ts). Only confident matches, only places that are still empty (a remembered
// layout applied first keeps its values), never checkboxes, radios, signatures or free-text
// questions. Two places on a page asking for the same detail are left alone: Kite can't tell
// whose name each one wants.

export type Filled = {
  /** A field name, or a placed item's id. */
  target: string;
  /** What the form calls it, else the profile's label. */
  label: string;
  value: string;
};

type Autofill = {
  values: Record<string, FieldValue>;
  items: Placed[];
  filled: Filled[];
  /** Places on the form that take an answer: fields (by name, no signatures) plus printed blanks. */
  total: number;
  /** Field names still empty after filling. */
  emptyFields: string[];
  /** Printed blanks still without an answer. */
  emptyBlanks: Blank[];
};

const isEmpty = (value: FieldValue | undefined) => value === undefined || value === "" || value === false;

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A blank's area on the page, the box a placed answer would take. */
export function blankBox(blank: Blank) {
  const h = blank.size * 1.25;
  return { x: blank.x, y: blank.y - h * TEXT_BASELINE, w: blank.w, h };
}

/** The field's label and name agree (or only one is known). */
function fieldMatch(field: FormField): LabelMatch | null {
  const byLabel = field.label ? matchLabel(field.label) : null;
  const byName = matchLabel(field.name);
  if (byLabel && byName && (byLabel.key !== byName.key || byLabel.index !== byName.index)) return null;
  return byLabel ?? byName;
}

const matchId = (m: LabelMatch) => `${m.key}#${m.index ?? ""}`;

export function planAutofill({
  profile,
  info,
  values,
  items,
  blanks,
  measure,
}: {
  profile: Profile;
  info: FormInfo | null;
  /** The editor's current changes, by field name. */
  values: Record<string, FieldValue>;
  /** Items already placed (by hand or a remembered layout). */
  items: Placed[];
  blanks: Blank[];
  /** Width of placed text in points at height `h`. */
  measure: (text: string, h: number) => number;
}): Autofill {
  const byName = new Map<string, FormField[]>();
  for (const f of info?.fields ?? []) if (f.kind !== "signature") byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
  const current = (name: string) => values[name] ?? info?.values[name];

  // Who asks for what, per page, to spot two places wanting the same detail.
  const askers = new Map<string, Set<string>>();
  const ask = (page: number, m: LabelMatch, who: string) => {
    const key = `${page}|${matchId(m)}`;
    askers.set(key, (askers.get(key) ?? new Set()).add(who));
  };
  const fieldMatches = new Map<string, LabelMatch>();
  for (const [name, widgets] of byName) {
    const m = fieldMatch(widgets[0]);
    if (!m) continue;
    fieldMatches.set(name, m);
    for (const w of widgets) ask(w.page, m, `field:${name}`);
  }
  const blankMatches = new Map<string, LabelMatch>();
  for (const b of blanks) {
    const m = matchLabel(b.label);
    if (!m) continue;
    blankMatches.set(b.id, m);
    ask(b.page, m, `blank:${b.id}`);
  }
  const unclear = (pages: number[], m: LabelMatch) => pages.some((p) => (askers.get(`${p}|${matchId(m)}`)?.size ?? 0) > 1);

  const outValues: Record<string, FieldValue> = {};
  const filled: Filled[] = [];
  for (const [name, m] of fieldMatches) {
    const widgets = byName.get(name)!;
    const field = widgets[0];
    if (field.readOnly || !isEmpty(current(name))) continue;
    if (!["text", "date", "dropdown", "list"].includes(field.kind)) continue;
    if (field.multiline && !ruleFor(m.key).multiline) continue;
    if (unclear(widgets.map((w) => w.page), m)) continue;
    let value = profileValue(profile, m, { dateFormat: field.dateFormat, multiline: field.multiline });
    if (!value) continue;
    if (field.kind === "dropdown" || field.kind === "list") {
      const option = field.options?.find((o) => o.trim().toLowerCase() === value.toLowerCase());
      if (!option) continue;
      value = option;
    }
    if (field.maxLength && value.length > field.maxLength) continue;
    outValues[name] = value;
    filled.push({ target: name, label: field.label ?? matchLabelText(m), value });
  }

  const outItems: Placed[] = [];
  const emptyBlanks: Blank[] = [];
  for (const b of blanks) {
    const box = blankBox(b);
    const taken = items.some((i) => i.page === b.page && overlaps(i, box));
    if (taken) continue;
    const m = blankMatches.get(b.id);
    const value = m && !unclear([b.page], m) ? profileValue(profile, m) : "";
    if (!value) {
      emptyBlanks.push(b);
      continue;
    }
    const w = measure(value, box.h);
    if (w > b.w + b.size * 4) {
      // Doesn't fit in the space the form leaves; the user places it.
      emptyBlanks.push(b);
      continue;
    }
    const item: Placed = { id: crypto.randomUUID(), kind: "text", page: b.page, x: box.x, y: box.y, w, h: box.h, text: value };
    outItems.push(item);
    filled.push({ target: item.id, label: b.label, value });
  }

  const emptyFields = [...byName.entries()]
    .filter(([name, widgets]) => !widgets[0].readOnly && isEmpty(current(name)) && !(name in outValues))
    .map(([name]) => name);
  const editable = [...byName.values()].filter((widgets) => !widgets[0].readOnly).length;
  return { values: outValues, items: outItems, filled, total: editable + blanks.length, emptyFields, emptyBlanks };
}
