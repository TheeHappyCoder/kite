import { escapeInline } from "../mail/body";

// "Prepare reply" (the rules verb prepare_reply): a markup template with blanks, filled when the
// rule matches from the message. Never sent by itself and never
// AI: the reply waits in the conversation's quick-reply box until you send, edit or discard it.

/** A blank in a template: `{first_name}`, `{name}`, `{subject}`. */
const BLANK = /\{([a-z][a-z0-9_]{0,31})\}/g;

/** Blanks a prepared reply can use. */
export const MESSAGE_BLANKS = [
  { key: "first_name", label: "Sender's first name" },
  { key: "name", label: "Sender's name" },
  { key: "subject", label: "Subject (without Re:)" },
] as const;

export type BlankValues = Record<string, string>;

/** A prepared reply as the reader shows it (prepared_replies, keyed by Kite thread id). */
export type PreparedReply = {
  id: string;
  ruleId: string;
  ruleName: string;
  /** The message it answers. */
  messageId: string;
  /** Markup, blanks filled. */
  body: string;
  /** Blanks with no value, left in the text as `{key}` for you to fill. */
  missing: string[];
  createdAt: string;
  /** Written by your AI (a rule's "Draft with AI"), not filled from a template. */
  ai?: boolean;
};

/** The blanks a template uses, in order, once each. */
export function blanksIn(template: string) {
  return [...new Set([...template.matchAll(BLANK)].map((m) => m[1]))];
}

/** Fills the blanks it has values for; the rest stay as `{key}` and are listed in `missing`. */
export function fillBlanks(template: string, values: BlankValues) {
  const missing = new Set<string>();
  const body = template.replace(BLANK, (whole, key: string) => {
    const value = values[key]?.replace(/\s+/g, " ").trim();
    if (!value) {
      missing.add(key);
      return whole;
    }
    return escapeInline(value);
  });
  return { body, missing: [...missing] };
}

/** `{first_name}`, `{name}` and `{subject}` from who wrote and the subject. A name that's only an address gives none. */
export function messageBlanks(from: { name: string; email: string }, subject: string): BlankValues {
  const raw = from.name.replace(/["']/g, "").trim();
  const name = raw && !raw.includes("@") ? raw : "";
  // "Steyn, Mark" -> "Mark".
  const ordered = /^[^,]+,\s*\S/.test(name) ? name.split(",").slice(1).join(",").trim() : name;
  const values: BlankValues = { subject: subject.replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, "").trim() };
  if (name) {
    values.name = name;
    values.first_name = ordered.split(/\s+/)[0];
  }
  return values;
}

/** "{first_name} and {amount} have no value yet". */
export function describeMissing(missing: string[]) {
  if (!missing.length) return "";
  const list = missing.map((k) => `{${k}}`);
  return `${list.length === 1 ? list[0] : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`} to fill in`;
}
