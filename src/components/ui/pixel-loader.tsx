"use client";

import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/**
 * A 3×3 pixel grid for long-running work. Each cell runs the same `pixel-on` pulse (globals.css)
 * with its own delay, so the pattern is all CSS: no timers, no re-renders.
 *   drive: square cells, a chevron wavefront driving right. The 650ms cycle is shorter than the
 *          sweep, so two fronts are always in flight.
 *   dots:  the same wavefront in round cells.
 *   orbit: a comet lapping the perimeter; the middle cell stays dark.
 * Cells take the text colour. Reduced motion leaves the grid dim and still.
 */
export type PixelVariant = "drive" | "dots" | "orbit";

const CHEVRON = Array.from({ length: 9 }, (_, i) => ((i % 3) + Math.abs(Math.floor(i / 3) - 1)) * 90);
const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const ORBIT = Array.from({ length: 9 }, (_, i) => (ORBIT_ORDER.includes(i) ? ORBIT_ORDER.indexOf(i) * 110 : null));

const PATTERNS: Record<PixelVariant, { delays: (number | null)[]; duration: number; round: boolean }> = {
  drive: { delays: CHEVRON, duration: 650, round: false },
  dots: { delays: CHEVRON, duration: 650, round: true },
  orbit: { delays: ORBIT, duration: 950, round: false },
};

export function PixelLoader({ variant = "drive", className }: { variant?: PixelVariant; className?: string }) {
  const reduce = useReducedMotion() ?? false;
  const { delays, duration, round } = PATTERNS[variant];
  return (
    <span aria-hidden className={cn("grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]", className)}>
      {delays.map((delay, i) => (
        <span
          key={i}
          className={cn("size-[4px] bg-current", round ? "rounded-full" : "rounded-[1px]")}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation: delay === null || reduce ? "none" : `pixel-on ${duration}ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}
