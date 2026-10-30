"use client";

import { useReducedMotion } from "motion/react";

/**
 * A 3×3 pixel grid for long-running work: square cells, a chevron wavefront driving right. Each cell
 * runs the same `pixel-on` pulse (globals.css) with its own delay, so the pattern is all CSS: no
 * timers, no re-renders. The 650ms cycle is shorter than the sweep, so two fronts are always in flight.
 * Cells take the text colour. Reduced motion leaves the grid dim and still.
 */
const CHEVRON = Array.from({ length: 9 }, (_, i) => ((i % 3) + Math.abs(Math.floor(i / 3) - 1)) * 90);

export function PixelLoader() {
  const reduce = useReducedMotion() ?? false;
  return (
    <span aria-hidden className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]">
      {CHEVRON.map((delay, i) => (
        <span
          key={i}
          className="size-[4px] rounded-[1px] bg-current"
          style={{
            opacity: 0.15,
            animation: reduce ? "none" : `pixel-on 650ms ease-in-out ${delay}ms infinite`,
          }}
        />
      ))}
    </span>
  );
}
