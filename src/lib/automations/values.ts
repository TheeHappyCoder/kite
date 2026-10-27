// What Read finds in an email's text, with no AI and nothing bank- or country-specific: typed
// tokens (amounts, numbers, dates, times, masked account numbers, codes; month and weekday names
// from Intl in many languages, currencies from Intl's ISO list), amounts in any of the usual
// number formats ("1,250.00", "1 250,00", "1.250,00") and dates ("3 November 2026", "2026-11-03").

type TokenType = "word" | "punct" | "money" | "num" | "date" | "time" | "acct" | "code" | "month" | "weekday";

export type Token = { text: string; type: TokenType; start: number; end: number };

/** Locales whose month and weekday names are recognised. Adding one is enough to read its dates. */
const LOCALES = ["en", "af", "nl", "de", "fr", "es", "pt", "it", "sv", "da", "nb", "pl", "zu", "xh", "sw", "tr", "id"];

function names(kind: "month" | "weekday"): Map<string, number> {
  const out = new Map<string, number>();
  for (const locale of LOCALES) {
    for (const style of ["long", "short"] as const) {
      const format = new Intl.DateTimeFormat(locale, kind === "month" ? { month: style, timeZone: "UTC" } : { weekday: style, timeZone: "UTC" });
      for (let i = 0; i < (kind === "month" ? 12 : 7); i++) {
        // 2024-01-01 was a Monday.
        const date = kind === "month" ? new Date(Date.UTC(2024, i, 15)) : new Date(Date.UTC(2024, 0, 1 + i));
        const name = format.format(date).toLowerCase().replace(/\.$/, "");
        // Short names under 3 letters ("ma", "di") collide with ordinary words.
        if (name.length >= 3 && !/\d/.test(name)) out.set(name, i);
      }
    }
  }
  return out;
}

let cache: { months: Map<string, number>; weekdays: Map<string, number>; codes: Set<string> } | null = null;
function tables() {
  if (!cache) {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    cache = { months: names("month"), weekdays: names("weekday"), codes: new Set(supported ? supported("currency") : ["ZAR", "USD", "EUR", "GBP"]) };
  }
  return cache;
}

function monthIndex(word: string): number | undefined {
  return tables().months.get(word.toLowerCase().replace(/\.$/, ""));
}

/** Symbols that mean money on their own, mapped to an ISO code ("$" is a guess a sender can override). */
const SYMBOLS: Record<string, string> = {
  R: "ZAR", $: "USD", US$: "USD", "€": "EUR", "£": "GBP", "₦": "NGN", "₹": "INR", "¥": "JPY", "₩": "KRW", "₺": "TRY",
  "₱": "PHP", "₪": "ILS", KSh: "KES", Ksh: "KES", "₵": "GHS", Fr: "CHF", "zł": "PLN", kr: "SEK", Rp: "IDR", RM: "MYR", "R$": "BRL",
};

const NUM = String.raw`\d{1,3}(?:[   .,'’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?`;
const SYM = Object.keys(SYMBOLS)
  .sort((a, b) => b.length - a.length)
  .map((s) => s.replace(/[$.]/g, "\\$&"))
  .join("|");
const CODE = "[A-Z]{3}";

