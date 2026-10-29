import * as z from "zod";

// Forward with parts removed: what the user blacked out of a forwarded message, as data. The
// send applies it to the original when the forward is built (server/outgoing.ts) and the compose
// preview applies the same code, so what you see is what goes. Removed text is taken out of the
// HTML, never covered: nothing of it is left in the message to lift.

export const Redactions = z.object({
  /** Text taken out wherever it appears (any case; spaces and line breaks between words don't matter). */
  phrases: z.array(z.string().trim().min(1).max(500)).max(200).default([]),
  /** Pictures taken out, by their place among the message's <img> tags. */
  images: z.array(z.number().int().min(0).max(10_000)).max(200).default([]),
  /** Leave the "To:" line out of the forwarded header. */
  hideTo: z.boolean().default(false),
});
export type Redactions = z.infer<typeof Redactions>;

/** What stands in for removed text: always the same width, so it says nothing about the length. */
export const REMOVED = "█████";
/** Said under the forwarded header whenever something was taken out. */
export const REMOVED_NOTE = "Parts of this message were removed before forwarding.";

const BLOCK_STYLE = "background:#1b1b1f;color:#1b1b1f;border-radius:2px";
const IMAGE_STYLE = "display:inline-block;background:#1b1b1f;color:#ffffff;font:11px/1.6 sans-serif;padding:2px 8px;border-radius:3px";

export function hasRedactions(r: Redactions | undefined): r is Redactions {
  return !!r && (r.phrases.length > 0 || r.images.length > 0 || r.hideTo);
}

/** One pattern for every phrase, longest first; whitespace in a phrase matches any run of it, or none (text split by tags). */
export function phrasePattern(phrases: string[]): RegExp | null {
  const parts = [...new Set(phrases.map((p) => p.trim()).filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((p) => p.split(/\s+/).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"));
  return parts.length ? new RegExp(parts.join("|"), "giu") : null;
}

/** Plain text with the phrases taken out. */
export function redactText(text: string, r: Redactions | undefined) {
  const pattern = r ? phrasePattern(r.phrases) : null;
  return pattern ? text.replace(pattern, REMOVED) : text;
}

// ---------------------------------------------------------------------------
// HTML, without a DOM (runs on the server too)
// ---------------------------------------------------------------------------

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const ENTITY = /^&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/i;

/** Decoded text plus, for each decoded character, where it came from in the raw string. */
function decode(raw: string) {
  let text = "";
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < raw.length; ) {
    const entity = raw[i] === "&" ? raw.slice(i, i + 12).match(ENTITY) : null;
    let char: string | undefined;
    if (entity) {
      const name = entity[1];
      char = name[0] === "#" ? safeChar(name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)) : NAMED[name.toLowerCase()];
    }
    const length = char !== undefined && entity ? entity[0].length : 1;
    const value = char ?? raw[i];
    for (const unit of value) {
      text += unit;
      from.push(i);
      to.push(i + length);
    }
    i += length;
  }
  return { text, from, to };
}

function safeChar(code: number) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return undefined;
  }
}

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const decodeAttr = (s: string) => decode(s).text;

/** Attributes whose value is an address: one that names a removed phrase is dropped, not rewritten. */
const ADDRESS_ATTRS = new Set(["href", "src", "srcset", "background", "action", "cite", "poster", "data"]);
/** Text inside these isn't shown, so it isn't matched (and is left alone). */
const HIDDEN = new Set(["style", "script", "title", "head"]);

