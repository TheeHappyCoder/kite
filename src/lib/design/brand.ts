import * as z from "zod";
import { Design, DesignTheme, type Block } from "./spec";

// Designed emails: the brand kit new designs start from, and templates saved from designed
// emails. Both are typed data kept in the local settings table (see server/mail-designs.ts).

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

/** A logo, up to three colours (accent, text, muted) and a font stack. */
export const BrandKit = z.object({
  /** An uploaded design image (asset id). */
  logo: z.string().regex(/^[0-9a-f]{24}$/).nullable().default(null),
  /** Shown when images are blocked. */
  logoAlt: z.string().trim().max(200).default(""),
  /** Display width of the logo in px. */
  logoWidth: z.number().int().min(16).max(600).default(140),
  accent: hex.nullable().default(null),
  text: hex.nullable().default(null),
  muted: hex.nullable().default(null),
  font: DesignTheme.shape.font,
});
export type BrandKit = z.infer<typeof BrandKit>;

export const EMPTY_BRAND: BrandKit = BrandKit.parse({});

/** A designed email kept to start new messages from. */
export const EmailTemplate = z.object({
  id: z.string().regex(/^[0-9a-f-]{36}$/),
  name: z.string().trim().min(1, "Give the template a name").max(60),
  /** Filled into an empty subject when the template is used. */
  subject: z.string().max(1000).refine((s) => !/[\r\n]/.test(s), "No line breaks in the subject").default(""),
  recipients: z.object({ to: z.array(z.object({ name: z.string().max(200).optional(), email: z.email() })).max(100), cc: z.array(z.object({ name: z.string().max(200).optional(), email: z.email() })).max(100), bcc: z.array(z.object({ name: z.string().max(200).optional(), email: z.email() })).max(100) }).optional(),
  design: Design,
  updatedAt: z.string(),
});
export type EmailTemplate = z.infer<typeof EmailTemplate>;

export const TemplateInput = EmailTemplate.omit({ id: true, updatedAt: true });
export type TemplateInput = z.infer<typeof TemplateInput>;

export const MAX_TEMPLATES = 50;

/** The design theme the brand kit sets; colours it leaves out keep the defaults. */
function brandTheme(brand: BrandKit): DesignTheme {
  const base = DesignTheme.parse({});
  return { font: brand.font, accent: brand.accent ?? base.accent, text: brand.text ?? base.text, muted: brand.muted ?? base.muted };
}

/** A new designed email: the brand's logo and theme, a heading and a paragraph to replace. */
export function starterDesign(brand: BrandKit, body = ""): Design {
  const blocks: Block[] = [];
  if (brand.logo) blocks.push({ type: "image", src: `asset:${brand.logo}`, alt: brand.logoAlt || "Logo", width: brand.logoWidth, align: "left", radius: 0 });
  blocks.push({ type: "heading", text: "Your headline", level: 1, align: "left" });
  blocks.push({ type: "text", text: body.trim().slice(0, 2000) || "Write your message here.", size: "md", align: "left", bold: false, caps: false });
  return Design.parse({ theme: brandTheme(brand), blocks });
}
