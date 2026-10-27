import { parseDate, tokenize } from "./values";
import { FIELD_TYPE_NAMES, keyFor, type EmailFacts, type FieldSpec, type FieldType } from "./fields";

// Building an automation by example: the values in a real email that can become fields with one
// click (amounts, dates, codes, links, addresses), each with the words in front of it, and the
// field a click makes ("the amount after “Amount due:”"). Text the user selects can be read too.
// Pure, so the wizard runs it in the browser on the email it shows.

/** Someone who writes to you, for the wizard's first step. */
export type AutomationSender = { email: string; name: string; emails: number; lastDate: string };

/** A real email as Read sees it (server/automation-examples.ts, or demo mail). */
export type AutomationExample = {
  threadId: string;
  accountId: string;
  subject: string;
  sender: string;
  senderEmail: string;
  date: string;
  text: string;
};

/** The facts Read works on, from an example. */
export const factsOfExample = (e: AutomationExample): EmailFacts => ({
  senderName: e.sender !== e.senderEmail ? e.sender : "",
  senderEmail: e.senderEmail,
  subject: e.subject,
  date: e.date,
  text: e.text,
});

export type Pickable = { start: number; end: number; type: FieldType; text: string; label: string };

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** The words in front of a value: the rest of its line, else a short line just above ("Total" over "R 349.00"). */
function labelBefore(text: string, start: number) {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const before = text.slice(lineStart, start).replace(/\s+$/, "");
  const own = before.slice(-48).replace(/^.*?[.;!?]\s+/, "").trim();
  if (own && /\p{L}/u.test(own)) return own;
  const above = text.slice(0, Math.max(0, lineStart - 1)).split("\n").reverse().find((l) => l.trim());
  const line = above?.trim() ?? "";
  return line && line.length <= 40 && !/\d/.test(line) ? line : "";
}

/** Values in the text that a click can turn into a field, in reading order, without overlaps. */
export function pickables(text: string): Pickable[] {
  const out: Pickable[] = [];
  const add = (start: number, end: number, type: FieldType) => {
    if (out.some((p) => start < p.end && end > p.start)) return;
    // Only dates Kite can read as dates ("3rd" alone has no month).
    if (type === "date" && !parseDate(text.slice(start, end), new Date().toISOString())) return;
    out.push({ start, end, type, text: text.slice(start, end), label: labelBefore(text, start) });
  };
  for (const m of text.matchAll(URL_RE)) add(m.index, m.index + m[0].length, "link");
  for (const m of text.matchAll(EMAIL_RE)) add(m.index, m.index + m[0].length, "email");
  const tokens = tokenize(text);
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "money") add(t.start, t.end, "money");
    else if (t.type === "date") add(t.start, t.end, "date");
    else if (t.type === "month") {
      // "3 November 2026", "Nov 3, 2026": the month with the numbers right beside it on the same line.
      let first = i;
      let last = i;
      const near = (a: number, b: number) => !/\n/.test(text.slice(tokens[a].end, tokens[b].start)) && tokens[b].start - tokens[a].end <= 2;
      if (i > 0 && tokens[i - 1].type === "num" && near(i - 1, i)) first = i - 1;
      while (last + 1 < tokens.length && (tokens[last + 1].type === "num" || tokens[last + 1].text === ",") && near(last, last + 1) && last - i < 3) last++;
      if (tokens[last].text === ",") last--;
      if (first < i || last > i) add(tokens[first].start, tokens[last].end, "date");
    } else if (t.type === "code" || t.type === "acct") add(t.start, t.end, "code");
  }
  return out.sort((a, b) => a.start - b.start);
}

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A field name from the words in front of a value ("Amount due:" -> "Amount due"). */
function nameFrom(label: string, type: FieldType) {
  const clean = label.replace(/[:\-–—=#*]+$/, "").replace(/\s+/g, " ").trim().slice(0, 40);
  return clean ? titleCase(clean.toLowerCase()) : FIELD_TYPE_NAMES[type];
}

/** The field a click on `pick` makes: read after its words when it has some, else the first of its type. */
export function fieldFromPick(pick: Pickable, taken: string[], name?: string): FieldSpec {
  const fieldName = name || nameFrom(pick.label, pick.type);
  return {
    key: keyFor(fieldName, taken),
    name: fieldName,
    type: pick.type,
    from: pick.label ? { kind: "after", label: pick.label.slice(-80) } : { kind: "first" },
  };
}

/**
 * A text field from words the user selected: read after the words in front of them on the line.
 * Null when nothing comes before them to find them by.
 */
export function fieldFromSelection(text: string, selected: string, taken: string[], name?: string): FieldSpec | null {
  const value = selected.trim();
  const at = text.indexOf(value);
  if (!value || at < 0) return null;
  const label = labelBefore(text, at);
  if (!label) return null;
  const fieldName = name || nameFrom(label, "text");
  return { key: keyFor(fieldName, taken), name: fieldName, type: "text", from: { kind: "after", label: label.slice(-80) } };
}