// Order matters: the first alternative that matches at a position wins.
const PATTERN = new RegExp(
  [
    // Money with the currency first: "R 1 250,00", "-R50.00", "ZAR1,250.00", "€ 9,99".
    String.raw`(?<moneyA>[-−]?(?<![\p{L}\d])(?:${SYM}|${CODE})\s?[-−]?(?:${NUM})(?![\d\p{L}]))`,
    // Money with the currency last: "1.250,00 €", "1 250,00 EUR".
    String.raw`(?<moneyB>[-−]?(?<![\d.,])(?:${NUM})\s?(?:${SYM}|${CODE})(?![\p{L}\d]))`,
    String.raw`(?<date>\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}[./-]\d{1,2}[./-](?:\d{4}|\d{2})\b)`,
    String.raw`(?<time>\b\d{1,2}[:h]\d{2}(?::\d{2})?(?:\s?[AaPp]\.?[Mm]\.?)?(?![\d:]))`,
    // Masked account and card numbers: "***0700", "..1234", "••1234", "xxxx1234", "*1234".
    // One mask character only when the digits follow at once ("*1234"), so "· 12" stays a dot and a
    // number; never a lone "#", which numbers receipts and orders ("#2378-2930").
    String.raw`(?<acct>(?:(?:[*•·xX#]{2,}|\.{2,})\s?|[*•·])\d{2,6}\b)`,
    // Bare numbers group with commas, dots or apostrophes, never spaces: "0860 123 456" is three numbers.
    String.raw`(?<num>\b(?:\d{1,3}(?:[.,'’]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\b)`,
    String.raw`(?<word>[\p{L}\p{M}][\p{L}\p{M}\p{N}'’&-]*|\d+[\p{L}][\p{L}\p{N}-]*)`,
    String.raw`(?<punct>[^\s\p{L}\p{N}])`,
  ].join("|"),
  "gu",
);

