// Kite's fonts. Two choices: the interface (lists, menus, chrome) and reading (message text, chat
// bubbles, compose, HTML mail that sets no font of its own). Like the pane theme, the choice lives in
// localStorage so the inline script in layout.tsx applies it before first paint. Every font is
// variable (weights ease) and bundled with the app (app/layout.tsx), loaded only when used.

export const FONTS = [
  { id: "geist", name: "Geist", blurb: "Neutral and technical", cssVar: "--font-geist-sans", features: '"cv11", "ss01"' },
  { id: "inter", name: "Inter", blurb: "The classic interface face, crisp when small", cssVar: "--font-inter", features: '"cv11", "ss01"' },
  { id: "instrument", name: "Instrument Sans", blurb: "Warm and a little narrow: more per line", cssVar: "--font-instrument", features: "normal" },
  { id: "figtree", name: "Figtree", blurb: "Friendly and round", cssVar: "--font-figtree", features: "normal" },
] as const;

export type FontId = (typeof FONTS)[number]["id"];
export type FontRole = "ui" | "reading";
export type FontChoice = Record<FontRole, FontId>;

export const DEFAULT_FONTS: FontChoice = { ui: "geist", reading: "inter" };
export const FONT_STORAGE_KEY = "kite-fonts";

export const fontOf = (id: FontId) => FONTS.find((f) => f.id === id) ?? FONTS[0];
/** A CSS font-family for the font, with the system face behind it. */
export const fontStack = (id: FontId) => `var(${fontOf(id).cssVar}), system-ui, sans-serif`;

/** Applies the saved choice before first paint (inline in layout.tsx); the same as `applyFonts` in use-fonts.ts. */
export const fontScript = `try{var f=JSON.parse(localStorage.getItem("${FONT_STORAGE_KEY}")||"{}"),m=${JSON.stringify(
  Object.fromEntries(FONTS.map((f) => [f.id, [f.cssVar, f.features]])),
)},s=document.documentElement.style;["ui","reading"].forEach(function(r){var v=m[f[r]];if(v){s.setProperty("--font-"+r,"var("+v[0]+")");s.setProperty("--font-"+r+"-features",v[1])}})}catch(e){}`;
