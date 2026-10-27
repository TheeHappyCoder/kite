"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import { PixelLoader, type PixelVariant } from "./pixel-loader";

const ROLL_EASE = [0.4, 0, 0.2, 1] as const;

/** Time since mount as 4.2s, then 1m 4.2s. Ticks every tenth of a second (even with reduced motion), re-rendering only itself. */
function Elapsed() {
  const [tenths, setTenths] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTenths((t) => t + 1), 100);
    return () => clearInterval(timer);
  }, []);
  const seconds = tenths / 10;
  return (
    <span aria-hidden className="shrink-0 text-[0.92em] tabular-nums opacity-55">
      {seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`}
    </span>
  );
}

/**
 * What an AI wait looks like (every one in Kite): a 3×3 pixel grid, the steps rolling up through a slot like a counter
 * (blurring as they pass; the old one leaves quicker than the new one lands) in a grey sweep, and
 * how long it has taken so far. The longest step reserves the width, so nothing beside it moves.
 * Screen readers hear the first step once instead of every change.
 */
export function Thinking({
  steps,
  variant = "drive",
  timer = true,
  className,
}: {
  steps: string[];
  variant?: PixelVariant;
  /** Off inside buttons, so the button doesn't grow as the seconds do. */
  timer?: boolean;
  className?: string;
}) {
  const [index, setIndex] = useState(0);
  const reduce = useReducedMotion() ?? false;
  useEffect(() => {
    if (steps.length < 2 || reduce) return;
    // Walk through the steps once, then stay on the last one.
    const timer = setInterval(() => setIndex((i) => Math.min(i + 1, steps.length - 1)), 2400);
    return () => clearInterval(timer);
  }, [steps.length, reduce]);
  const longest = steps.reduce((a, b) => (a.length >= b.length ? a : b), "");

  return (
    <span className={cn("inline-flex min-w-0 items-center gap-2.5", className)} role="status">
      <span className="sr-only">{steps[0]}…</span>
      <PixelLoader variant={variant} />
      <span aria-hidden className="inline-grid min-w-0 overflow-hidden">
        <span className="invisible col-start-1 row-start-1 truncate">{longest}</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={index}
            className="shimmer-sweep col-start-1 row-start-1 truncate"
            initial={{ y: "80%", opacity: 0, filter: "blur(4px)" }}
            animate={{ y: 0, opacity: 1, filter: "blur(0px)", transition: { duration: 0.24, ease: ROLL_EASE } }}
            exit={{ y: "-80%", opacity: 0, filter: "blur(4px)", transition: { duration: 0.16, ease: ROLL_EASE } }}
          >
            {steps[index]}
          </motion.span>
        </AnimatePresence>
      </span>
      {timer ? <Elapsed /> : null}
    </span>
  );
}