const TAG = /<!--[\s\S]*?-->|<[^>]*>/g;
const ATTR = /(\s+)([^\s=/>]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

function tagName(tag: string) {
  return tag.match(/^<\/?\s*([a-z0-9-]+)/i)?.[1].toLowerCase() ?? "";
}

/**
 * HTML with the phrases and pictures taken out. `mark` (the compose preview only) labels what
 * was removed so a click can bring it back: `data-kite-removed` with the phrase's index, and
 * `data-kite-img` with each picture's place.
 */
export function redactHtml(html: string, r: Redactions | undefined, { mark = false }: { mark?: boolean } = {}) {
  if (!r || (!hasRedactions(r) && !mark)) return html;
  const pattern = phrasePattern(r.phrases);
  const images = new Set(r.images);

  // Tokens: tags and the text between them.
  type Token = { tag: boolean; raw: string };
  const tokens: Token[] = [];
  let last = 0;
  for (const m of html.matchAll(TAG)) {
    if (m.index > last) tokens.push({ tag: false, raw: html.slice(last, m.index) });
    tokens.push({ tag: true, raw: m[0] });
    last = m.index + m[0].length;
  }
  if (last < html.length) tokens.push({ tag: false, raw: html.slice(last) });

  // Shown text, decoded and joined, so a phrase split across tags (<b>Jane</b> Smith) still matches.
  type Segment = { token: number; start: number; decoded: ReturnType<typeof decode> };
  const segments: Segment[] = [];
  let joined = "";
  let hidden: string | null = null;
  tokens.forEach((token, i) => {
    if (token.tag) {
      const name = tagName(token.raw);
      if (hidden) {
        if (token.raw.startsWith("</") && name === hidden) hidden = null;
      } else if (HIDDEN.has(name) && !token.raw.startsWith("</") && !token.raw.endsWith("/>")) hidden = name;
      return;
    }
    if (hidden) return;
    const decoded = decode(token.raw);
    segments.push({ token: i, start: joined.length, decoded });
    joined += decoded.text;
  });

  const removed = new Uint8Array(joined.length);
  const starts = new Map<number, number>();
  if (pattern) {
    for (const m of joined.matchAll(pattern)) {
      if (!m[0].length) continue;
      const which = phraseIndex(r.phrases, m[0]);
      starts.set(m.index, which);
      removed.fill(1, m.index, m.index + m[0].length);
    }
  }
  const block = (which: number) =>
    `<span style="${BLOCK_STYLE}"${mark ? ` data-kite-removed="${which}" title="Removed. Click to put it back."` : ""}>${REMOVED}</span>`;

  for (const segment of segments) {
    const { decoded, start } = segment;
    let out = "";
    let i = 0;
    while (i < decoded.text.length) {
      const at = start + i;
      if (removed[at]) {
        if (starts.has(at)) out += block(starts.get(at)!);
        i++;
        continue;
      }
      // Copy the raw source of this character (an entity stays an entity); skip the other halves of a pair.
      out += segmentRaw(tokens[segment.token].raw, decoded, i);
      i = nextRaw(decoded, i);
    }
    tokens[segment.token].raw = out;
  }

  // Tags: pictures by place, phrases in attributes (alt, title, a mailto: link…).
  let image = 0;
  for (const token of tokens) {
    if (!token.tag || token.raw.startsWith("<!--") || token.raw.startsWith("</")) continue;
    const name = tagName(token.raw);
    if (name === "img") {
      const place = image++;
      if (images.has(place)) {
        token.raw = `<span style="${IMAGE_STYLE}"${mark ? ` data-kite-img="${place}" data-kite-removed-img title="Removed. Click to put it back."` : ""}>Picture removed</span>`;
        continue;
      }
      if (mark) token.raw = token.raw.replace(/^<img\b/i, `<img data-kite-img="${place}"`);
    }
    if (!pattern) continue;
    token.raw = token.raw.replace(ATTR, (whole, space: string, attr: string, assign: string | undefined, value: string | undefined) => {
      if (!assign || !value) return whole;
      const unquoted = /^["']/.test(value) ? value.slice(1, -1) : value;
      const text = decodeAttr(unquoted);
      pattern.lastIndex = 0;
      if (!pattern.test(text)) return whole;
      pattern.lastIndex = 0;
      if (ADDRESS_ATTRS.has(attr.toLowerCase())) return "";
      return `${space}${attr}="${escapeAttr(text.replace(pattern, REMOVED))}"`;
    });
  }
  return tokens.map((t) => t.raw).join("");
}

/** The raw characters behind decoded character `i` (whole entity, or a single raw character). */
function segmentRaw(raw: string, decoded: ReturnType<typeof decode>, i: number) {
  return raw.slice(decoded.from[i], decoded.to[i]);
}

/** The next decoded character that starts a new raw source (an entity may decode to two units). */
function nextRaw(decoded: ReturnType<typeof decode>, i: number) {
  let j = i + 1;
  while (j < decoded.text.length && decoded.from[j] === decoded.from[i]) j++;
  return j;
}

/** Which phrase a match came from (for the preview's click-to-restore). */
function phraseIndex(phrases: string[], matched: string) {
  const squash = (s: string) => s.replace(/\s+/g, "").toLowerCase();
  const target = squash(matched);
  const index = phrases.findIndex((p) => squash(p) === target);
  return index < 0 ? 0 : index;
}
