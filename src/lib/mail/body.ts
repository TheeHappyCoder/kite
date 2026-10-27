import { escapeHtml } from "../design/compile";

// Message bodies are plain text with light inline markup, the same syntax as kite-design/1
// text blocks: **bold**, *italic*, [label](https://…). Bodies add lists ("- " and "1. " at
// the start of a line) and backslash escapes for characters meant literally (\* \[ \]).
// One source, three outputs: email-safe HTML, plain text and the compose editor's HTML.

const BODY_IMAGE = /!\[([^\]\n]*)\]\(asset:([0-9a-f]{24})\)/g;
export const bodyImageIds = (body: string) => [...new Set([...body.matchAll(BODY_IMAGE)].map((m) => m[2]))];

const ESCAPE = /\\([\\*[\]()\-.#_`])/g;
const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)/g;
const SAFE_URL = /^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/;
const BULLET = /^- (.*)$/;
const NUMBER = /^(\d{1,3})\. (.*)$/;

/** The default link colour in sent mail. */
const BODY_LINK = "#1a5fd0";

type Line = { kind: "text"; text: string } | { kind: "bullet"; text: string } | { kind: "number"; n: string; text: string };

function lines(markup: string): Line[] {
  return markup.replace(/\r\n?/g, "\n").split("\n").map((raw) => {
    const bullet = raw.match(BULLET);
    if (bullet) return { kind: "bullet", text: bullet[1] };
    const number = raw.match(NUMBER);
    if (number) return { kind: "number", n: number[1], text: number[2] };
    return { kind: "text", text: raw };
  });
}

function emphasis(html: string) {
  return html
    .replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

/** Inline markup to HTML. `link` builds the anchor from an already-escaped href and label HTML. */
function inline(text: string, link: (href: string, label: string) => string, editor = false) {
  const literal: string[] = [];
  let s = text.replace(ESCAPE, (_, c: string) => `\u0001${literal.push(c) - 1}\u0001`);
  const images: string[] = [];
  s = s.replace(BODY_IMAGE, (_, alt: string, id: string) => `\u0003${images.push(`<img src="${editor ? `/api/assets/${id}` : `cid:${id}@kite`}" data-kite-image="${id}" alt="${escapeHtml(alt)}" style="max-width:100%;height:auto" />`) - 1}\u0003`);
  const links: string[] = [];
  s = s.replace(LINK, (_, label: string, url: string) => {
    const href = SAFE_URL.test(url) ? escapeHtml(url) : "#";
    return `\u0002${links.push(link(href, emphasis(escapeHtml(label)))) - 1}\u0002`;
  });
  s = emphasis(escapeHtml(s)).replace(/\u0002(\d+)\u0002/g, (_, i: string) => links[Number(i)]);
  s = s.replace(/\u0003(\d+)\u0003/g, (_, i: string) => images[Number(i)]);
  return s.replace(/\u0001(\d+)\u0001/g, (_, i: string) => escapeHtml(literal[Number(i)]));
}

/** Inline markup to plain text: links become "label <url>". */
function inlineText(text: string) {
  const literal: string[] = [];
  return text
    .replace(BODY_IMAGE, (_, alt: string) => alt || "Image")
    .replace(ESCAPE, (_, c: string) => `\u0001${literal.push(c) - 1}\u0001`)
    .replace(LINK, (_, label: string, url: string) => {
      const bare = url.replace(/^(mailto:|tel:)/, "");
      return label === url || label === bare ? label : `${label} <${bare}>`;
    })
    .replace(/\*\*\*(.+?)\*\*\*/g, "$1")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/\u0001(\d+)\u0001/g, (_, i: string) => literal[Number(i)]);
}

/** Groups lines into runs: consecutive list items of one kind, everything else alone. */
function groups(markup: string) {
  const out: { kind: Line["kind"]; items: Line[] }[] = [];
  for (const line of lines(markup)) {
    const last = out[out.length - 1];
    if (line.kind !== "text" && last?.kind === line.kind) last.items.push(line);
    else out.push({ kind: line.kind, items: [line] });
  }
  return out;
}

/** Email-safe HTML: paragraphs (blank-line separated) and lists, styles inline. */
export function bodyToHtml(markup: string, linkColor = BODY_LINK) {
  const link = (href: string, label: string) => `<a href="${href}" style="color:${linkColor};text-decoration:underline">${label}</a>`;
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) blocks.push(`<p style="margin:0 0 14px 0">${paragraph.join("<br>")}</p>`);
    paragraph = [];
  };
  for (const group of groups(markup.trim())) {
    if (group.kind === "text") {
      const text = group.items[0].text;
      if (text.trim()) paragraph.push(inline(text, link));
      else flush();
      continue;
    }
    flush();
    const tag = group.kind === "bullet" ? "ul" : "ol";
    const items = group.items.map((item) => `<li style="margin:0 0 4px 0">${inline(item.text, link)}</li>`).join("");
    blocks.push(`<${tag} style="margin:0 0 14px 0;padding:0 0 0 24px">${items}</${tag}>`);
  }
  flush();
  return blocks.join("");
}

/** Plain text: markup removed, list markers kept, line breaks kept. */
export function bodyToText(markup: string) {
  return lines(markup)
    .map((line) =>
      line.kind === "bullet" ? `- ${inlineText(line.text)}` : line.kind === "number" ? `${line.n}. ${inlineText(line.text)}` : inlineText(line.text),
    )
    .join("\n");
}

/** HTML for the compose editor: one <div> per line (as contenteditable makes them), lists as lists. */
export function bodyToEditorHtml(markup: string) {
  const link = (href: string, label: string) => `<a href="${href}">${label}</a>`;
  return groups(markup)
    .map((group) => {
      if (group.kind === "text") return `<div>${inline(group.items[0].text, link, true) || "<br>"}</div>`;
      const tag = group.kind === "bullet" ? "ul" : "ol";
      return `<${tag}>${group.items.map((item) => `<li>${inline(item.text, link, true) || "<br>"}</li>`).join("")}</${tag}>`;
    })
    .join("");
}

/** Characters that would otherwise read as markup, escaped inside a run of text. */
export function escapeInline(text: string) {
  return text.replace(/[\\*[\]]/g, "\\$&");
}

/** Keeps a text line that happens to start like a list item from becoming one. */
export function escapeLineStart(line: string) {
  return line.replace(/^- /, "\\- ").replace(/^(\d{1,3})\. /, "$1\\. ");
}

/** Plain text (old drafts, quick replies from before markup, other mail apps' drafts) as markup. */
export function escapeMarkup(text: string) {
  return text.replace(/\r\n?/g, "\n").split("\n").map((line) => escapeLineStart(escapeInline(line))).join("\n");
}

/** True when sending this body needs an HTML part (anything beyond plain lines). */
export function hasMarkup(markup: string) {
  return bodyToText(markup) !== markup.replace(/\r\n?/g, "\n") || lines(markup).some((l) => l.kind !== "text");
}
