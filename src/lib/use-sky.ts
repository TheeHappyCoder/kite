"use client";

import { useEffect } from "react";
import { skyPhase } from "./sky";

/** Moves the sky on as the day goes (checked every few minutes; a phase lasts hours). */
export function useSkyPhase() {
  useEffect(() => {
    const set = () => {
      const now = new Date();
      document.documentElement.dataset.sky = skyPhase(now.getHours() * 60 + now.getMinutes());
    };
    set();
    const timer = setInterval(set, 5 * 60_000);
    return () => clearInterval(timer);
  }, []);
  useStillWhileBusy();
}

/** How long after the last input the clouds start drifting again. */
const STILL_FOR_MS = 1500;

/**
 * The clouds hold still while you're doing something (pointer, keys, wheel, scrolling, a window
 * resize) and drift again a moment after: a drifting layer under everything made every frame of a
 * pane drag or resize several times dearer (perf: 40 -> 11 ms of main-thread work per drag step).
 * The drift is slow enough that pausing it never shows. `data-still` on <html>, read in globals.css.
 */
function useStillWhileBusy() {
  useEffect(() => {
    const root = document.documentElement;
    let last = 0;
    let check: ReturnType<typeof setInterval> | undefined;
    const busy = () => {
      last = performance.now();
      if (check) return;
      root.setAttribute("data-still", "");
      check = setInterval(() => {
        if (performance.now() - last < STILL_FOR_MS) return;
        clearInterval(check);
        check = undefined;
        root.removeAttribute("data-still");
      }, 500);
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "scroll", "resize"] as const;
    const options = { capture: true, passive: true };
    for (const name of events) window.addEventListener(name, busy, options);
    return () => {
      for (const name of events) window.removeEventListener(name, busy, options);
      clearInterval(check);
      root.removeAttribute("data-still");
    };
  }, []);
}
