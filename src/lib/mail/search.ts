import type { Thread } from "./types";

// Search queries use Gmail's syntax, so the same text searches the local copy and
// (with "Search older mail in Gmail") the server. Parsed into typed terms that the
// SQL builder (server/store.ts), the demo filter and the UI all share.

type SearchField = "text" | "from" | "to" | "subject" | "filename" | "has" | "is" | "in" | "label" | "before" | "after" | "any";

export type SearchTerm = {
  field: SearchField;
  /** Lower-cased value; for before/after an ISO timestamp (start of that local day). */
  value: string;
  negate: boolean;
  /** A quoted "exact phrase" (text only). */
  phrase?: boolean;
  /** `any`: the terms joined by OR (one of them must hold). */
  any?: SearchTerm[];
};

const IS_VALUES = ["unread", "read", "starred", "snoozed"] as const;
const IN_VALUES = ["inbox", "sent", "drafts", "archive", "trash", "spam", "anywhere"] as const;

const ALIASES: Record<string, SearchField> = {
  from: "from",
  to: "to",
  cc: "to",
  subject: "subject",
  filename: "filename",
  has: "has",
  is: "is",
  in: "in",
  label: "label",
  before: "before",
  after: "after",
  older: "before",
  newer: "after",
};

/** The operators offered as hints in the search field. */
export const SEARCH_OPERATORS: { insert: string; label: string; example: string }[] = [
  { insert: "from:", label: "From someone", example: "from:sarah" },
  { insert: "to:", label: "To someone", example: "to:me@kite.app" },
  { insert: "subject:", label: "Subject has", example: "subject:invoice" },
  { insert: "has:attachment ", label: "Has files", example: "has:attachment" },
  { insert: "filename:", label: "File name has", example: "filename:pdf" },
  { insert: "is:unread ", label: "Unread", example: "is:unread" },
  { insert: "is:starred ", label: "Starred", example: "is:starred" },
  { insert: "in:archive ", label: "In a mailbox", example: "in:sent" },
  { insert: "label:", label: "Has a label", example: "label:receipts" },
  { insert: "after:", label: "After a date", example: "after:2026/01/31" },
  { insert: "newer_than:", label: "Recent", example: "newer_than:7d" },
  { insert: "OR ", label: "Either one", example: "invoice OR receipt" },
];

/** A `from:` or `to:` being typed at the caret: the operator, its value so far and where the value sits in the query. */
export type ContactToken = { role: "from" | "to"; value: string; start: number; end: number };

