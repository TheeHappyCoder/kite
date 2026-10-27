// Splits a message into the new text, the signature and the quoted history.
// Shared by client and server, so it never touches the DOM: HTML is scanned as a string.
//
// Lossless by construction: for HTML, `fresh + signature + quoted === html`; for text,
// the three parts are slices of the original lines. When unsure, everything stays `fresh`.

type QuoteKind = "reply" | "forward";

export type SplitText = {
  fresh: string;
  signature: string;
  quoted: string;
  /** The "On … wrote:" or "From: … Sent: …" header of the quoted part, when there is one. */
  attribution?: string;
  kind?: QuoteKind;
};

type SplitHtml = SplitText;

// ---------- Plain text ----------

const ATTRIBUTION_START = /^(on|am|le|el|op|em|il|den|w dniu|dne|på)\b/i;
const ATTRIBUTION_END =
  /(wrote|schrieb|a écrit|escribió|escribio|schreef|escreveu|ha scritto|skrev|geskryf|napisał|napisal|kirjoitti|написал\(а\)|написал|yazdı)\s*:?\s*$/i;
/** German, Dutch and Scandinavian put the name after the verb: "… schrieb Max <m@x.de>:". */
const ATTRIBUTION_END_NAMED = /\b(schrieb|schreef|skrev|geskryf|kirjoitti)\s.{1,160}:\s*$/i;
const isAttributionEnd = (text: string) => ATTRIBUTION_END.test(text) || ATTRIBUTION_END_NAMED.test(text);
const HEADER_FROM = /^\s*\**(from|von|de|van|da|från|fra|od|от)\s*:\**\s*\S/i;
const HEADER_REST = /^\s*\**(sent|date|gesendet|datum|envoyé|enviado|verzonden|inviato|skickat|sendt|to|an|à|para|aan|a|till|til|subject|betreff|objet|asunto|assunto|onderwerp|oggetto|ämne|emne|cc)\s*:\**/i;
const ORIGINAL = /^\s*-{2,}\s*(original message|ursprüngliche nachricht|message d'origine|mensaje original|mensagem original|oorspronkelijk bericht|messaggio originale)\s*-{2,}\s*$/i;
const FORWARDED = /^\s*-{2,}\s*(forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado|mensagem encaminhada|doorgestuurd bericht|messaggio inoltrato)\s*-{2,}\s*$/i;
const BEGIN_FORWARDED = /^\s*begin forwarded message:\s*$/i;
const SENT_FROM =
  /^\s*(sent from my \w[\w ]{0,30}|sent from (outlook|mail|yahoo mail|gmail|proton mail|my phone)\b.{0,40}|get outlook for \w+.{0,20}|sent via \w[\w ]{0,30}|von meinem \w[\w ]{0,30} gesendet|envoyé de mon \w[\w ]{0,30}|enviado desde mi \w[\w ]{0,30}|enviado do meu \w[\w ]{0,30}|verstuurd vanaf mijn \w[\w ]{0,30}|inviato da (il mio )?\w[\w ]{0,30}|skickat från min \w[\w ]{0,30})\s*$/i;
const SIG_DELIMITER = /^-- ?$/;
/** Signatures longer than this after "-- " are probably not signatures. */
const MAX_SIGNATURE_LINES = 15;

const isQuoteLine = (line: string) => /^\s*>/.test(line);
const isBlank = (line: string) => !line.trim();

/** Finds where the quoted history starts, or -1. */
function quoteStart(lines: string[]): { index: number; kind: QuoteKind; attribution?: string } | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FORWARDED.test(line) || BEGIN_FORWARDED.test(line)) return { index: i, kind: "forward", attribution: line.trim() };
    if (ORIGINAL.test(line)) return { index: i, kind: "reply", attribution: line.trim() };

    // Outlook: "From: …" followed within a few lines by "Sent:/Date:" and "Subject:".
    if (HEADER_FROM.test(line)) {
      const block = lines.slice(i + 1, i + 7).filter((l) => !isBlank(l));
      const rest = block.filter((l) => HEADER_REST.test(l)).length;
      if (rest >= 2 && block.slice(0, 2).every((l) => HEADER_REST.test(l))) {
        const end = i + 1 + lines.slice(i + 1, i + 7).findLastIndex((l) => HEADER_REST.test(l));
        return { index: i, kind: "reply", attribution: lines.slice(i, end + 1).map((l) => l.trim()).join(" · ") };
      }
    }

    // "On <date>, <name> wrote:", sometimes wrapped over two or three lines.
    if (ATTRIBUTION_START.test(line.trim())) {
      for (let span = 1; span <= 3 && i + span <= lines.length; span++) {
        const joined = lines.slice(i, i + span).map((l) => l.trim()).join(" ");
        if (joined.length > 400) break;
        if (isAttributionEnd(joined)) {
          // Only when quoted lines (or nothing) follow, so a sentence like "On Monday Sam wrote:" mid-text stays.
          const next = lines.slice(i + span).find((l) => !isBlank(l));
          if (next === undefined || isQuoteLine(next)) return { index: i, kind: "reply", attribution: joined };
          break;
        }
      }
    }
  }

  // A final run of ">" lines (blank lines allowed) that reaches the end. Inline replies stay fresh.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isQuoteLine(lines[i])) start = i;
    else if (!isBlank(lines[i])) break;
  }
  if (start >= 0) return { index: start, kind: "reply" };
  return null;
}

