// Screenshot marks (components/mail/screenshot): typed records in the image's own pixels, drawn
// over the captured email in order. Saving flattens them into the pixels, so a redaction can't be
// lifted out of the saved file.

export type Point = { x: number; y: number };
export type Rect = { x: number; y: number; w: number; h: number };

export type Annotation =
  /**
   * Hides what's under it. `mask` null: a solid black box. Otherwise the text is painted out in its
   * background colour and each word is written again in these characters (repeated in order), in the
   * text's colour; `layout` is where the lines and words were, read from the pixels once (maskLayout).
   */
  | ({ kind: "redact"; mask: string | null; layout?: MaskLayout } & Rect)
  /** A see-through marker over text (multiplied, so the text stays dark). */
  | ({ kind: "highlight"; color: string } & Rect)
  | { kind: "draw"; points: Point[]; color: string; size: number }
  /** `x`, `y`: the first line's top-left corner. */
  | { kind: "text"; x: number; y: number; text: string; color: string; size: number };

export type Tool = Annotation["kind"];

/** Mark colours: they're part of the picture, so plain values rather than theme tokens. */
export const MARK_COLOURS = [
  { id: "yellow", label: "Yellow", value: "#facc15" },
  { id: "green", label: "Green", value: "#4ade80" },
  { id: "pink", label: "Pink", value: "#f472b6" },
  { id: "blue", label: "Blue", value: "#60a5fa" },
  { id: "red", label: "Red", value: "#ef4444" },
  { id: "black", label: "Black", value: "#111111" },
] as const;

/** Pen and text sizes, in CSS pixels of the email as it was on screen (scaled to the image). */
export const MARK_SIZES = [
  { id: "s", label: "Small", pen: 3, text: 14 },
  { id: "m", label: "Medium", pen: 6, text: 20 },
  { id: "l", label: "Large", pen: 12, text: 30 },
] as const;
export type MarkSize = (typeof MARK_SIZES)[number]["id"];

const REDACT = "#000000";

/** Redaction styles: a box, or characters in place of each word (`custom`: the user's own). */
export const REDACT_STYLES = [
  { id: "box", label: "Box", mask: null },
  { id: "dots", label: "Dots", mask: "•" },
  { id: "stars", label: "Stars", mask: "*" },
  { id: "blocks", label: "Blocks", mask: "█" },
  { id: "custom", label: "Custom", mask: "" },
] as const;
export type RedactStyle = (typeof REDACT_STYLES)[number]["id"];
/** The custom characters, cut to something that fits a word. */
export const MASK_MAX = 12;

/** Where the text under a redaction was: its background, its colour, and each line's words (image pixels). */
export type MaskLayout = {
  bg: string;
  ink: string;
  lines: { y: number; h: number; words: { x: number; w: number }[] }[];
};
const HIGHLIGHT_ALPHA = 0.55;
export const TEXT_LINE = 1.25;
/** The text marks' font: the interface font (its family list from `--font-ui`, read by the editor). */
function textFont(size: number, family = "system-ui, sans-serif") {
  return `600 ${size}px ${family}`;
}

/** A rectangle from two corners, whichever way it was dragged. */
export function rectFrom(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
}

/** Too small to be meant (a click with the box tool, a dot with the pen). */
export function isEmpty(mark: Annotation) {
  if (mark.kind === "draw") return mark.points.length < 2;
  if (mark.kind === "text") return !mark.text.trim();
  return mark.w < 3 || mark.h < 3;
}

/** White text gets a dark edge and everything else a light one, so marks read on any background. */
function edgeFor(color: string) {
  const hex = color.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.9)";
}

function drawAnnotation(ctx: CanvasRenderingContext2D, mark: Annotation, family?: string) {
  ctx.save();
  switch (mark.kind) {
    case "redact":
      if (mark.mask && mark.layout) drawMask(ctx, mark, family);
      else if (mark.mask) {
        // Still being dragged: the words are read when it's let go.
        ctx.fillStyle = "rgba(0,0,0,0.22)";
        ctx.fillRect(mark.x, mark.y, mark.w, mark.h);
      } else {
        ctx.fillStyle = REDACT;
        ctx.fillRect(mark.x, mark.y, mark.w, mark.h);
      }
      break;
    case "highlight":
      ctx.globalCompositeOperation = "multiply";
      ctx.globalAlpha = HIGHLIGHT_ALPHA;
      ctx.fillStyle = mark.color;
      ctx.fillRect(mark.x, mark.y, mark.w, mark.h);
      break;
    case "draw": {
      ctx.strokeStyle = mark.color;
      ctx.lineWidth = mark.size;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      mark.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
      break;
    }
    case "text": {
      ctx.font = textFont(mark.size, family);
      ctx.textBaseline = "top";
      ctx.lineJoin = "round";
      ctx.lineWidth = Math.max(2, mark.size / 6);
      ctx.strokeStyle = edgeFor(mark.color);
      ctx.fillStyle = mark.color;
      mark.text.split("\n").forEach((line, i) => {
        const y = mark.y + i * mark.size * TEXT_LINE;
        ctx.strokeText(line, mark.x, y);
        ctx.fillText(line, mark.x, y);
      });
      break;
    }
  }
  ctx.restore();
}

/** The captured email with every mark on it, at the image's own size. */
export function renderMarks(ctx: CanvasRenderingContext2D, base: CanvasImageSource, marks: Annotation[], family?: string) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.drawImage(base, 0, 0);
  for (const mark of marks) drawAnnotation(ctx, mark, family);
}