/** The `from:` / `to:` term the caret is in, if any (`-from:` too), for autocomplete. Quoted values aren't completed. */
export function contactToken(query: string, caret: number): ContactToken | null {
  const match = /(?:^|\s)-?(from|to):([^\s"]*)$/i.exec(query.slice(0, caret));
  if (!match) return null;
  const rest = /^\S*/.exec(query.slice(caret))?.[0] ?? "";
  return { role: match[1].toLowerCase() as "from" | "to", value: match[2], start: caret - match[2].length, end: caret + rest.length };
}

/** 2026/01/31, 2026-1-31 → start of that local day. */
function parseDate(value: string) {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 7d, 2w, 3m, 1y → that long before `now`. */
function parseAge(value: string, now: Date) {
  const match = /^(\d{1,4})([dwmy])$/.exec(value);
  if (!match) return null;
  const n = Number(match[1]);
  const date = new Date(now);
  if (match[2] === "d") date.setDate(date.getDate() - n);
  if (match[2] === "w") date.setDate(date.getDate() - n * 7);
  if (match[2] === "m") date.setMonth(date.getMonth() - n);
  if (match[2] === "y") date.setFullYear(date.getFullYear() - n);
  return date;
}

function operator(name: string, raw: string, now: Date): Omit<SearchTerm, "negate"> | null {
  const value = raw.toLowerCase();
  if (!value) return null;
  if (name === "older_than" || name === "newer_than") {
    const date = parseAge(value, now);
    return date ? { field: name === "older_than" ? "before" : "after", value: date.toISOString() } : null;
  }
  const field = ALIASES[name];
  if (!field) return null;
  if (field === "before" || field === "after") {
    const date = parseDate(value);
    return date ? { field, value: date.toISOString() } : null;
  }
  if (field === "has") return value === "attachment" || value === "attachments" || value === "files" ? { field, value: "attachment" } : null;
  if (field === "is") return (IS_VALUES as readonly string[]).includes(value) ? { field, value } : null;
  // label:inbox and friends are mailboxes; any other name is one of the user's labels/folders.
  if (field === "label") return (IN_VALUES as readonly string[]).includes(value) ? { field: "in", value } : { field, value };
  if (field === "in") return (IN_VALUES as readonly string[]).includes(value) ? { field, value } : value === "starred" ? { field: "is", value } : null;
  return { field, value };
}

/**
 * Splits a query into terms. Unknown operators and bad values search as plain text. `a OR b`
 * (capital OR, as in Gmail) joins the terms on either side into one `any` term.
 */
export function parseSearch(query: string, now = new Date()): SearchTerm[] {
  const terms: SearchTerm[] = [];
  const pattern = /(-?)(?:([a-z_]+):)?(?:"([^"]*)"?|(\S+))/gi;
  let or = false;
  const push = (term: SearchTerm) => {
    const prev = or ? terms.pop() : undefined;
    or = false;
    if (!prev) return terms.push(term);
    const group: SearchTerm = prev.field === "any" ? prev : { field: "any", value: "", negate: false, any: [prev] };
    group.any!.push(term);
    terms.push(group);
  };
  for (const match of query.matchAll(pattern)) {
    const negate = match[1] === "-";
    const name = match[2]?.toLowerCase();
    const quoted = match[3];
    const raw = (quoted ?? match[4] ?? "").trim();
    if (!name && !negate && quoted === undefined && raw === "OR") {
      or = terms.length > 0;
      continue;
    }
    if (name) {
      const parsed = operator(name, raw, now);
      if (parsed) {
        push({ ...parsed, negate });
        continue;
      }
      // Not an operator we know: search for the whole token.
      if (raw) push({ field: "text", value: `${name}:${raw}`.toLowerCase(), negate });
      continue;
    }
    if (!raw) continue;
    push({ field: "text", value: raw.toLowerCase(), negate, phrase: quoted !== undefined || undefined });
  }
  return terms;
}

function gmailDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

/** The same search in Gmail's own syntax (only the few places Kite differs are rewritten). */
export function toGmailQuery(terms: SearchTerm[]): string {
  return terms
    .map((t) => {
      const sign = t.negate ? "-" : "";
      if (t.field === "any") return `{${toGmailQuery(t.any ?? [])}}`;
      const quote = (v: string) => (/\s/.test(v) ? `"${v.replace(/"/g, "")}"` : v);
      switch (t.field) {
        case "text":
          return `${sign}${t.phrase ? `"${t.value.replace(/"/g, "")}"` : t.value}`;
        case "in":
          if (t.value === "archive") return t.negate ? "in:inbox" : "-in:inbox -in:drafts -in:sent";
          return t.value === "anywhere" ? "in:anywhere" : `${sign}in:${t.value}`;
        case "is":
          return t.value === "snoozed" ? `${sign}in:snoozed` : `${sign}is:${t.value}`;
        case "before":
        case "after":
          return `${sign}${t.field}:${gmailDate(t.value)}`;
        default:
          return `${sign}${t.field}:${quote(t.value)}`;
      }
    })
    .join(" ");
}

// ---------------------------------------------------------------------------
// In-memory matching: demo mode, and rules on one stored thread (server/rules.ts). The live
// store's lists do the same in SQL.
// ---------------------------------------------------------------------------

/**
 * What a stored thread knows that a list row doesn't, for rules. With facts, is: and in: read the
 * thread's own labels (not the view's mailbox) and label: matches names.
 */
