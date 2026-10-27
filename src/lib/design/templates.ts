import { Design, type DesignTheme } from "./spec";

// Starting points for a signature, designed to look finished: the user's name and address filled
// in, the rest obvious to replace. Image slots point at placeholder ids (PLACEHOLDERS); the editor
// draws those (initials in the accent, a logo tile, a soft banner) and uploads them as real images
// when one is picked, so the user swaps in their own photo, logo or GIF by clicking it.

type Who = { name: string; email: string };
type DesignTemplate = { id: string; name: string; note: string; build: (who: Who) => Design };

/** Placeholder image ids (valid asset ids nothing else uses), by what they stand for. */
export const PLACEHOLDERS = {
  photo: "feedfacefeedfacefeed0001",
  logo: "feedfacefeedfacefeed0002",
  banner: "feedfacefeedfacefeed0003",
} as const;
export type PlaceholderKind = keyof typeof PLACEHOLDERS;

/** Palettes that look good together: text, muted text and the accent for links and buttons. */
export const PALETTES: { id: string; name: string; theme: Omit<DesignTheme, "font"> }[] = [
  { id: "ink", name: "Ink", theme: { text: "#1b1b1f", muted: "#6f6f7a", accent: "#305dde" } },
  { id: "ocean", name: "Ocean", theme: { text: "#0f2233", muted: "#5b6b7a", accent: "#0e7490" } },
  { id: "forest", name: "Forest", theme: { text: "#17261e", muted: "#5f6e66", accent: "#2f7d4f" } },
  { id: "plum", name: "Plum", theme: { text: "#241a2e", muted: "#6f6578", accent: "#7c3aed" } },
  { id: "ember", name: "Ember", theme: { text: "#2a1a14", muted: "#7a675f", accent: "#c2410c" } },
  { id: "graphite", name: "Graphite", theme: { text: "#111111", muted: "#737373", accent: "#111111" } },
];

const palette = (id: string) => PALETTES.find((p) => p.id === id)!.theme;
const src = (kind: PlaceholderKind) => `asset:${PLACEHOLDERS[kind]}`;
const contacts = (email: string) => `[+27 00 000 0000](tel:+27000000000) · [${email}](mailto:${email}) · [yourwebsite.com](https://yourwebsite.com)`;

export const SIGNATURE_TEMPLATES: DesignTemplate[] = [
  {
    id: "portrait",
    name: "Portrait",
    note: "Your photo, a fine line, your details",
    build: ({ name, email }) =>
      Design.parse({
        theme: { font: "sans", ...palette("ink") },
        blocks: [
          {
            type: "columns",
            gap: 18,
            valign: "middle",
            rule: "#e3e3e8",
            columns: [
              { width: 16, blocks: [{ type: "image", src: src("photo"), alt: name, width: 76, radius: 38 }] },
              {
                blocks: [
                  { type: "heading", text: name, level: 2 },
                  { type: "text", text: "Your role · Company", size: "sm", caps: true },
                  { type: "text", text: contacts(email), size: "sm" },
                ],
              },
            ],
          },
        ],
      }),
  },
  {
    id: "logo",
    name: "Logo",
    note: "Your logo beside your name",
    build: ({ name, email }) =>
      Design.parse({
        theme: { font: "sans", ...palette("ocean") },
        blocks: [
          {
            type: "columns",
            gap: 16,
            valign: "middle",
            rule: palette("ocean").accent,
            columns: [
              { width: 13, blocks: [{ type: "image", src: src("logo"), alt: "Company logo", width: 56, radius: 14 }] },
              {
                blocks: [
                  { type: "text", text: name, bold: true, size: "lg" },
                  { type: "text", text: "Your role at **Company**", size: "sm" },
                  { type: "text", text: contacts(email), size: "sm" },
                ],
              },
            ],
          },
        ],
      }),
  },
  {
    id: "banner",
    name: "With a banner",
    note: "Details over an image or GIF",
    build: ({ name, email }) =>
      Design.parse({
        theme: { font: "sans", ...palette("plum") },
        blocks: [
          { type: "text", text: name, bold: true, size: "lg" },
          { type: "text", text: "Your role · Company", size: "sm", caps: true },
          { type: "text", text: contacts(email), size: "sm" },
          { type: "spacer", height: 6 },
          { type: "image", src: src("banner"), alt: "What we're launching this month", width: 460, radius: 12, href: "https://yourwebsite.com" },
        ],
      }),
  },
  {
    id: "founder",
    name: "Founder",
    note: "A warm sign-off and one clear button",
    build: ({ name, email }) =>
      Design.parse({
        theme: { font: "serif", ...palette("ember") },
        blocks: [
          { type: "text", text: "*Warm regards,*", size: "md" },
          { type: "heading", text: name, level: 1 },
          { type: "text", text: "Founder · Company", size: "sm", caps: true },
          { type: "text", text: `[${email}](mailto:${email}) · [yourwebsite.com](https://yourwebsite.com)`, size: "sm" },
          { type: "spacer", height: 4 },
          { type: "button", label: "Book a call", href: "https://yourwebsite.com/book" },
        ],
      }),
  },
  {
    id: "card",
    name: "Card",
    note: "Photo and name, then a line of contacts",
    build: ({ name, email }) =>
      Design.parse({
        theme: { font: "sans", ...palette("forest") },
        blocks: [
          {
            type: "columns",
            gap: 14,
            valign: "middle",
            columns: [
              { width: 11, blocks: [{ type: "image", src: src("photo"), alt: name, width: 52, radius: 26 }] },
              {
                blocks: [
                  { type: "text", text: name, bold: true, size: "lg" },
                  { type: "text", text: "Your role · Company", size: "sm", caps: true },
                ],
              },
            ],
          },
          { type: "divider", color: "#e3e8e5" },
          { type: "text", text: contacts(email), size: "sm" },
        ],
      }),
  },
  {
    id: "minimal",
    name: "Minimal",
    note: "Just the words, set well",
    build: ({ name, email }) =>
      Design.parse({
        theme: { font: "sans", ...palette("graphite") },
        blocks: [
          { type: "text", text: name, bold: true },
          { type: "text", text: "Your role · Company", size: "sm" },
          { type: "text", text: `[${email}](mailto:${email}) · [yourwebsite.com](https://yourwebsite.com)`, size: "sm" },
        ],
      }),
  },
];