export function tokenize(text: string): Token[] {
  const { months, weekdays, codes } = tables();
  const out: Token[] = [];
  for (const m of text.matchAll(PATTERN)) {
    const g = m.groups ?? {};
    const raw = m[0];
    const start = m.index ?? 0;
    let type: TokenType;
    if (g.moneyA || g.moneyB) {
      // A three-letter word only counts as a currency when it's a real ISO code.
      // What's left once the number and sign are gone must be exactly a symbol or an ISO code
      // ("RIO 1.4" is a car, not rands).
      const unit = raw.replace(/[-−\s  ]/g, "").replace(/[\d.,'’]+/g, "");
      const code = /^[A-Z]{3}$/.test(unit) ? unit : undefined;
      const symbol = unit in SYMBOLS;
      if (!symbol && (!code || !codes.has(code))) {
        pushPlain(out, raw, start);
        continue;
      }
      type = "money";
    } else if (g.date) type = "date";
    else if (g.time) type = "time";
    else if (g.acct) type = "acct";
    else if (g.num) type = "num";
    else if (g.word) {
      const lower = raw.toLowerCase().replace(/\.$/, "");
      // Words with digits are codes ("QK7H2X9P", "TS4821933", "Sixty60"): they vary like values.
      if (/\d/.test(raw)) type = "code";
      else if (months.has(lower)) type = "month";
      else if (weekdays.has(lower)) type = "weekday";
      else type = "word";
    } else type = "punct";
    out.push({ text: raw, type, start, end: start + raw.length });
  }
  return out;
}

/** A currency-looking match that isn't money ("ABC123"): read it again as ordinary tokens. */
function pushPlain(out: Token[], raw: string, offset: number) {
  for (const m of raw.matchAll(/\d+(?:[.,]\d+)*|[\p{L}\p{M}]+|[^\s\p{L}\p{N}]/gu) ) {
    const start = offset + (m.index ?? 0);
    const type: TokenType = /^\d/.test(m[0]) ? "num" : /\p{L}/u.test(m[0]) ? "word" : "punct";
    out.push({ text: m[0], type, start, end: start + m[0].length });
  }
}

export type Amount = { value: number; currency: string; unsure: boolean };

/** Splits "R 1 250,00" into the currency part and the digits part. */
function splitMoney(raw: string): { currency: string; digits: string; negative: boolean } {
  const negative = /^[-−]|[-−]\s?\d/.test(raw);
  const digits = raw.match(/\d[\d   .,'’]*\d|\d/)?.[0] ?? "";
  const rest = raw.replace(digits, "").replace(/[-−\s]/g, "");
  const currency = SYMBOLS[rest] ?? (/^[A-Z]{3}$/.test(rest) ? rest : rest || "");
  return { currency, digits, negative };
}

/** The separator a single example proves is the decimal one, or null when it proves nothing. */
function decimalOf(digits: string): "." | "," | null {
  const seps = [...digits.matchAll(/[.,]/g)].map((m) => ({ sep: m[0] as "." | ",", at: m.index ?? 0 }));
  if (!seps.length) return null;
  const last = seps[seps.length - 1];
  const after = digits.length - last.at - 1;
  // Both kinds present: the last one is the decimal ("1.250,00", "1,250.00").
  if (seps.some((s) => s.sep !== last.sep)) return last.sep;
  // The same separator twice can only be grouping ("1.250.000").
  if (seps.length > 1) return last.sep === "." ? "," : ".";
  // Spaces or apostrophes group, so a lone dot or comma after them is the decimal ("1 250,00").
  if (/[   '’]/.test(digits)) return last.sep;
  // One or two digits after: decimal ("9,99", "250.5"). Three is ambiguous.
  return after === 3 ? null : last.sep;
}

export function parseAmount(raw: string): Amount | null {
  const { currency, digits, negative } = splitMoney(raw);
  if (!digits) return null;
  const own = decimalOf(digits);
  let decimal = own;
  let unsure = false;
  if (!own && /[.,]\d{3}$/.test(digits)) {
    // "1,250" alone: read it as grouping (the common case) but say so.
    unsure = true;
    decimal = digits.includes(",") ? "." : ",";
  }
  let clean = digits.replace(/[   '’]/g, "");
  if (decimal) {
    const group = decimal === "." ? "," : ".";
    clean = clean.split(group).join("").replace(decimal, ".");
  } else clean = clean.replace(/[.,]/g, "");
  const value = Number(clean);
  if (!Number.isFinite(value)) return null;
  return { value: negative ? -value : value, currency, unsure };
}

/** A date in the text as an ISO time, or null when there's no day and month. */
export function parseDate(text: string, sentAt: string, dayFirst = true): string | null {
  const sent = new Date(sentAt);
  const tokens = tokenize(text);
  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let hours = 0;
  let minutes = 0;
  for (const t of tokens) {
    if (t.type === "date") {
      const parts = t.text.split(/[./-]/).map(Number);
      if (t.text.match(/^\d{4}-/)) [year, month, day] = [parts[0], parts[1] - 1, parts[2]];
      else {
        const [a, b, c] = parts;
        const first = dayFirst || a > 12;
        [day, month] = first && b <= 12 ? [a, b - 1] : [b, a - 1];
        year = c < 100 ? 2000 + c : c;
      }
    } else if (t.type === "month") month = monthIndex(t.text);
    else if (t.type === "time") {
      const [h, m] = t.text.split(/[:h]/).map((x) => parseInt(x, 10));
      hours = h + (/p/i.test(t.text) && h < 12 ? 12 : 0) - (/a/i.test(t.text) && h === 12 ? 12 : 0);
      minutes = m;
    } else if (t.type === "num") {
      const n = Number(t.text);
      if (n >= 1900 && n < 2200) year = n;
      else if (n >= 1 && n <= 31 && day == null) day = n;
    }
  }
  if (month == null || day == null) return null;
  const date = new Date(year ?? sent.getFullYear(), month, day, hours, minutes);
  // No year in the text: the one that puts it nearest the email ("30 December" in a January email
  // was last year's, "3 January" in a December one is next year's).
  if (year == null) {
    const half = 1000 * 60 * 60 * 24 * 183;
    if (date.getTime() - sent.getTime() > half) date.setFullYear(date.getFullYear() - 1);
    else if (sent.getTime() - date.getTime() > half) date.setFullYear(date.getFullYear() + 1);
  }
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** An amount in its currency, the way the user's locale writes it (a plain number with no currency). */
export function formatAmount(value: number, currency: string) {
  if (!currency) return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}