/** "Invoice - 2026-10-23.png": the subject, made safe for a file name. */
export function screenshotName(subject: string, date: Date) {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const safe = subject.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "Email";
  return `${safe} - ${day}.png`;
}

const quant = (v: number) => v >> 4;
const rgb = (r: number, g: number, b: number) => `rgb(${r}, ${g}, ${b})`;

/**
 * Reads the text out of a box's pixels (RGBA, `w` × `h`, at `ox`, `oy` in the image): the commonest
 * colour along its edges is the background, pixels far from it are ink, rows of ink are lines and runs of ink
 * columns, joined across letter gaps, are words. A "line" taller than `tallest` (a picture, say) is
 * cut into rows of text height, so it's covered too.
 */
export function maskLayout(data: Uint8ClampedArray, w: number, h: number, ox: number, oy: number, tallest = 64): MaskLayout {
  // The background from the box's edges: a box is drawn around text, so its edges lie on the background
  // even when a picture fills most of it.
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  const edge: number[] = [];
  for (let x = 0; x < w; x++) edge.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) edge.push(y * w, y * w + w - 1);
  for (const p of edge) {
    const i = p * 4;
    const key = (quant(data[i]) << 8) | (quant(data[i + 1]) << 4) | quant(data[i + 2]);
    const c = counts.get(key);
    if (c) c.n++;
    else counts.set(key, { n: 1, r: data[i], g: data[i + 1], b: data[i + 2] });
  }
  let bg = { n: 0, r: 255, g: 255, b: 255 };
  for (const c of counts.values()) if (c.n > bg.n) bg = c;
  const far = (i: number) => Math.abs(data[i] - bg.r) + Math.abs(data[i + 1] - bg.g) + Math.abs(data[i + 2] - bg.b);
  const INK = 90;

  // Ink per row, and the ink colour from the strongest pixels (anti-aliased edges are lighter).
  const rowInk = new Uint8Array(h);
  let best = 0;
  let ink = { r: 0, g: 0, b: 0 };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const d = far(i);
      if (d > INK) rowInk[y] = 1;
      if (d > best) {
        best = d;
        ink = { r: data[i], g: data[i + 1], b: data[i + 2] };
      }
    }
  }

  const runs = (on: (i: number) => boolean, length: number, join: number) => {
    const out: { start: number; end: number }[] = [];
    for (let i = 0; i < length; i++) {
      if (!on(i)) continue;
      const last = out[out.length - 1];
      if (last && i - last.end <= join) last.end = i + 1;
      else out.push({ start: i, end: i + 1 });
    }
    return out;
  };

  const lines: MaskLayout["lines"] = [];
  for (const row of runs((y) => rowInk[y] === 1, h, 1)) {
    const lineH = row.end - row.start;
    if (lineH < 2) continue;
    const columnHas = (x: number) => {
      for (let y = row.start; y < row.end; y++) if (far((y * w + x) * 4) > INK) return true;
      return false;
    };
    const words = runs(columnHas, w, Math.max(2, Math.round(Math.min(lineH, tallest) * 0.22))).map((r) => ({ x: ox + r.start, w: r.end - r.start }));
    if (!words.length) continue;
    if (lineH <= tallest) {
      lines.push({ y: oy + row.start, h: lineH, words });
      continue;
    }
    // Not text: rows of text height across it.
    const step = Math.round(tallest * 0.5);
    const span = { x: words[0].x, w: words[words.length - 1].x + words[words.length - 1].w - words[0].x };
    for (let y = row.start; y + step / 2 < row.end; y += step) lines.push({ y: oy + y, h: Math.min(step, row.end - y), words: [span] });
  }
  return { bg: rgb(bg.r, bg.g, bg.b), ink: rgb(ink.r, ink.g, ink.b), lines };
}

/** `count` characters from `pattern`, in order and repeated ("x#" -> "x#x#x"). */
export function maskText(pattern: string, count: number) {
  const chars = Array.from(pattern);
  if (!chars.length) return "";
  return Array.from({ length: Math.max(1, count) }, (_, i) => chars[i % chars.length]).join("");
}

/** A redaction with characters: the box painted in the background, then each word in mask characters. */
function drawMask(ctx: CanvasRenderingContext2D, mark: Extract<Annotation, { kind: "redact" }>, family?: string) {
  const layout = mark.layout!;
  ctx.fillStyle = layout.bg;
  ctx.fillRect(mark.x, mark.y, mark.w, mark.h);
  ctx.fillStyle = layout.ink;
  ctx.textBaseline = "middle";
  for (const line of layout.lines) {
    // Dots and stars sit small in their em box, so they're drawn larger than the line.
    ctx.font = `700 ${Math.max(6, Math.round(line.h * 1.15))}px ${family ?? "system-ui, sans-serif"}`;
    const advance = Math.max(1, ctx.measureText(maskText(mark.mask!, 8)).width / 8);
    for (const word of line.words) {
      // At least one whole character, even for a comma's worth of ink.
      const text = maskText(mark.mask!, Math.round(word.w / advance));
      const several = Array.from(text).length > 1;
      const natural = ctx.measureText(text).width;
      const width = several ? Math.min(word.w, natural) : natural;
      ctx.fillText(text, word.x + (word.w - width) / 2, line.y + line.h / 2, several ? Math.max(1, word.w) : undefined);
    }
  }
}