/** Finds where the signature starts inside the fresh lines, or -1. */
function signatureStart(lines: string[]): number {
  const delimiter = lines.findLastIndex((l) => SIG_DELIMITER.test(l));
  if (delimiter >= 0 && lines.length - delimiter - 1 <= MAX_SIGNATURE_LINES) return delimiter;
  // "Sent from my iPhone" within the last three non-blank lines.
  const nonBlank = lines.map((l, i) => [l, i] as const).filter(([l]) => !isBlank(l)).slice(-3);
  const sent = nonBlank.find(([l]) => SENT_FROM.test(l));
  return sent ? sent[1] : -1;
}

function splitText(text: string): SplitText {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const quote = quoteStart(lines);
  const freshLines = quote ? lines.slice(0, quote.index) : lines;
  const quotedLines = quote ? lines.slice(quote.index) : [];
  const sig = signatureStart(freshLines);
  const fresh = (sig >= 0 ? freshLines.slice(0, sig) : freshLines).join("\n");
  const signature = sig >= 0 ? freshLines.slice(sig).join("\n") : "";
  // Nothing new written: show the message as it is.
  if (!fresh.trim()) return { fresh: text, signature: "", quoted: "" };
  return {
    fresh: fresh.replace(/\s+$/, ""),
    signature: signature.trim(),
    quoted: quotedLines.join("\n").trim(),
    attribution: quote?.attribution,
    kind: quote?.kind,
  };
}

/** Message.body is paragraphs; split them as one text. */
function splitParagraphs(body: string[]): SplitText {
  return splitText(body.join("\n\n"));
}

/**
 * Joins lines a mail client hard-wrapped (plain text is often wrapped near 72–78 columns),
 * keeping short lines, lists and quotes as they are. For display only.
 */
