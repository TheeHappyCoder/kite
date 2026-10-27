// Printed labels on flat PDFs ("Name:", "ID No: ______"): where they are and where their answer
// goes. Pure data in (pdf.js text positions, see print.ts), blanks out, so the profile filler and
// later an AI layer drive it the same way. A page without a text layer has no blanks.

/** A piece of printed text in PDF user space: `x, y` is the start of its baseline. */
export type TextItem = { str: string; x: number; y: number; w: number; size: number };

/** `right` is the page's right edge in user space. */
export type TextPage = { items: TextItem[]; right: number };

/** Where an answer to a printed label goes. `x, y` is the start of the answer's baseline. */
export type Blank = {
  id: string;
  page: number;
  /** The label as printed, without its colon. */
  label: string;
  x: number;
  y: number;
  /** Room for the answer, in points. */
  w: number;
  /** The label's text size, so the answer matches it. */
  size: number;
};

type Rect = { x: number; y: number; width: number; height: number };

/** Answers need at least this much room after the label; otherwise the line below is tried. */
const MIN_ROOM = 60;
const MARGIN = 30;

type Char = { c: string; x0: number; x1: number };
type Token = { type: "text" | "colon" | "leader" | "gap"; text: string; x0: number; x1: number };

function lines(items: TextItem[]) {
  const sorted = items.filter((i) => i.str.length && i.size > 0).sort((a, b) => b.y - a.y || a.x - b.x);
  const out: { y: number; size: number; items: TextItem[] }[] = [];
  for (const item of sorted) {
    const line = out.find((l) => Math.abs(l.y - item.y) <= Math.max(2, Math.min(l.size, item.size) * 0.35));
    if (line) {
      line.items.push(item);
      line.size = Math.max(line.size, item.size);
    } else out.push({ y: item.y, size: item.size, items: [item] });
  }
  for (const line of out) line.items.sort((a, b) => a.x - b.x);
  return out;
}

/** The line's characters with their x positions; big gaps between pieces become a "\t". */
function chars(line: { size: number; items: TextItem[] }) {
  const out: Char[] = [];
  let end = -Infinity;
  for (const item of line.items) {
    if (out.length && item.x - end > line.size * 1.5) out.push({ c: "\t", x0: end, x1: item.x });
    else if (out.length && item.x - end > line.size * 0.15) out.push({ c: " ", x0: end, x1: item.x });
    const step = item.w / Math.max(1, item.str.length);
    [...item.str].forEach((c, i) => out.push({ c, x0: item.x + step * i, x1: item.x + step * (i + 1) }));
    end = Math.max(end, item.x + item.w);
  }
  return out;
}

const LEADER = /[_.…\-]/;

function tokens(cs: Char[]) {
  const out: Token[] = [];
  let i = 0;
  while (i < cs.length) {
    const c = cs[i].c;
    if (c === "\t") {
      out.push({ type: "gap", text: c, x0: cs[i].x0, x1: cs[i].x1 });
      i++;
      continue;
    }
    // A leader is a run of 3+ underscores, dots or dashes (spaces inside allowed).
    if (LEADER.test(c)) {
      let j = i;
      let marks = 0;
      while (j < cs.length && (LEADER.test(cs[j].c) || cs[j].c === " ")) {
        if (cs[j].c !== " ") marks++;
        j++;
      }
      if (marks >= 3) {
        out.push({ type: "leader", text: "", x0: cs[i].x0, x1: cs[j - 1].x1 });
        i = j;
        continue;
      }
    }
    if (c === ":") {
      out.push({ type: "colon", text: c, x0: cs[i].x0, x1: cs[i].x1 });
      i++;
      continue;
    }
    const last = out[out.length - 1];
    if (last?.type === "text") {
      last.text += c;
      last.x1 = cs[i].x1;
    } else if (c !== " ") out.push({ type: "text", text: c, x0: cs[i].x0, x1: cs[i].x1 });
    i++;
  }
  for (const t of out) if (t.type === "text") t.text = t.text.trim();
  return out.filter((t) => t.type !== "text" || t.text);
}

/** A text token is a label when a colon or a leader follows it (short ones only). */
function isLabel(ts: Token[], i: number) {
  const t = ts[i];
  if (t.type !== "text" || t.text.split(/\s+/).length > 10 || !/[a-z]/i.test(t.text)) return false;
  const next = ts[i + 1];
  return next?.type === "colon" || next?.type === "leader";
}

function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** Blanks after printed labels. `fields` are the page's form widgets: blanks over them are skipped. */
export function findBlanks(pages: TextPage[], fields: { page: number; rect: Rect }[] = []): Blank[] {
  const blanks: Blank[] = [];
  pages.forEach((page, p) => {
    const all = lines(page.items).map((line) => ({ ...line, tokens: tokens(chars(line)) }));
    const right = page.right - MARGIN;
    const widgets = fields.filter((f) => f.page === p).map((f) => f.rect);
    // Printed words (not leaders): an answer never goes over them.
    const ink = all.flatMap((line) =>
      line.tokens
        .filter((t) => t.type === "text" || t.type === "colon")
        .map((t) => ({ x: t.x0, y: line.y - line.size * 0.2, width: t.x1 - t.x0, height: line.size })),
    );
    const busy = (r: Rect) => widgets.some((w) => overlaps(r, w)) || ink.some((w) => overlaps(r, w));

    for (const line of all) {
      const ts = line.tokens;
      ts.forEach((t, i) => {
        if (!isLabel(ts, i)) return;
        let j = i + 1;
        const start = ts[j].type === "colon" ? ts[j].x1 : t.x1;
        if (ts[j].type === "colon") j++;
        while (j < ts.length && (ts[j].type === "leader" || ts[j].type === "gap")) j++;
        const leader = ts.slice(i + 1, j).find((x) => x.type === "leader");
        const next = ts[j];
        let end: number;
        // A printed leader ("______") marks exactly where the answer goes.
        if (leader) end = leader.x1;
        else if (!next) end = right;
        else if (isLabel(ts, j)) end = next.x0 - 4;
        // Plain text right after the label: it's already answered, or it isn't a label.
        else if (next.x0 - start >= MIN_ROOM * 1.5) end = next.x0 - 4;
        else return;
        const label = t.text.replace(/\s+/g, " ");
        const size = line.size;
        const x = leader ? leader.x0 + 2 : start + size * 0.4;
        const y = line.y + (leader ? size * 0.15 : 0);
        const w = end - x;
        const id = `${p}:${Math.round(t.x0)}:${Math.round(line.y)}`;
        if (w >= (leader ? 20 : MIN_ROOM)) {
          if (!busy({ x: x + 1, y: y - size * 0.1, width: w - 2, height: size * 0.9 })) blanks.push({ id, page: p, label, x, y, w, size });
          return;
        }
        // No room on the line: the answer goes on the line below, under the label, if it's free.
        if (next || leader) return;
        const below = { x: t.x0, y: line.y - size * 1.7, w: Math.min(250, right - t.x0) };
        if (below.w < MIN_ROOM || below.y < MARGIN) return;
        if (busy({ x: below.x, y: below.y - size * 0.25, width: below.w, height: size * 1.2 })) return;
        blanks.push({ id, page: p, label, x: below.x, y: below.y, w: below.w, size });
      });
    }
  });
  return blanks;
}
