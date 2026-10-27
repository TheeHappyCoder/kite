import * as z from "zod";
import { format } from "date-fns";
import { findCode } from "../codes";
import { parseAmount, parseDate, tokenize } from "./values";

// Automations, step 2 (Read): values pulled out of an email with plain rules, no AI. A field has a
// name, a type and a source: something every email has (sender, subject, when it came), the text
// after a label ("Total:", "Due date"), the first value of its type anywhere in the email, or a
// pattern the user wrote. Values feed Check (if / otherwise), every text step as `{key}` blanks,
// and collections. Pure: the server reads stored mail with it, the builder previews with it.

export const FIELD_TYPES = ["text", "number", "money", "date", "link", "code", "email"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];

export const FIELD_TYPE_NAMES: Record<FieldType, string> = {
  text: "Text",
  number: "Number",
  money: "Amount",
  date: "Date",
  link: "Link",
  code: "Code",
  email: "Email address",
};

export const BUILTINS = ["sender_name", "sender_email", "company", "subject", "received"] as const;
export type Builtin = (typeof BUILTINS)[number];

export const BUILTIN_NAMES: Record<Builtin, string> = {
  sender_name: "Sender's name",
  sender_email: "Sender's address",
  company: "Their company",
  subject: "Subject",
  received: "When it arrived",
};

const FieldSource = z.discriminatedUnion("kind", [
  /** Something every email has. */
  z.object({ kind: z.literal("builtin"), builtin: z.enum(BUILTINS) }),
  /** The text after a label on the same line: "Total:", "Due date", "Order number". */
  z.object({ kind: z.literal("after"), label: z.string().trim().min(1, "Write the words before the value").max(80) }),
  /** The first value of the field's type anywhere in the subject or text. */
  z.object({ kind: z.literal("first") }),
  /** The same value on every email ("Applied", "Rejected"): a status the automation sets. */
  z.object({ kind: z.literal("fixed"), value: z.string().trim().min(1, "Write the value").max(80) }),
  /** A pattern (regular expression); its first group, else the whole match. */
  z.object({
    kind: z.literal("pattern"),
    pattern: z
      .string()
      .min(1, "Write a pattern")
      .max(200)
      .refine((p) => {
        try {
          new RegExp(p, "i");
          return true;
        } catch {
          return false;
        }
      }, "That pattern isn't valid"),
  }),
]);
type FieldSource = z.infer<typeof FieldSource>;

/** A key usable as a `{blank}`: lower case, digits and underscores. */
const KEY = /^[a-z][a-z0-9_]{0,31}$/;

export const FieldSpec = z.object({
  key: z.string().regex(KEY, "Use lower-case letters, digits and _"),
  name: z.string().trim().min(1, "Name the field").max(40),
  type: z.enum(FIELD_TYPES),
  from: FieldSource,
});
export type FieldSpec = z.infer<typeof FieldSpec>;

const CHECK_OPS = ["is", "is_not", "contains", "not_contains", "more", "less", "within_days", "present", "missing"] as const;
export type CheckOp = (typeof CHECK_OPS)[number];

export const FieldCheck = z.object({
  field: z.string().regex(KEY),
  op: z.enum(CHECK_OPS),
  value: z.string().trim().max(200).default(""),
});
export type FieldCheck = z.infer<typeof FieldCheck>;

/** A value read from an email. `text` is how it shows (and fills `{blanks}`); typed parts sit beside it. */
export type FieldValue = { text: string; number?: number; currency?: string; date?: string };
export type FieldValues = Record<string, FieldValue | null>;

/**
 * What a field reads from. `text` is the email's plain text (body, or the preview when that's all
 * Kite has). The sender is the other party: for mail you send, who it went to.
 */
export type EmailFacts = { senderName: string; senderEmail: string; subject: string; date: string; text: string };

