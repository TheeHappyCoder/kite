"use client";

import { useEffect, useState } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";
import type { DesktopUpdateState } from "@/lib/desktop";

/** How often a waiting update's dot pings; while it downloads or installs it pings more often. */
const PING_EVERY_MS = 6000;
const PING_WORKING_MS = 1600;

/**
 * The rail's update dot: lime like the rail's other "something's here" dots (amber after a failure).
 * Every few seconds it sends out one soft ring, a ping, and rests in between (nothing runs between
 * pings: transform and opacity on a 8 px dot only).
 */
export function UpdateDot({ phase }: { phase: Exclude<DesktopUpdateState["phase"], "idle"> }) {
  const reduced = useReducedMotion();
  const every = phase === "available" ? PING_EVERY_MS : phase === "error" ? null : PING_WORKING_MS;
  const [ping, setPing] = useState(0);
  useEffect(() => {
    if (!every || reduced) return;
    const first = setTimeout(() => setPing((n) => n + 1), 1200);
    const timer = setInterval(() => setPing((n) => n + 1), every);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [every, reduced]);
  const tone = phase === "error" ? "bg-warning" : "bg-lime";
  return (
    // Nudged in from the rail's badge spot onto the icon's ring (top right), with a cut-out in the rail's ink so it sits on it cleanly.
    <span className="relative block size-2 -translate-x-[5px] translate-y-[3px]">
      {ping > 0 ? <span key={ping} aria-hidden className={cn("kite-ping absolute inset-0 rounded-full", tone)} /> : null}
      <span className={cn("relative block size-2 rounded-full ring-2 ring-frame", tone)} />
    </span>
  );
}