export type MatchFacts = {
  /** Every label id on the conversation (Gmail's INBOX, UNREAD, STARRED, ... and the user's own). */
  labels: string[];
  /** Names of the user's own labels on it. */
  labelNames: string[];
  /** A message's full text (bodies that are only HTML). */
  text?: (message: Thread["messages"][number]) => string;
};

const contains = (haystack: string | undefined, needle: string) => !!haystack && haystack.toLowerCase().includes(needle);

function matchesTerm(thread: Thread, term: SearchTerm, facts?: MatchFacts): boolean {
  const { value } = term;
  const files = thread.messages.flatMap((m) => (m.attachments ?? []).filter((a) => !a.inline));
  const last = thread.messages[thread.messages.length - 1]?.date ?? "";
  switch (term.field) {
    case "any":
      return (term.any ?? []).some((t) => matchesTerm(thread, t, facts) !== t.negate);
    case "text":
      return (
        contains(thread.subject, value) ||
        contains(thread.originalSubject, value) ||
        contains(thread.note, value) ||
        thread.messages.some(
          (m) =>
            contains(m.snippet, value) ||
            m.body.some((line) => contains(line, value)) ||
            (!!facts?.text && contains(facts.text(m), value)) ||
            [m.from, ...m.to, ...(m.cc ?? [])].some((c) => contains(c.name, value) || contains(c.email, value)),
        )
      );
    case "from":
      return thread.messages.some((m) => contains(m.from.name, value) || contains(m.from.email, value));
    case "to":
      return thread.messages.some((m) => [...m.to, ...(m.cc ?? [])].some((c) => contains(c.name, value) || contains(c.email, value)));
    case "subject":
      return contains(thread.subject, value) || contains(thread.originalSubject, value);
    case "filename":
      return files.some((f) => contains(f.name, value));
    case "has":
      return files.length > 0;
    case "is":
      if (facts) return value === "snoozed" ? false : value === "read" ? !facts.labels.includes("UNREAD") : facts.labels.includes(value.toUpperCase());
      return value === "unread" ? thread.unread : value === "read" ? !thread.unread : value === "starred" ? thread.starred : thread.mailbox === "snoozed";
    case "in":
      if (facts) return inLabels(facts.labels, value);
      return value === "anywhere" || thread.mailbox === value;
    case "label":
      // Demo labels use their name as their id.
      return (facts?.labelNames ?? thread.labels ?? []).some((l) => labelNamed(l, value));
    case "before":
      return last < value;
    case "after":
      return last >= value;
  }
}

/** Gmail's way of writing a label in a search: lower case, spaces and "/" as "-". */
function labelSlug(name: string) {
  return name.toLowerCase().replace(/[\s/]+/g, "-");
}

/** Whether `label:value` names this label: its name in any case (letters outside ASCII too), with spaces and "/" also written as "-". */
export const labelNamed = (name: string, value: string) => labelSlug(name) === labelSlug(value);

/** in:<mailbox> from a conversation's labels (the same as the SQL in server/store.ts termSql). */
function inLabels(labels: string[], value: string) {
  if (value === "anywhere") return true;
  if (value === "archive") return !labels.includes("INBOX") && !labels.includes("DRAFT");
  const id = ({ inbox: "INBOX", sent: "SENT", drafts: "DRAFT", trash: "TRASH", spam: "SPAM" } as Record<string, string>)[value];
  return !!id && labels.includes(id);
}

export function matchesSearch(thread: Thread, terms: SearchTerm[], facts?: MatchFacts) {
  return terms.every((term) => matchesTerm(thread, term, facts) !== term.negate);
}

/** Terms that need message bodies or attachments (a metadata-only copy can't answer them). */
export const needsBody = (term: SearchTerm): boolean =>
  term.field === "text" || term.field === "has" || term.field === "filename" || (term.field === "any" && (term.any ?? []).some(needsBody));
