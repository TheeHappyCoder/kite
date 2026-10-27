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
}
