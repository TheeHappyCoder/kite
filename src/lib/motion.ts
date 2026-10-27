import type { Transition, Variants } from "motion/react";

/** Motion counterparts of the `blur-fade*` CSS utilities in globals.css. */

export const EASE_OUT: Transition["ease"] = [0.22, 1, 0.36, 1];

const blurFadeTransition: Transition = { duration: 0.32, ease: EASE_OUT };

export const springSnappy: Transition = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 };

/**
 * Three speeds, so things that never meet still move at the same pace: `fast` for hovers, checks and
 * toggles, `moderate` for menus, tabs and indicators (critically damped: lands without overshoot),
 * `slow` for dialogs. Each exit runs a tier quicker than its entrance, so closing never drags.
 */
export const spring = {
  fast: { type: "spring", duration: 0.08, bounce: 0 },
  moderate: { type: "spring", duration: 0.16, bounce: 0 },
  slow: { type: "spring", duration: 0.24, bounce: 0.12 },
} as const satisfies Record<string, Transition>;

export const exitFor = {
  fast: { duration: 0.06, ease: EASE_OUT },
  moderate: { duration: 0.12, ease: EASE_OUT },
  slow: { duration: 0.16, ease: EASE_OUT },
} as const satisfies Record<keyof typeof spring, Transition>;

/**
 * Fade + unblur, optionally travelling from an offset. Without `speed` it's the house tween;
 * with one, the travel uses that spring. Either way the exit is quicker than the entrance.
 */
export function blurFade({ x = 0, y = 0, blur = 6, speed }: { x?: number; y?: number; blur?: number; speed?: keyof typeof spring } = {}) {
  const enter: Transition = speed ? { ...spring[speed], opacity: { duration: spring[speed].duration, ease: EASE_OUT }, filter: { duration: spring[speed].duration, ease: EASE_OUT } } : blurFadeTransition;
  return {
    initial: { opacity: 0, filter: `blur(${blur}px)`, x, y },
    animate: { opacity: 1, filter: "blur(0px)", x: 0, y: 0, transition: enter },
    exit: { opacity: 0, filter: `blur(${blur}px)`, x: -x, y: -y, transition: speed ? exitFor[speed] : { duration: 0.2, ease: EASE_OUT } },
    transition: enter,
  } as const;
}

/** Variants for direction-aware content: pass `custom={{ x, y }}` (unit direction). */
export const directionalBlurFade: Variants = {
  initial: (dir: { x: number; y: number }) => ({
    opacity: 0,
    filter: "blur(4px)",
    x: dir.x * 10,
    y: dir.y * 6,
  }),
  animate: { opacity: 1, filter: "blur(0px)", x: 0, y: 0, transition: blurFadeTransition },
  exit: (dir: { x: number; y: number }) => ({
    opacity: 0,
    filter: "blur(4px)",
    x: dir.x * -10,
    y: dir.y * -6,
    transition: { duration: 0.18, ease: EASE_OUT },
  }),
};
