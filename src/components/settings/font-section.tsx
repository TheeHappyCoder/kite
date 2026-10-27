"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { DEFAULT_FONTS, FONTS, fontStack, type FontId, type FontRole } from "@/lib/fonts";
import { blurFade } from "@/lib/motion";
import { setFont, useFonts } from "@/lib/use-fonts";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";

type Hover = { role: FontRole; id: FontId } | null;

/**
 * Settings → Appearance: the interface and reading fonts. The preview sticks to the top while you
 * scroll the choices, and shows the font under the pointer before you pick it.
 */
export function FontSection() {
  const fonts = useFonts();
  const [hover, setHover] = useState<Hover>(null);
  const preview = (role: FontRole) => (hover?.role === role ? hover.id : fonts[role]);

  return (
    <div className="flex flex-col gap-5">
      <div className="sticky top-0 z-10 -mx-2 bg-pane px-2 pb-1 pt-3">
        <FontPreview ui={preview("ui")} reading={preview("reading")} hover={hover} />
      </div>
      <FontGroup role="ui" label="Interface font" detail="Lists, menus, the sidebar and buttons." value={fonts.ui} onHover={setHover} />
      <FontGroup role="reading" label="Reading font" detail="Messages, chat bubbles and compose. Mail with its own font keeps it." value={fonts.reading} onHover={setHover} />
    </div>
  );
}

function FontGroup({
  role,
  label,
  detail,
  value,
  onHover,
}: {
  role: FontRole;
  label: string;
  detail: string;
  value: FontId;
  onHover: (hover: Hover) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="px-1">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[12px] text-pane-muted">{detail}</div>
      </div>
      <FluidList
        axis="xy"
        tone="pane"
        role="radiogroup"
        aria-label={label}
        onMouseLeave={() => onHover(null)}
        className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,9rem),1fr))] gap-1.5"
      >
        {FONTS.map((font) => {
          const active = font.id === value;
          return (
            <button
              key={font.id}
              {...FLUID_ITEM}
              role="radio"
              aria-checked={active}
              title={font.blurb}
              onClick={() => setFont(role, font.id)}
              onPointerEnter={() => onHover({ role, id: font.id })}
              onFocus={() => onHover({ role, id: font.id })}
              className={cn(
                "relative flex h-11 min-w-0 items-center gap-2.5 rounded-xl border px-3 text-left transition-[background-color,border-color] duration-150",
                active ? "border-accent/60 bg-accent-soft" : "border-pane-border",
              )}
            >
              <span style={{ fontFamily: fontStack(font.id) }} className="w-6 shrink-0 text-[18px] font-medium leading-none tracking-tight">
                Aa
              </span>
              <span style={{ fontFamily: fontStack(font.id) }} className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
                {font.name}
              </span>
              {active ? (
                <Icon icon={Tick02Icon} size={14} className="shrink-0 text-accent" />
              ) : font.id === DEFAULT_FONTS[role] ? (
                <span className="shrink-0 text-[10.5px] text-pane-muted">Default</span>
              ) : null}
            </button>
          );
        })}
      </FluidList>
    </div>
  );
}

/** A message row in the interface font and a message in the reading font, with what's being previewed. */
function FontPreview({ ui, reading, hover }: { ui: FontId; reading: FontId; hover: Hover }) {
  const font = (id: FontId) => FONTS.find((f) => f.id === id);
  const caption = hover ? `${font(hover.id)?.name}: ${font(hover.id)?.blurb}` : `${font(ui)?.name} and ${font(reading)?.name}`;
  return (
    <div className="flex min-w-0 flex-col gap-2.5 rounded-xl border border-pane-border bg-pane-2 p-2.5 shadow-[0_6px_16px_-10px_rgba(0,0,0,0.35)]">
      <div className="flex min-w-0 items-center justify-between gap-3 px-1">
        <span className="text-[11.5px] font-medium text-pane-muted">Preview</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={caption} {...blurFade({ y: 3, blur: 3, speed: "fast" })} className="min-w-0 truncate text-[11.5px] text-pane-muted">
            {caption}
          </motion.span>
        </AnimatePresence>
      </div>
      <div style={{ fontFamily: fontStack(ui) }} className="flex min-w-0 gap-3 rounded-lg bg-pane px-3 py-2">
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent">AL</span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-[13.5px] font-semibold">Ada Lovelace</span>
            <span className="ml-auto shrink-0 text-[12px] font-medium tabular-nums text-accent">09:41</span>
          </div>
          <span className="truncate text-[12.5px] text-pane-muted">Notes on the engine, take two</span>
        </div>
      </div>
      <p style={{ fontFamily: fontStack(reading) }} className="line-clamp-2 px-1 text-[14px] leading-relaxed text-pane-fg/90">
        Thanks for the figures. I&apos;ve gone through all 128 rows and only three need a second look: <strong>March</strong>, <em>April</em> and the quarter.
      </p>
    </div>
  );
}
