import { Design, type DesignTheme } from "./spec";

// Starting points for a signature, designed to look finished: the user's name and address filled
// in, the rest obvious to replace. Image slots point at placeholder ids (PLACEHOLDERS); the editor
// draws those (initials in the accent, a logo tile, a soft banner) and uploads them as real images
// when one is picked, so the user swaps in their own photo, logo or GIF by clicking it.
// Every one uses the modern look (DesignTheme.look): quiet links, muted labels, tight type.

type Who = { name: string; email: string };
type DesignTemplate = { id: string; name: string; note: string; build: (who: Who) => Design };

/** Placeholder image ids (valid asset ids nothing else uses), by what they stand for. */
export const PLACEHOLDERS = {
  photo: "feedfacefeedfacefeed0001",
  logo: "feedfacefeedfacefeed0002",
  banner: "feedfacefeedfacefeed0003",
} as const;
export type PlaceholderKind = keyof typeof PLACEHOLDERS;

type Colours = Pick<DesignTheme, "text" | "muted" | "accent">;

/** Palettes that look good together: text, muted text and the accent for buttons, pictures and labels you colour. */
export const PALETTES: { id: string; name: string; theme: Colours }[] = [
  { id: "ink", name: "Ink", theme: { text: "#18181b", muted: "#71717a", accent: "#2563eb" } },
  { id: "slate", name: "Slate", theme: { text: "#0f172a", muted: "#64748b", accent: "#0f766e" } },
  { id: "moss", name: "Moss", theme: { text: "#1a2e22", muted: "#64786c", accent: "#3f7d58" } },
  { id: "plum", name: "Plum", theme: { text: "#231a2e", muted: "#776b82", accent: "#7c3aed" } },
  { id: "clay", name: "Clay", theme: { text: "#1c1917", muted: "#78716c", accent: "#c2410c" } },
  { id: "mono", name: "Mono", theme: { text: "#0a0a0a", muted: "#737373", accent: "#0a0a0a" } },
];

const look = (font: DesignTheme["font"], id: string) => ({ font, look: "modern" as const, ...PALETTES.find((p) => p.id === id)!.theme });
const src = (kind: PlaceholderKind) => `asset:${PLACEHOLDERS[kind]}`;
/** Contacts on one quiet line, the separators given room to breathe. */
const SEP = "  ·  ";
const contacts = (email: string, phone = true) =>
  [`[${email}](mailto:${email})`, "[yourwebsite.com](https://yourwebsite.com)", ...(phone ? ["[+27 00 000 0000](tel:+27000000000)"] : [])].join(SEP);

export const SIGNATURE_TEMPLATES: DesignTemplate[] = [
  {
    id: "studio",
    name: "Studio",
    note: "Your photo beside your name",
    build: ({ name, email }) =>
      Design.parse({
        theme: look("sans", "ink"),
        blocks: [
          {
            type: "columns",
            gap: 14,
            valign: "middle",
            columns: [
              { width: 14, blocks: [{ type: "image", src: src("photo"), alt: name, width: 52, radius: 26 }] },
              {
                blocks: [
                  { type: "text", text: name, bold: true },
                  { type: "text", text: "Your role, Company", size: "sm" },
                  { type: "spacer", height: 4 },
                  { type: "text", text: contacts(email, false), size: "sm" },
                ],
              },
            ],
          },
        ],
      }),
  },
  {
    id: "monogram",
    name: "Monogram",
    note: "Your logo, then a line of contacts",
    build: ({ name, email }) =>
      Design.parse({
        theme: look("sans", "slate"),
        blocks: [
          {
            type: "columns",
            gap: 12,
            valign: "middle",
            columns: [
              { width: 11, blocks: [{ type: "image", src: src("logo"), alt: "Company logo", width: 40, radius: 10 }] },
              {
                blocks: [
                  { type: "text", text: name, bold: true },
                  { type: "text", text: "Your role at Company", size: "sm" },
                ],
              },
            ],
          },
          { type: "spacer", height: 9 },
          { type: "divider" },
          { type: "spacer", height: 7 },
          { type: "text", text: contacts(email), size: "sm" },
        ],
      }),
  },
  {
    id: "editorial",
    name: "Editorial",
    note: "A serif name over a small label",
    build: ({ name, email }) =>
      Design.parse({
        theme: look("serif", "clay"),
        blocks: [
          { type: "heading", text: name, level: 2 },
          { type: "text", text: "Founder · Company", size: "sm", caps: true },
          { type: "spacer", height: 6 },
          { type: "text", text: contacts(email, false), size: "sm" },
        ],
      }),
  },
  {
    id: "sign-off",
    name: "Sign-off",
    note: "A warm close and one clear button",
    build: ({ name, email }) =>
      Design.parse({
        theme: look("sans", "mono"),
        blocks: [
          { type: "text", text: "*Best,*", color: "#737373" },
          { type: "spacer", height: 6 },
          { type: "text", text: name, bold: true },
          { type: "text", text: `Your role, Company${SEP}[${email}](mailto:${email})`, size: "sm" },
          { type: "spacer", height: 9 },
          { type: "button", label: "Book a call", href: "https://yourwebsite.com/book" },
        ],
      }),
  },
  {
    id: "launch",
    name: "Launch",
    note: "Your details over a banner or GIF",
    build: ({ name, email }) =>
      Design.parse({
        theme: look("sans", "plum"),
        blocks: [
          {
            type: "columns",
            gap: 12,
            valign: "middle",
            columns: [
              { width: 10, blocks: [{ type: "image", src: src("photo"), alt: name, width: 40, radius: 20 }] },
              {
                blocks: [
                  { type: "text", text: name, bold: true },
                  { type: "text", text: `Your role, Company${SEP}[${email}](mailto:${email})`, size: "sm" },
                ],
              },
            ],
          },
          { type: "spacer", height: 10 },
          { type: "image", src: src("banner"), alt: "What we're launching this month", width: 440, radius: 12, href: "https://yourwebsite.com" },
        ],
      }),
  },
  {
    id: "minimal",
    name: "Minimal",
    note: "Just the words, set well",
    build: ({ name, email }) =>
      Design.parse({
        theme: look("sans", "mono"),
        blocks: [
          { type: "text", text: name, bold: true },
          { type: "text", text: "Your role, Company", size: "sm" },
          { type: "text", text: contacts(email, false), size: "sm" },
        ],
      }),
  },
];
