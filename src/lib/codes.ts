/*
 * Sign-in codes and magic links, a built-in feature. A short email whose subject or body says it carries a code is read with a few plain
 * patterns; the one sign-in link in a short email is taken as a magic link. No DOM, linear scans.
 */

/** Longer emails are newsletters or receipts, not sign-in mail. */
const MAX_TEXT = 2000;

const SUBJECT_WORDS = [
  "verification code", "security code", "sign-in code", "login code", "one-time", "otp", "passcode",
  "verify your", "authentication code", "your code", "confirmation code", "2fa", "two-factor",
  "sign in to", "log in to", "magic link", "login link", "sign-in link", "confirm your email",
];
const BODY_WORDS = ["one-time password", "verification code", "security code", "your code is", "enter this code"];
const NOT_CODES = ["discount code", "promo code", "coupon"];

const PATTERNS: { pattern: RegExp; subjectOnly?: boolean }[] = [
  // "Your code is 482913", "OTP: 4829", "OTP for SARS eFiling:6246-160281": a few words may sit between.
  { pattern: /\b(?:code|otp|passcode|pin|password)\b[^0-9]{0,40}?\b([0-9]{3,8}(?:[-–][0-9]{3,8})?)\b/i },
  { pattern: /\b([0-9]{4,8})\b[^0-9]{0,30}(?:is your|is the|to verify|to sign in)/i },
  { pattern: /\b([0-9]{3}[ -][0-9]{3})\b/ },
  { pattern: /\b([A-Z0-9]{5,8})\b\s+is your (?:[a-z.-]+ )?(?:verification|security|login|sign-in|confirmation)? ?code/i, subjectOnly: true },
];

/**
 * `code`: the code to copy. `choices`: when Kite can't tell which part is the code (first part,
 * second part, the whole), with `shape` ("4-6": the groups' lengths) to remember the pick by.
 */
export type FoundCode = { code?: string; link?: string; choices?: string[]; shape?: string };

/** Sender names that say nothing about who sent it ("NOREPLY", "no-reply", "Do Not Reply", "Notifications"). */
const PLACEHOLDER_NAME = /^(?:(?:do[\s._-]*)?not?[\s._-]*reply|notifications?|info|mailer|alerts?)$/i;

/**
 * Who a code is from, for the Kite bar, tray and toasts: the sender's name, unless it's a placeholder
 * like "NOREPLY" (SARS eFiling); then their domain ("sars.gov.za").
 */
export function serviceName(from: { name?: string; email: string }): string {
  const name = from.name?.trim();
  if (name && !PLACEHOLDER_NAME.test(name) && !name.includes("@")) return name;
  return from.email.split("@")[1]?.toLowerCase() || from.email;
}

/** "4-6" for choices like ["6246", "160281", "6246-160281"]. */
export const shapeOf = (choices: string[]) => `${choices[0].length}-${choices[1].length}`;

/**
 * A code as the user types it. Two groups of digits of the same length are one code split for
 * reading ("123-456" -> 123456). Groups of different lengths ("6246-160281") could be a reference
 * and the code, the code and a reference, or one code typed whole: Kite doesn't guess. It offers
 * the first part, the second and the whole, and remembers the user's pick per sender and `shape`
 * (server/codes.ts). A lone group needs four digits or more.
 */
function codeOf(raw: string): Pick<FoundCode, "code" | "choices" | "shape"> | undefined {
  const whole = raw.replace(/\s/g, "");
  const [first, second] = whole.split(/[-–]/);
  if (second) return first.length === second.length ? { code: first + second } : { choices: [first, second, whole], shape: shapeOf([first, second]) };
  return first.length >= 4 ? { code: first } : undefined;
}

/** Whether an email is sign-in mail at all, by its words. */
export function looksLikeCodeMail(subject: string, text: string) {
  const s = subject.toLowerCase();
  const b = text.toLowerCase();
  if (NOT_CODES.some((w) => s.includes(w) || b.includes(w))) return false;
  return SUBJECT_WORDS.some((w) => s.includes(w)) || BODY_WORDS.some((w) => b.includes(w));
}

/** The code and/or sign-in link in a sign-in email, or null when it isn't one or has neither. */
export function findCode(subject: string, text: string, html?: string): FoundCode | null {
  if (!looksLikeCodeMail(subject, text)) return null;
  let found: ReturnType<typeof codeOf>;
  for (const { pattern, subjectOnly } of PATTERNS) {
    const match = pattern.exec(subjectOnly ? subject : `${subject}\n${text}`);
    found = match?.[1] ? codeOf(match[1]) : undefined;
    if (found) break;
  }
  const link = signInLink(html, text);
  return found || link ? { ...found, link } : null;
}

const ACTION = /\b(?:sign[ -]?in|log[ -]?in|verify|confirm|magic link|continue|authenticate|activate)\b/i;
const ACTION_PATH = /(?:magic|log-?in|sign-?in|sign_in|verif|confirm|auth|token=)/i;
const NOT_ACTION = /unsubscribe|preferences|privacy|terms|policy|help|support|report|manage|settings|mailto:/i;

function decode(text: string) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function candidates(html: string | undefined, text: string) {
  const links: { url: string; label: string }[] = [];
  if (html) {
    for (const match of html.matchAll(/<a\b[^>]*?\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi)) {
      links.push({ url: decode(match[2]), label: decode(match[3]) });
    }
  } else {
    for (const line of text.split("\n")) {
      for (const match of line.matchAll(/https:\/\/[^\s<>"')\]]+/g)) links.push({ url: match[0], label: line });
    }
  }
  return links;
}

/** The single sign-in link in a short email, or undefined when there's none or more than one. */
export function signInLink(html: string | undefined, text: string): string | undefined {
  if (text.length > MAX_TEXT) return undefined;
  const found = new Set<string>();
  for (const { url, label } of candidates(html, text)) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    if (parsed.protocol !== "https:" || NOT_ACTION.test(label) || NOT_ACTION.test(parsed.pathname)) continue;
    if (ACTION.test(label) || ACTION_PATH.test(parsed.pathname + parsed.search)) found.add(parsed.href);
  }
  return found.size === 1 ? [...found][0] : undefined;
}
