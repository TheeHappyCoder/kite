import type { Block, ButtonBlock, ColumnsBlock, Design, DesignTheme, HeadingBlock, ImageBlock, LeafBlock, TextBlock } from "./spec";

// Compiles a design document to email-safe HTML: nested tables, inline styles, explicit
// image sizes and no CSS that Outlook's Word engine or Gmail would drop. Every value from
// the document is escaped; links are restricted to https/mailto/tel by the schema and again here.

export type CompileOptions = {
  /** Maps an image source (asset:… or https://…) to the URL used in the HTML. */
  image: (src: string) => string;
  /** Preview: how Outlook on Windows shows it (square corners). */
  outlook?: boolean;
  /** Preview: images blocked, alt text shown instead. */
  imagesOff?: boolean;
  /** The editor's preview: each top-level block's row carries `data-kite-block` (its index), so a click selects it. */
  marks?: boolean;
};

export const FONT_STACKS: Record<DesignTheme["font"], string> = {
  sans: "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  serif: "Georgia,'Times New Roman',Times,serif",
  mono: "Consolas,'SFMono-Regular',Menlo,'Liberation Mono',monospace",
};

const TEXT_SIZES = { sm: 12, md: 14, lg: 17 } as const;
const HEADING_SIZES = { 1: 24, 2: 19, 3: 16 } as const;
const BLOCK_GAP = 8;
const SAFE_URL = /^(https?:\/\/|mailto:|tel:)[^\s"'<>]+$/;

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function safeUrl(url: string) {
  return SAFE_URL.test(url) ? escapeHtml(url) : "#";
}

const LINK = /\[([^\]\n]+)\]\(((?:https?:\/\/|mailto:|tel:)[^\s)]+)\)/g;

/** Inline markup to HTML: **bold**, *italic*, [label](url), line breaks. */
function inlineHtml(text: string, theme: DesignTheme) {
  const links: string[] = [];
  // Pull links out first so their URLs aren't touched by the emphasis rules.
  let html = text.replace(LINK, (_, label: string, url: string) => {
    links.push(`<a href="${safeUrl(url)}" style="color:${theme.accent};text-decoration:underline">${escapeHtml(label)}</a>`);
    return `\u0000${links.length - 1}\u0000`;
  });
  html = escapeHtml(html)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\r?\n/g, "<br>");
  return html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => links[Number(i)]);
}

/** Inline markup to plain text: links become "label <url>". */
function inlineText(text: string) {
  return text
    .replace(LINK, (_, label: string, url: string) => {
      const bare = url.replace(/^(mailto:|tel:)/, "");
      const digits = (s: string) => s.replace(/\D/g, "");
      const same = label === url || label === bare || (url.startsWith("tel:") && digits(label) === digits(bare));
      return same ? label : `${label} <${bare}>`;
    })
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2");
}

function textBlock(block: TextBlock, theme: DesignTheme) {
  // A label (caps) takes the accent; other small text is quiet.
  const color = block.color ?? (block.caps ? theme.accent : block.size === "sm" ? theme.muted : theme.text);
  const size = TEXT_SIZES[block.size];
  const caps = block.caps ? "text-transform:uppercase;letter-spacing:0.08em;" : "";
  return `<div style="margin:0;font-size:${size}px;line-height:${Math.round(size * 1.5)}px;color:${color};text-align:${block.align};font-weight:${block.bold ? 700 : 400};${caps}">${inlineHtml(block.text, theme)}</div>`;
}

function headingBlock(block: HeadingBlock, theme: DesignTheme) {
  const size = HEADING_SIZES[block.level];
  return `<h${block.level} style="margin:0;font-size:${size}px;line-height:${Math.round(size * 1.25)}px;font-weight:700;color:${block.color ?? theme.text};text-align:${block.align}">${escapeHtml(block.text)}</h${block.level}>`;
}

function imageBlock(block: ImageBlock, theme: DesignTheme, options: CompileOptions) {
  if (options.imagesOff) {
    return `<div style="display:inline-block;max-width:100%;padding:6px 10px;border:1px dashed #c9c9d1;border-radius:4px;font-size:12px;line-height:18px;color:${theme.muted}">${escapeHtml(block.alt)}</div>`;
  }
  const radius = !options.outlook && block.radius ? `border-radius:${block.radius}px;` : "";
  const center = block.align === "center" ? "margin:0 auto;" : block.align === "right" ? "margin:0 0 0 auto;" : "";
  const img = `<img src="${escapeHtml(options.image(block.src))}" alt="${escapeHtml(block.alt)}" width="${block.width}"${block.height ? ` height="${block.height}"` : ""} style="display:block;${center}width:${block.width}px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;${radius}">`;
  return block.href ? `<a href="${safeUrl(block.href)}" style="text-decoration:none">${img}</a>` : img;
}

