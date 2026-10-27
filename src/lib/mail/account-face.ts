import * as z from "zod";

// How an account looks in Kite: its ring colour and its picture. Both are the user's choice in
// Settings → Accounts, kept on the account row and never sent anywhere.

/** Ring colours: mid tones that read on the dark frame and on light and dark panes. */
export const ACCOUNT_COLORS = [
  "#f59e0b",
  "#38bdf8",
  "#a78bfa",
  "#34d399",
  "#f472b6",
  "#fb7185",
  "#fb923c",
  "#2dd4bf",
  "#818cf8",
  "#a3e635",
  "#e879f9",
  "#94a3b8",
] as const;

/** The first colour no other account wears (round the list again once all are taken). */
export function freeColor(taken: string[]) {
  return ACCOUNT_COLORS.find((c) => !taken.includes(c)) ?? ACCOUNT_COLORS[taken.length % ACCOUNT_COLORS.length];
}

/**
 * The picture the user picked: null = the provider's photo (else initials), "initials", a generated
 * gradient from a seed, or an uploaded image in data/assets.
 */
export const AccountFaceChoice = z.union([
  z.literal("initials"),
  z.string().regex(/^gradient:\S{1,160}$/),
  z.string().regex(/^asset:[0-9a-f]{24}$/),
]).nullable();
export type AccountFaceChoice = z.infer<typeof AccountFaceChoice>;

export function faceAsset(face: string | null | undefined) {
  return face?.startsWith("asset:") ? face.slice(6) : null;
}

/** djb2 (as vercel/avatar seeds its gradients), then mixed so seeds one character apart land far apart. */
function hash(seed: string) {
  let h = 5381;
  for (const char of seed) h = ((h << 5) + h + char.charCodeAt(0)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Two colours a third of the wheel apart from the seed's hue (vercel/avatar's triad). */
function gradientColors(seed: string) {
  const hue = hash(seed) % 360;
  return [`hsl(${hue} 90% 60%)`, `hsl(${(hue + 120) % 360} 90% 55%)`] as const;
}

/** A deterministic gradient avatar as an SVG data URL, made here: nothing is fetched. */
export function gradientAvatar(seed: string) {
  const [from, to] = gradientColors(seed);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/></linearGradient></defs>` +
    `<rect width="80" height="80" fill="url(#g)"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** Seeds for the preset gradients offered to one account (`page` shuffles to a new set). */
export function gradientSeeds(email: string, page: number, count = 8) {
  return Array.from({ length: count }, (_, i) => `${email}#${page * count + i}`);
}

/** The picture to show: the user's choice wins over the provider's photo. */
export function facePhoto(face: string | null | undefined, providerPhoto: string | null) {
  if (!face) return providerPhoto;
  if (face === "initials") return null;
  const asset = faceAsset(face);
  if (asset) return `/api/assets/${asset}`;
  return gradientAvatar(face.slice("gradient:".length));
}
