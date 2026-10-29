"use client";

import { useEffect, useRef } from "react";
import { animate, motion, useMotionValue, useReducedMotion } from "motion/react";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/** Rows of a FluidList opt in with this attribute; the lit row gets `data-lit`. */
export const FLUID_ITEM = { "data-fluid-item": "" } as const;
/** Controls inside a FluidList that keep their own hover (e.g. small icon buttons beside a row). */
export const FLUID_IGNORE = { "data-fluid-ignore": "" } as const;

type Box = { el: HTMLElement; top: number; left: number; width: number; height: number };

/** The lit row's background: `frame` on the dark sidebar, `lift` for sidebar rows that rise, `pane` on cards, menus and dialogs, `pill` in pill tracks. */
const TONES = {
  frame: "var(--frame-hover)",
  lift: "var(--frame-active)",
  pane: "var(--pane-hover)",
  pill: "color-mix(in oklab, var(--pane-border) 60%, transparent)",
} as const;

/**
 * Hover for lists: the lit row paints its own background (`[data-fluid-item]` in globals.css), a plain
 * colour transition. The pointer lights a row instantly and it fades out over 150 ms when left, so a
 * quick sweep leaves a short trail. No sliding highlight.
 *
 * Pointer mode (default): rows spread `FLUID_ITEM`; the row nearest the pointer is lit (`data-lit`),
 * so there are no dead zones in the gaps, and a click in a gap goes to the lit row. Style row hover
 * with `data-[lit]:` rather than `hover:`. Mouse only: focus rings stay with the rows.
 *
 * Follow mode (`follow="[data-selected=true]"`): for lists with their own active row (cmdk, pickers
 * with arrow keys), the matching element is lit and fades in and out (instant only under the pointer).
 *
 * Glide (`glide`, pointer mode only): for lists of tall rows (the message list), one shared highlight
 * slides between rows instead, in the same rhythm: on at once when the pointer arrives, a quick glide
 * from row to row, a 150 ms fade when it leaves. It takes the lit row's rounding.
 *
 * Split lists at dividers: one FluidList per group. Rows set their own shape (rounding).
 */
export function FluidList({
  children,
  className,
  style,
  tone = "frame",
  axis = "y",
  follow,
  glide = false,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  tone?: keyof typeof TONES;
  /** Which way the list runs: `y` lists and menus, `x` strips and tabs, `xy` grids of cards. */
  axis?: "x" | "y" | "xy";
  follow?: string;
  glide?: boolean;
} & Omit<React.HTMLAttributes<HTMLDivElement>, "children" | "className">) {
  const root = useRef<HTMLDivElement>(null);
  const boxes = useRef<Box[]>([]);
  /** The rows moved since `boxes` was measured. */
  const stale = useRef(true);
  const lit = useRef<HTMLElement | null>(null);
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const width = useMotionValue(0);
  const height = useMotionValue(0);
  const radius = useMotionValue("0px");
  const opacity = useMotionValue(0);

  /** Glide: move the shared highlight onto `el` (slide when it's already showing, else jump there). */
  const place = (el: HTMLElement, slide: boolean) => {
    const container = root.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    radius.jump(getComputedStyle(el).borderRadius);
    const values = [
      [x, r.left - origin.left],
      [y, r.top - origin.top],
      [width, r.width],
      [height, r.height],
    ] as const;
    for (const [value, to] of values) {
      if (slide) animate(value, to, spring.moderate);
      else value.jump(to);
    }
  };

  // Row boxes relative to the list, so scrolling doesn't change them.
  const measure = () => {
    const container = root.current;
    if (!container) return;
    const origin = container.getBoundingClientRect();
    boxes.current = [...container.querySelectorAll<HTMLElement>("[data-fluid-item]")]
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { el, top: r.top - origin.top, left: r.left - origin.left, width: r.width, height: r.height };
      })
      .filter((b) => b.height > 0);
    stale.current = false;
  };

  const light = (el: HTMLElement | null, by: "pointer" | "follow") => {
    if (lit.current === el) return;
    const was = lit.current;
    was?.removeAttribute("data-lit");
    el?.setAttribute("data-lit", glide ? "glide" : by);
    lit.current = el;
    if (!glide) return;
    if (!el) {
      animate(opacity, 0, { duration: 0.15, ease: "easeInOut" });
      return;
    }
    place(el, !!was && !reduced);
    opacity.stop();
    opacity.jump(1);
  };

  /** The row under the pointer, else the nearest one along the list's axis: no dead zones between rows. */
  const nearest = (clientX: number, clientY: number) => {
    const container = root.current;
    if (!container || !boxes.current.length) return null;
    const origin = container.getBoundingClientRect();
    const px = clientX - origin.left;
    const py = clientY - origin.top;
    const gap = (at: number, start: number, size: number) => (at < start ? start - at : at > start + size ? at - start - size : 0);
    let best: Box | null = null;
    let distance = Infinity;
    for (const box of boxes.current) {
      const dx = gap(px, box.left, box.width);
      const dy = gap(py, box.top, box.height);
      const d = axis === "y" ? dy : axis === "x" ? dx : Math.hypot(dx, dy);
      if (d < distance) {
        best = box;
        distance = d;
        if (d === 0) break;
      }
    }
    return best?.el ?? null;
  };

  useEffect(() => {
    const container = root.current;
    if (!container) return;
    if (!follow) {
      // Sections folding, rows arriving and resizes all move rows: measure again, but only when the
      // pointer next needs the boxes (a window or pane resize would otherwise read every row each frame).
      const resize = new ResizeObserver(() => {
        stale.current = true;
        if (glide && lit.current) place(lit.current, false);
      });
      resize.observe(container);
      return () => resize.disconnect();
    }
    // Watch the attributes the selector reads (e.g. data-selected) and rows coming and going.
    const sync = () => light(container.querySelector<HTMLElement>(follow), "follow");
    const attributeFilter = [...follow.matchAll(/\[([\w-]+)/g)].map((m) => m[1]);
    const mutations = new MutationObserver(sync);
    mutations.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter });
    sync();
    return () => mutations.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- motion values and refs are stable; glide never changes for a list
  }, [follow]);

  const pointer = follow
    ? {}
    : {
        onMouseEnter: (e: React.MouseEvent) => {
          measure();
          light(nearest(e.clientX, e.clientY), "pointer");
        },
        onMouseMove: (e: React.MouseEvent) => {
          if (stale.current) measure();
          light((e.target as HTMLElement).closest("[data-fluid-ignore]") ? null : nearest(e.clientX, e.clientY), "pointer");
        },
        onMouseLeave: () => light(null, "pointer"),
        onClick: (e: React.MouseEvent) => {
          // A click in a gap between rows goes to the lit row.
          if (lit.current && !(e.target as HTMLElement).closest("[data-fluid-item]")) lit.current.click();
        },
      };

  return (
    <div
      ref={root}
      {...rest}
      {...pointer}
      style={{ ...style, "--fluid-lit": TONES[tone] } as React.CSSProperties}
      className={cn("relative", className)}
    >
      {glide ? (
        <motion.div
          aria-hidden
          style={{ x, y, width, height, opacity, borderRadius: radius, background: "var(--fluid-lit)" }}
          className="pointer-events-none absolute left-0 top-0"
        />
      ) : null}
      {children}
    </div>
  );
}
