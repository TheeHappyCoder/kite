import { escapeHtml } from "../format";

// Inline markup inside kite-design/1 text blocks: **bold**, *italic*, [label](https://…),
// {#16a34a|coloured text} and line breaks; `\` keeps the next character literal (\* \[ \{).
// A colour run holds markup of its own (bold, links); a link inside takes the run's colour.
// The design editor never shows this syntax: its text field writes it (components/design/text-field.tsx).

const ESCAPE = /\\([\\*[\](){}|#])/g;
const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)/g;
const COLOUR = /\{(#[0-9a-fA-F]{6})\|([^{}\n]+)\}/g;
const SAFE_URL = /^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/;

export type InlineStyle = {
  /** The anchor for a link: `href` and `label` are HTML already. */
  link: (href: string, label: string, colour: string | null) => string;
  /** A coloured run: `inner` is HTML already. */
  colour: (hex: string, inner: string) => string;
};

/** Markup -> HTML, with slots for what the caller wants links and colours to look like. */
export function inlineToHtml(text: string, style: InlineStyle, colour: string | null = null): string {
  const literal: string[] = [];
  let s = text.replace(ESCAPE, (_, c: string) => `\u0001${literal.push(c) - 1}\u0001`);
  // Colour runs first: each one's inside is markup again, so links in it take its colour.
  const runs: string[] = [];
  s = s.replace(COLOUR, (_, hex: string, inner: string) => `\u0003${runs.push(style.colour(hex.toLowerCase(), inlineToHtml(restore(inner, literal), style, hex.toLowerCase()))) - 1}\u0003`);
  // Then links, so their URLs aren't touched by the emphasis rules.
  const links: string[] = [];
  s = s.replace(LINK, (_, label: string, url: string) => {
    const href = SAFE_URL.test(url) ? escapeHtml(url) : "#";
    return `\u0002${links.push(style.link(href, emphasis(escapeHtml(label)), colour)) - 1}\u0002`;
  });
  s = emphasis(escapeHtml(s)).replace(/\r?\n/g, "<br>");
  // Links may hold colour runs and the other way round, so put both back until none are left.
  for (let i = 0; i < 3 && /[\u0002\u0003]/.test(s); i++) {
    s = s.replace(/\u0002(\d+)\u0002/g, (_, n: string) => links[Number(n)]).replace(/\u0003(\d+)\u0003/g, (_, n: string) => runs[Number(n)]);
  }
  return s.replace(/\u0001(\d+)\u0001/g, (_, n: string) => escapeHtml(literal[Number(n)]));
}

/** Escaped characters held aside are put back as escapes, so a colour run's inside reads them again. */
function restore(text: string, literal: string[]) {
  return text.replace(/\u0001(\d+)\u0001/g, (_, n: string) => `\\${literal[Number(n)]}`);
}

function emphasis(html: string) {
  return html
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

/** Markup -> plain text: links become "label <url>", colours and emphasis go. */
export function inlineToText(text: string) {
  const literal: string[] = [];
  return text
    .replace(ESCAPE, (_, c: string) => `\u0001${literal.push(c) - 1}\u0001`)
    .replace(COLOUR, (_, __: string, inner: string) => inner)
    .replace(LINK, (_, label: string, url: string) => {
      const bare = url.replace(/^(mailto:|tel:)/, "");
      const digits = (s: string) => s.replace(/\D/g, "");
      const same = label === url || label === bare || (url.startsWith("tel:") && digits(label) === digits(bare));
      return same ? label : `${label} <${bare}>`;
    })
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/\u0001(\d+)\u0001/g, (_, n: string) => literal[Number(n)]);
}

/** Characters that would read as markup, escaped for a run of plain text. */
export function escapeDesignText(text: string) {
  return text.replace(/[\\*[\]{}]/g, "\\$&");
}