/** Mail services anyone can sign up to (by main name): their domain says nothing about a company. */
const PERSONAL = new Set(["gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "icloud", "me", "mac", "aol", "proton", "protonmail", "pm", "gmx", "zoho", "mail", "fastmail", "hey", "yandex", "qq", "163", "web", "telkomsa", "mweb", "vodamail", "webmail"]);

/** Second-level endings under a country: acme.co.za, acme.com.au, acme.org.uk. */
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc", "nom", "or", "ne", "go"]);

/** "jobs@careers.acme.co.za" -> "Acme"; a personal address falls back to the name. */
export function companyOf(email: string, name = "") {
  const domain = email.toLowerCase().split("@")[1] ?? "";
  if (!domain) return name.trim() || null;
  const parts = domain.split(".");
  // The ending goes (".com", ".za", ".agency"), then a generic second level (".co.za", ".com.au");
  // what's left before it is the name (careers.acme.co.za -> acme).
  if (parts.length > 1) parts.pop();
  while (parts.length > 1 && SECOND_LEVEL.has(parts.at(-1)!)) parts.pop();
  const main = parts.at(-1) ?? "";
  if (!main || PERSONAL.has(main)) return name.trim() || null;
  return main.replace(/(^|[-_])([a-z])/g, (_, sep: string, c: string) => `${sep ? " " : ""}${c.toUpperCase()}`);
}

/** Turns a label into a key: "Due date" -> "due_date". */
export function keyFor(name: string, taken: string[] = []) {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/^(\d)/, "f_$1")
      .slice(0, 28) || "field";
  let key = base;
  for (let n = 2; taken.includes(key); n++) key = `${base}_${n}`;
  return key;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

const dateText = (iso: string) => {
  const d = new Date(iso);
  return d.getHours() || d.getMinutes() ? format(d, "d MMM yyyy, HH:mm") : format(d, "d MMM yyyy");
};

/** Reads a value of `type` from a piece of text (the whole email for "first", a line's rest for "after"). */
function readTyped(type: FieldType, text: string, sentAt: string): FieldValue | null {
  switch (type) {
    case "text": {
      const line = text.split(/\r?\n/)[0].replace(/\s{2,}.*$/, "").trim().slice(0, 200);
      return line ? { text: line } : null;
    }
    case "money": {
      const token = tokenize(text).find((t) => t.type === "money") ?? tokenize(text).find((t) => t.type === "num");
      const amount = token ? parseAmount(token.text) : null;
      if (!amount) return null;
      return { text: token!.text.trim(), number: amount.value, currency: amount.currency || undefined };
    }
    case "number": {
      const token = tokenize(text).find((t) => t.type === "num" || t.type === "money");
      const amount = token ? parseAmount(token.text) : null;
      return amount ? { text: token!.text.trim(), number: amount.value } : null;
    }
    case "date": {
      // Only the first date-looking stretch, so a later "sent at" doesn't join in.
      const tokens = tokenize(text);
      const at = tokens.findIndex((t) => t.type === "date" || t.type === "month");
      if (at < 0) return null;
      const span = text.slice(Math.max(0, tokens[at].start - 12), tokens[at].end + 24);
      const iso = parseDate(span, sentAt);
      return iso ? { text: dateText(iso), date: iso } : null;
    }
    case "link": {
      const m = URL_RE.exec(text);
      return m ? { text: m[0] } : null;
    }
    case "email": {
      const m = EMAIL_RE.exec(text);
      return m ? { text: m[0].toLowerCase() } : null;
    }
    case "code": {
      const found = findCode(text, "");
      const code = found?.code ?? tokenize(text).find((t) => t.type === "code")?.text;
      return code ? { text: code } : null;
    }
  }
}

/** The text after `label` on its line (case-insensitive), without the colon or dash that follows. */
function after(text: string, label: string): string | null {
  const at = text.toLowerCase().indexOf(label.toLowerCase());
  if (at < 0) return null;
  const rest = text.slice(at + label.length).replace(/^[\s:–—-]+/, "");
  // A value on the next line ("Total\nR 349.00") counts too.
  const line = rest.split(/\r?\n/).find((l) => l.trim());
  return line ? line.trim() : null;
}

/** One field's value from an email, or null when the email doesn't have it. */
export function readField(field: FieldSpec, email: EmailFacts): FieldValue | null {
  const { from } = field;
  if (from.kind === "builtin") {
    switch (from.builtin) {
      case "sender_name":
        return email.senderName ? { text: email.senderName } : null;
      case "sender_email":
        return { text: email.senderEmail };
      case "company": {
        const company = companyOf(email.senderEmail, email.senderName);
        return company ? { text: company } : null;
      }
      case "subject":
        return { text: email.subject };
      case "received":
        return { text: dateText(email.date), date: email.date };
    }
  }
  if (from.kind === "after") {
    const rest = after(`${email.subject}\n${email.text}`, from.label);
    return rest ? readTyped(field.type, rest, email.date) : null;
  }
  if (from.kind === "fixed") return { text: from.value };
  if (from.kind === "first") {
    if (field.type === "text") return null;
    return readTyped(field.type, `${email.subject}\n${email.text}`, email.date);
  }
  let match: RegExpExecArray | null = null;
  try {
    // Bounded input: patterns run on at most 20,000 characters.
    match = new RegExp(from.pattern, "i").exec(`${email.subject}\n${email.text}`.slice(0, 20_000));
  } catch {
    return null;
  }
  if (!match) return null;
  const raw = (match[1] ?? match[0]).trim();
  return field.type === "text" ? (raw ? { text: raw.slice(0, 200) } : null) : readTyped(field.type, raw, email.date);
}

/** Every field's value (null where the email doesn't have it). */
export function readFields(fields: FieldSpec[], email: EmailFacts): FieldValues {
  return Object.fromEntries(fields.map((f) => [f.key, readField(f, email)]));
}

/** Whether a field needs the email's text (builtins don't, so they never wait for a body). */
export const needsText = (field: FieldSpec) => field.from.kind !== "builtin" && field.from.kind !== "fixed";

const number = (s: string) => {
  const amount = parseAmount(s.trim());
  return amount ? amount.value : Number.NaN;
};

/** One check on the values. `now` decides "within N days". */
export function checkHolds(check: FieldCheck, values: FieldValues, now = Date.now()): boolean {
  const v = values[check.field] ?? null;
  const want = check.value.trim();
  switch (check.op) {
    case "present":
      return !!v;
    case "missing":
      return !v;
    case "is":
      return !!v && v.text.toLowerCase() === want.toLowerCase();
    case "is_not":
      return !v || v.text.toLowerCase() !== want.toLowerCase();
    case "contains":
      return !!v && v.text.toLowerCase().includes(want.toLowerCase());
    case "not_contains":
      return !v || !v.text.toLowerCase().includes(want.toLowerCase());
    case "more":
    case "less": {
      if (!v) return false;
      const a = v.number ?? (v.date ? Date.parse(v.date) : number(v.text));
      const b = v.date ? Date.parse(want) : number(want);
      if (Number.isNaN(a) || Number.isNaN(b)) return false;
      return check.op === "more" ? a > b : a < b;
    }
    case "within_days": {
      if (!v?.date) return false;
      const days = Number(want) || 0;
      const at = Date.parse(v.date);
      return at >= now - 86_400_000 && at <= now + days * 86_400_000;
    }
  }
}

/** All checks hold (no checks: always). */
export const checksHold = (checks: FieldCheck[], values: FieldValues, now?: number) => checks.every((c) => checkHolds(c, values, now));

/** The values as `{blank}` text, for prepared replies, collection rows and event titles. */
export function blankValues(values: FieldValues): Record<string, string> {
  return Object.fromEntries(Object.entries(values).flatMap(([k, v]) => (v ? [[k, v.text]] : [])));
}

/** Which checks make sense for a type. */
export function opsFor(type: FieldType | undefined): CheckOp[] {
  if (type === "money" || type === "number") return ["more", "less", "is", "is_not", "present", "missing"];
  if (type === "date") return ["within_days", "more", "less", "present", "missing"];
  return ["contains", "not_contains", "is", "is_not", "present", "missing"];
}

