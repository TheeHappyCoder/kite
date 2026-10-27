"use client";

import type { DesignAsset } from "@/lib/design/prompt";
import { allBlocks, assetId, type Block, type Design, type DesignTheme } from "@/lib/design/spec";
import { PLACEHOLDERS, type PlaceholderKind } from "@/lib/design/templates";
import { uploadAsset } from "./assets";

// The images a signature template starts with (lib/design/templates.ts PLACEHOLDERS), drawn here in
// the design's colours: the person's initials for a photo, a lettered tile for a logo, a soft
// gradient for a banner. Previews use them as data URLs; picking a template uploads the ones it uses
// as real images (reused when the same one is already there), so the user only has to click one to
// put their own photo, logo or GIF in its place.

type Who = { name: string; email: string };

const SIZES: Record<PlaceholderKind, [number, number]> = { photo: [240, 240], logo: [224, 224], banner: [920, 240] };

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]!.toUpperCase())
    .join("") || "K";

/** A lighter version of a colour, for the gradients. */
function lighten(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  return `rgb(${mix(n >> 16)}, ${mix((n >> 8) & 255)}, ${mix(n & 255)})`;
}

function draw(kind: PlaceholderKind, theme: DesignTheme, who: Who) {
  const [width, height] = SIZES[kind];
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, theme.accent);
  gradient.addColorStop(1, lighten(theme.accent, kind === "banner" ? 0.55 : 0.35));
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const font = (size: number, weight = 600) => `${weight} ${size}px "Segoe UI", system-ui, -apple-system, sans-serif`;
  if (kind === "photo") {
    ctx.font = font(92);
    ctx.fillText(initials(who.name), width / 2, height / 2 + 4);
  } else if (kind === "logo") {
    const domain = who.email.split("@")[1] ?? "";
    ctx.font = font(104, 700);
    ctx.fillText((domain[0] ?? "K").toUpperCase(), width / 2, height / 2 + 6);
  } else {
    // Soft light from the top left, then the words.
    const glow = ctx.createRadialGradient(0, 0, 0, 0, 0, width * 0.7);
    glow.addColorStop(0, "rgba(255,255,255,0.28)");
    glow.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "left";
    ctx.font = font(52, 700);
    ctx.fillText("Your banner or GIF", 56, height / 2 - 18);
    ctx.globalAlpha = 0.82;
    ctx.font = font(30, 500);
    ctx.fillText("Click it in the editor to put yours here", 56, height / 2 + 34);
  }
  return canvas;
}

const KINDS = Object.entries(PLACEHOLDERS) as [PlaceholderKind, string][];
const kindOf = (id: string) => KINDS.find(([, placeholder]) => placeholder === id)?.[0];

/** Placeholder id -> data URL, for previewing a template before it's picked. */
export function placeholderImages(theme: DesignTheme, who: Who): Record<string, string> {
  if (typeof document === "undefined") return {};
  return Object.fromEntries(KINDS.map(([kind, id]) => [id, draw(kind, theme, who).toDataURL("image/png")]));
}

/** Whether a design still holds a placeholder (so the editor can say "click to put yours here"). */
export const isPlaceholder = (src: string) => {
  const id = assetId(src);
  return !!id && !!kindOf(id);
};

/**
 * Points the placeholder images Kite added for a template back at their placeholder ids, so
 * `withRealImages` draws them again (in a new palette). The user's own images aren't touched.
 */
export function unplaced(design: Design, assets: DesignAsset[]): Design {
  const back = (src: string) => {
    const id = assetId(src);
    const name = id ? assets.find((a) => a.id === id)?.name : undefined;
    const kind = name?.match(/^Placeholder (photo|logo|banner) /)?.[1] as PlaceholderKind | undefined;
    return kind ? `asset:${PLACEHOLDERS[kind]}` : src;
  };
  const swap = <B extends Block>(block: B): B =>
    block.type === "image"
      ? { ...block, src: back(block.src) }
      : block.type === "columns"
        ? { ...block, columns: block.columns.map((c) => ({ ...c, blocks: c.blocks.map(swap) })) }
        : block;
  return { ...design, blocks: design.blocks.map(swap) };
}

/** Uploads the placeholders a design uses (reusing ones already there) and points it at them. */
export async function withRealImages(design: Design, who: Who, assets: DesignAsset[]): Promise<{ design: Design; uploaded: DesignAsset[] }> {
  const used = [...new Set(allBlocks(design).flatMap((b) => (b.type === "image" ? [assetId(b.src)] : [])).filter((id): id is string => !!id && !!kindOf(id)))];
  const replaced = new Map<string, string>();
  const uploaded: DesignAsset[] = [];
  for (const id of used) {
    const kind = kindOf(id)!;
    const name = `Placeholder ${kind} ${design.theme.accent.slice(1)} ${initials(who.name)}.png`;
    const existing = assets.find((a) => a.name === name);
    if (existing) {
      replaced.set(id, existing.id);
      continue;
    }
    const blob = await new Promise<Blob | null>((resolve) => draw(kind, design.theme, who).toBlob(resolve, "image/png"));
    if (!blob) continue;
    const asset = await uploadAsset(new File([blob], name, { type: "image/png" }));
    uploaded.push(asset);
    replaced.set(id, asset.id);
  }
  const swap = <B extends Block>(block: B): B => {
    if (block.type === "image") {
      const id = assetId(block.src);
      const to = id ? replaced.get(id) : undefined;
      return to ? { ...block, src: `asset:${to}` } : block;
    }
    if (block.type === "columns") return { ...block, columns: block.columns.map((c) => ({ ...c, blocks: c.blocks.map(swap) })) };
    return block;
  };
  return { design: { ...design, blocks: design.blocks.map(swap) }, uploaded };
}
