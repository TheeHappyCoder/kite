import * as z from "zod";

// A design document: what Kite stores for anything designed (signatures now, emails and
// templates later). It's typed data, never raw HTML, so it can be validated, compiled to
// email-safe HTML, rendered natively by Kite, and written by any AI that follows the schema.

export const DESIGN_VERSION = "kite-design/1";

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex colour like #1a1a1a");
const align = z.enum(["left", "center", "right"]);

/** An uploaded image (`asset:<id>`) or an image hosted on the web. */
const ImageSource = z
  .string()
  .regex(/^(asset:[0-9a-f]{24}|https:\/\/\S+)$/, "Use an available image (asset:…) or an https:// address");

/** Where a link or button goes. */
const LinkTarget = z.string().regex(/^(https?:\/\/|mailto:|tel:)\S+$/, "Links must start with https://, mailto: or tel:");

/** Inline markup: **bold**, *italic*, [label](https://…) and line breaks. Nothing else is interpreted. */
const richText = z.string().min(1).max(2000);

export const TextBlock = z.object({
  type: z.literal("text"),
  text: richText,
  size: z.enum(["sm", "md", "lg"]).default("md"),
  color: hex.optional(),
  align: align.default("left"),
  bold: z.boolean().default(false),
  /** Small capitals with a little tracking, in the accent: a label ("FOUNDER · KITE"). */
  caps: z.boolean().default(false),
});

export const HeadingBlock = z.object({
  type: z.literal("heading"),
  text: z.string().min(1).max(200),
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]).default(2),
  color: hex.optional(),
  align: align.default("left"),
});

export const ImageBlock = z.object({
  type: z.literal("image"),
  src: ImageSource,
  /** Shown when images are blocked. Required. */
  alt: z.string().min(1, "Every image needs alt text for when images are blocked").max(200),
  /** Display width in px. Height follows the image's proportions. */
  width: z.number().int().min(16).max(600),
  height: z.number().int().min(16).max(1200).optional(),
  href: LinkTarget.optional(),
  align: align.default("left"),
  /** Corner rounding in px (Outlook on Windows shows square corners). */
  radius: z.number().int().min(0).max(300).default(0),
});

export const ButtonBlock = z.object({
  type: z.literal("button"),
  label: z.string().min(1).max(80),
  href: LinkTarget,
  color: hex.optional(),
  textColor: hex.optional(),
  align: align.default("left"),
});

const DividerBlock = z.object({
  type: z.literal("divider"),
  color: hex.optional(),
});

const SpacerBlock = z.object({
  type: z.literal("spacer"),
  height: z.number().int().min(4).max(80).default(16),
});

export const LeafBlock = z.discriminatedUnion("type", [TextBlock, HeadingBlock, ImageBlock, ButtonBlock, DividerBlock, SpacerBlock]);

const Column = z.object({
  /** Percentage of the row. Columns without a width share what's left. */
  width: z.number().int().min(10).max(90).optional(),
  blocks: z.array(LeafBlock).max(20),
});

export const ColumnsBlock = z.object({
  type: z.literal("columns"),
  columns: z.array(Column).min(2).max(3),
  gap: z.number().int().min(0).max(48).default(16),
  valign: z.enum(["top", "middle", "bottom"]).default("top"),
  /** A thin vertical line between the columns, in this colour. */
  rule: hex.optional(),
});

export const Block = z.discriminatedUnion("type", [TextBlock, HeadingBlock, ImageBlock, ButtonBlock, DividerBlock, SpacerBlock, ColumnsBlock]);

export const DesignTheme = z.object({
  font: z.enum(["sans", "serif", "mono"]).default("sans"),
  /** Body text colour. */
  text: hex.default("#1b1b1f"),
  /** Secondary text (sm size). */
  muted: hex.default("#6f6f7a"),
  /** Links and buttons. */
  accent: hex.default("#5b4ff0"),
});

export const Design = z.object({
  version: z.literal(DESIGN_VERSION).default(DESIGN_VERSION),
  theme: DesignTheme.default(DesignTheme.parse({})),
  blocks: z.array(Block).min(1).max(40),
  /** Plain-text version for text-only clients. Generated from the blocks when absent. */
  text: z.string().max(4000).optional(),
});

export type TextBlock = z.infer<typeof TextBlock>;
export type HeadingBlock = z.infer<typeof HeadingBlock>;
export type ImageBlock = z.infer<typeof ImageBlock>;
export type ButtonBlock = z.infer<typeof ButtonBlock>;
export type LeafBlock = z.infer<typeof LeafBlock>;
export type ColumnsBlock = z.infer<typeof ColumnsBlock>;
export type Block = z.infer<typeof Block>;
export type DesignTheme = z.infer<typeof DesignTheme>;
export type Design = z.infer<typeof Design>;

/** Asset ids an image source points at. */
export function assetId(src: string) {
  return src.startsWith("asset:") ? src.slice(6) : null;
}

/** Every block, with columns flattened. */
export function allBlocks(design: Design): LeafBlock[] {
  return design.blocks.flatMap((b) => (b.type === "columns" ? b.columns.flatMap((c) => c.blocks) : [b]));
}

export function designAssets(design: Design) {
  return [...new Set(allBlocks(design).flatMap((b) => (b.type === "image" ? [assetId(b.src)] : [])).filter((id): id is string => !!id))];
}