function buttonBlock(block: ButtonBlock, theme: DesignTheme, options: CompileOptions) {
  const bg = block.color ?? theme.accent;
  const fg = block.textColor ?? "#ffffff";
  const radius = options.outlook ? "" : "border-radius:6px;";
  const align = block.align === "left" ? "" : ` align="${block.align}"`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${align} style="border-collapse:separate"><tr><td bgcolor="${bg}" style="${radius}background:${bg}"><a href="${safeUrl(block.href)}" style="display:inline-block;padding:9px 18px;font-size:14px;line-height:20px;font-weight:600;color:${fg};text-decoration:none;${radius}">${escapeHtml(block.label)}</a></td></tr></table>`;
}

function leafHtml(block: LeafBlock, theme: DesignTheme, options: CompileOptions) {
  switch (block.type) {
    case "text":
      return textBlock(block, theme);
    case "heading":
      return headingBlock(block, theme);
    case "image":
      return imageBlock(block, theme, options);
    case "button":
      return buttonBlock(block, theme, options);
    case "divider":
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-top:1px solid ${block.color ?? "#e3e3e8"};font-size:1px;line-height:1px">&nbsp;</td></tr></table>`;
    case "spacer":
      return `<div style="height:${block.height}px;line-height:${block.height}px;font-size:1px">&nbsp;</div>`;
  }
}

function alignOf(block: LeafBlock) {
  return "align" in block ? block.align : "left";
}

/** Stacks blocks as table rows with a fixed gap. Spacers and dividers carry their own spacing. */
function stack(blocks: LeafBlock[], theme: DesignTheme, options: CompileOptions, width?: string, path?: string) {
  const rows = blocks
    .map((block, i) => {
      const last = i === blocks.length - 1;
      const pad = last || block.type === "spacer" ? 0 : BLOCK_GAP;
      const mark = options.marks && path ? ` data-kite-part="${path}.${i}"` : "";
      return `<tr${mark}><td align="${alignOf(block)}" style="padding:0 0 ${pad}px 0">${leafHtml(block, theme, options)}</td></tr>`;
    })
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0"${width ? ` width="${width}"` : ""} style="border-collapse:collapse">${rows}</table>`;
}

function columnsHtml(block: ColumnsBlock, theme: DesignTheme, options: CompileOptions, index?: number) {
  const fixed = block.columns.reduce((n, c) => n + (c.width ?? 0), 0);
  const flexible = block.columns.filter((c) => c.width == null).length;
  const share = flexible ? Math.max(10, Math.floor((100 - fixed) / flexible)) : 0;
  const cells = block.columns
    .map((column, i) => {
      const width = column.width ?? share;
      const pad = i < block.columns.length - 1 ? block.gap : 0;
      // A rule between columns: a left border on every column after the first, with the gap on both sides.
      const rule = block.rule && i > 0 ? `border-left:1px solid ${block.rule};padding-left:${block.gap}px;` : "";
      return `<td width="${width}%" valign="${block.valign}" style="padding:0 ${pad}px 0 0;${rule}">${stack(column.blocks, theme, options, "100%", index === undefined ? undefined : `${index}.${i}`)}</td>`;
    })
    .join("");
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse"><tr>${cells}</tr></table>`;
}

function blockHtml(block: Block, theme: DesignTheme, options: CompileOptions, index?: number) {
  return block.type === "columns" ? columnsHtml(block, theme, options, index) : leafHtml(block, theme, options);
}

/** The design as an HTML fragment that can sit inside any email body. */
export function compileHtml(design: Design, options: CompileOptions) {
  const { theme } = design;
  const rows = design.blocks
    .map((block, i) => {
      const last = i === design.blocks.length - 1;
      const pad = last || block.type === "spacer" ? 0 : BLOCK_GAP;
      const align = block.type === "columns" ? "left" : alignOf(block);
      const mark = options.marks ? ` data-kite-block="${i}"` : "";
      return `<tr${mark}><td align="${align}" style="padding:0 0 ${pad}px 0">${blockHtml(block, theme, options, i)}</td></tr>`;
    })
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;max-width:600px;font-family:${FONT_STACKS[theme.font]};color:${theme.text}">${rows}</table>`;
}

function leafText(block: LeafBlock): string | null {
  switch (block.type) {
    case "text":
      return inlineText(block.text);
    case "heading":
      return block.text;
    case "image":
      return block.href ? `${block.alt}: ${block.href.replace(/^(mailto:|tel:)/, "")}` : null;
    case "button":
      return `${block.label}: ${block.href.replace(/^(mailto:|tel:)/, "")}`;
    case "divider":
    case "spacer":
      return null;
  }
}

/** The plain-text version generated from the blocks. */
export function generatedText(design: Design) {
  return design.blocks
    .flatMap((block) => (block.type === "columns" ? block.columns.flatMap((c) => c.blocks.map(leafText)) : [leafText(block)]))
    .filter((line): line is string => !!line?.trim())
    .join("\n");
}

/** The plain-text version: the user's own if they wrote one, otherwise generated. */
export function compileText(design: Design) {
  return design.text?.trim() || generatedText(design);
}