export function unwrap(paragraph: string) {
  const lines = paragraph.split("\n");
  return lines.reduce((out, line, i) => {
    if (i === 0) return line;
    const previous = lines[i - 1];
    const wrapped = previous.length >= 60 && previous.length <= 80 && /\S$/.test(previous) && /^[\p{Ll}\p{N}(]/u.test(line.trim());
    return out + (wrapped ? " " : "\n") + line;
  }, "");
}

export function paragraphs(text: string) {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
}

// ---------- HTML ----------

type Marker = { pattern: RegExp; kind?: QuoteKind; /** The rest of the message after it is quoted, whatever follows. */ toEnd?: boolean };

// Opening tags that start quoted history, most specific first.
const QUOTE_MARKERS: Marker[] = [
  { pattern: /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b[^"']*["'][^>]*>/gi },
  { pattern: /<blockquote\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b[^"']*["'][^>]*>/gi },
  { pattern: /<div\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_extra\b[^"']*["'][^>]*>/gi },
  { pattern: /<div\b[^>]*\bid\s*=\s*["']?(divRplyFwdMsg|appendonsend|mail-editor-reference-message-container)\b[^>]*>/gi, toEnd: true },
  { pattern: /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(yahoo_quoted|moz-cite-prefix|protonmail_quote)\b[^"']*["'][^>]*>/gi },
  { pattern: /<blockquote\b[^>]*\btype\s*=\s*["']?cite\b[^>]*>/gi },
];

// Outlook desktop: a top-bordered div whose text starts with "From:".
const OUTLOOK_SEPARATOR = /<(div|p)\b[^>]*style\s*=\s*["'][^"']*border-top\s*:\s*solid[^"']*["'][^>]*>/gi;
const OUTLOOK_HR = /<hr\b[^>]*>/gi;

const SIGNATURE_MARKERS = [
  /<span\b[^>]*\bclass\s*=\s*["'][^"']*\bgmail_signature_prefix\b[^"']*["'][^>]*>/gi,
  /<div\b[^>]*\b(class|data-smartmail)\s*=\s*["'][^"']*\bgmail_signature\b[^"']*["'][^>]*>/gi,
  /<div\b[^>]*\bid\s*=\s*["']?(Signature|signature|ms-outlook-mobile-signature|AppleMailSignature)\b[^>]*>/g,
  /<div\b[^>]*\bclass\s*=\s*["'][^"']*\b(moz-signature|protonmail_signature_block|kite-signature)\b[^"']*["'][^>]*>/gi,
];

/** Text of an HTML fragment: tags removed, block ends become line breaks, entities decoded. */
export function htmlToText(html: string) {
  return decodeEntities(
    html
      .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote|table)\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeEntities(value: string) {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Index just past the element that opens at `start`, matching nested tags of the same name; -1 if unclosed. */
function elementEnd(html: string, start: number): number {
  const name = /^<([a-z0-9]+)/i.exec(html.slice(start))?.[1];
  if (!name) return -1;
  const tag = new RegExp(`<(/?)${name}\\b[^>]*>`, "gi");
  tag.lastIndex = start;
  let depth = 0;
  for (let m = tag.exec(html); m; m = tag.exec(html)) {
    depth += m[1] ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

function firstMatch(html: string, pattern: RegExp, from = 0) {
  pattern.lastIndex = from;
  const m = pattern.exec(html);
  return m ? { index: m.index, tag: m[0] } : null;
}

const hasText = (html: string) => htmlToText(html).replace(/\s/g, "").length > 0;

/** Where quoted history starts in the HTML, or null. */
function htmlQuoteStart(html: string): { index: number; kind: QuoteKind } | null {
  const candidates: { index: number; toEnd: boolean }[] = [];
  for (const marker of QUOTE_MARKERS) {
    const m = firstMatch(html, marker.pattern);
    if (m) candidates.push({ index: m.index, toEnd: !!marker.toEnd });
  }
  for (const pattern of [OUTLOOK_SEPARATOR, OUTLOOK_HR]) {
    for (let m = firstMatch(html, pattern); m; m = firstMatch(html, pattern, m.index + m.tag.length)) {
      // A header block like the text one: "From:" then at least two of Sent / To / Subject (a newsletter's "From: the editors" isn't one).
      const [first, ...rest] = htmlToText(html.slice(m.index, m.index + 2000)).split("\n").filter((l) => !isBlank(l));
      if (first && HEADER_FROM.test(first) && rest.slice(0, 6).filter((l) => HEADER_REST.test(l)).length >= 2) {
        candidates.push({ index: m.index, toEnd: true });
        break;
      }
    }
  }
  candidates.sort((a, b) => a.index - b.index);

  for (const candidate of candidates) {
    let index = candidate.index;
    if (!candidate.toEnd) {
      const end = elementEnd(html, index);
      // Text after the quote means an inline or bottom-posted reply: keep it all.
      if (end < 0 || hasText(stripTrailingWrappers(withoutQuotes(html.slice(end))))) continue;
    }
    // Outlook web puts an <hr> right before divRplyFwdMsg.
    const before = html.slice(0, index);
    const hr = /<hr\b[^>]*>\s*$/i.exec(before);
    if (hr) index = hr.index;
    index = attributionStart(html, index);
    if (!hasText(html.slice(0, index))) continue;
    const head = htmlToText(html.slice(index, index + 3000));
    const kind: QuoteKind = FORWARDED.test(head.split("\n").find((l) => l.trim()) ?? "") || /^\s*begin forwarded message/i.test(head) ? "forward" : "reply";
    return { index, kind };
  }
  return null;
}

/** Removes quote elements (Apple Mail sends several blockquotes in a row). */
function withoutQuotes(html: string) {
  for (let guard = 0; guard < 50; guard++) {
    const starts = QUOTE_MARKERS.map((marker) => firstMatch(html, marker.pattern)?.index ?? -1).filter((i) => i >= 0);
    if (!starts.length) return html;
    const start = Math.min(...starts);
    const end = elementEnd(html, start);
    if (end < 0) return html;
    html = html.slice(0, start) + html.slice(end);
  }
  return html;
}

/** Closing tags and empty wrappers only (what's left after a quote at the end). */
function stripTrailingWrappers(html: string) {
  return html.replace(/<\/?(div|span|p|br|body|html|font|o:p)\b[^>]*>/gi, "");
}

/**
 * Apple Mail and Thunderbird put "On …, X wrote:" just before the blockquote, outside it.
 * Moves the split back to the start of that line when the text right before the quote is one.
 */
function attributionStart(html: string, index: number) {
  const window = html.slice(Math.max(0, index - 1500), index);
  const offset = Math.max(0, index - 1500);
  // Candidate cut points: the start of each block-ish tag in the window, nearest first.
  const cuts = [...window.matchAll(/<(div|p|br|span)\b[^>]*>/gi)].map((m) => offset + m.index!).reverse();
  for (const cut of cuts.slice(0, 6)) {
    const text = htmlToText(html.slice(cut, index)).replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > 400) break;
    if (ATTRIBUTION_START.test(text) && isAttributionEnd(text)) return cut;
  }
  return index;
}

function htmlSignatureStart(fresh: string): number {
  let best = -1;
  for (const pattern of SIGNATURE_MARKERS) {
    const m = firstMatch(fresh, pattern);
    if (m && (best < 0 || m.index < best)) best = m.index;
  }
  if (best >= 0 && hasText(fresh.slice(0, best))) return best;

  // "Sent from my iPhone" as the last line, in its own block or after a <br>.
  const tail = lastTextRun(fresh);
  if (tail && SENT_FROM.test(decodeEntities(tail.text).trim())) {
    const lower = fresh.slice(Math.max(0, tail.start - 400), tail.start).toLowerCase();
    const offset = Math.max(0, tail.start - 400);
    const cut = Math.max(lower.lastIndexOf("<div"), lower.lastIndexOf("<p"), lower.lastIndexOf("<br"));
    if (cut >= 0 && SENT_FROM.test(htmlToText(fresh.slice(offset + cut))) && hasText(fresh.slice(0, offset + cut))) return offset + cut;
  }

  // "-- " on its own line followed by a short block.
  const dash = /(<(?:div|p|br)\b[^>]*>)\s*--(?:&nbsp;|\s)?\s*(<br\s*\/?>|<\/div>|<\/p>)/gi;
  let last: number = -1;
  for (let m = dash.exec(fresh); m; m = dash.exec(fresh)) last = m.index;
  if (last >= 0 && hasText(fresh.slice(0, last))) {
    const lines = htmlToText(fresh.slice(last)).split("\n").filter((l) => l.trim());
    if (lines.length <= MAX_SIGNATURE_LINES + 1) return last;
  }
  return -1;
}

/** The last non-blank text between tags (scanned from the end, so linear). */
function lastTextRun(html: string): { start: number; text: string } | null {
  let end = html.length;
  while (end > 0) {
    const close = html.lastIndexOf(">", end - 1);
    const text = html.slice(close + 1, end);
    if (text.trim()) return { start: close + 1, text };
    if (close < 0) return null;
    end = html.lastIndexOf("<", close);
  }
  return null;
}

/** Past this size (huge newsletters) splitting isn't worth the scan; the message shows as is. */
const MAX_SPLIT_HTML = 400_000;

function splitHtml(html: string): SplitHtml {
  if (html.length > MAX_SPLIT_HTML) return { fresh: html, signature: "", quoted: "" };
  const quote = htmlQuoteStart(html);
  const head = quote ? html.slice(0, quote.index) : html;
  const quoted = quote ? html.slice(quote.index) : "";
  const sig = htmlSignatureStart(head);
  const fresh = sig >= 0 ? head.slice(0, sig) : head;
  const signature = sig >= 0 ? head.slice(sig) : "";
  if (!hasText(fresh) && !/<img\b/i.test(fresh)) return { fresh: html, signature: "", quoted: "" };
  const attribution = quote ? htmlToText(quoted).split("\n").find((l) => l.trim())?.trim() : undefined;
  return { fresh, signature, quoted, attribution: attribution?.slice(0, 300), kind: quote?.kind };
}

/**
 * Gmail's snippet is one line, ~200 characters, often running into the quote.
 * Cuts it where a reply header starts ("On Tue, …", "From: …", "--- Forwarded"), for previews only.
 */
export function snippetFresh(snippet: string) {
  const cut = snippet.search(/\s(On (Mon|Tue|Wed|Thu|Fri|Sat|Sun|\d{1,2}\s|[A-Z][a-z]{2} \d)|From: |\*From: \*|-{5,}\s*(Forwarded|Original))/);
  return (cut > 0 ? snippet.slice(0, cut) : snippet).trim();
}

// ---------- Messages ----------

type Splittable = { html?: string; body: string[]; snippet?: string };

/** Splits whichever body the reader shows (HTML when there is one). */
export function splitMessage(message: Splittable): { html?: SplitHtml; text: SplitText } {
  if (message.html) {
    const html = splitHtml(message.html);
    // Bubbles and snippets use text: prefer the plain part, split on its own. A plain part a
    // service generated from the HTML (Outlook) loses the markers, so when only the HTML split
    // found a signature or quote (and everything the plain split found), its text is used instead.
    const plain = message.body.length ? splitParagraphs(message.body) : null;
    const parts = (s: { signature: string; quoted: string }) => [!!s.signature, !!s.quoted];
    const [htmlSig, htmlQuote] = parts(html);
    const [plainSig, plainQuote] = plain ? parts(plain) : [false, false];
    const htmlFoundMore = (htmlSig || !plainSig) && (htmlQuote || !plainQuote) && (htmlSig !== plainSig || htmlQuote !== plainQuote);
    return { html, text: plain && !htmlFoundMore ? plain : textFromHtmlSplit(html) };
  }
  return { text: message.body.length ? splitParagraphs(message.body) : { fresh: message.snippet ?? "", signature: "", quoted: "" } };
}

/**
 * One-line preview of a message's new text: the stored `preview` (set on the server),
 * else split the body when it's here, else trim Gmail's snippet.
 */
export function messagePreview(message: Splittable & { preview?: string }) {
  if (message.preview) return message.preview;
  const loaded = message.body.length > 0 || !!message.html;
  return (loaded ? freshPreview(message) : "") || cleanPreview(snippetFresh(message.snippet ?? ""));
}

/** The new text on one line (up to 200 characters), without image placeholders. Empty when there's none. */
export function freshPreview(message: Splittable) {
  return cleanPreview(splitMessage(message).text.fresh).slice(0, 200);
}

/** Outlook and Gmail put "[Image]" / "[image: logo]" where pictures were in the plain-text part. */
function cleanPreview(text: string) {
  return text
    .replace(/\[(image|cid|inline image)[^\]]*\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textFromHtmlSplit(split: SplitHtml): SplitText {
  return {
    fresh: htmlToText(split.fresh),
    signature: htmlToText(split.signature),
    quoted: htmlToText(split.quoted),
    attribution: split.attribution,
    kind: split.kind,
  };
}

/** The last Message-ID this message replies to: In-Reply-To, else the end of References. */
export function parentMessageId(message: { inReplyTo?: string; references?: string }) {
  const raw = message.inReplyTo || message.references?.trim().split(/\s+/).pop();
  return raw ? raw.trim().replace(/^<|>$/g, "") : undefined;
}

export function normaliseMessageId(id: string | undefined) {
  return id?.trim().replace(/^<|>$/g, "");
}
