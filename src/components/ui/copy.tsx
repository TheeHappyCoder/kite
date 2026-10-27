"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Copy01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { exitFor, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";

/** Copies text and reports `copied` for a moment (resets itself; safe to call repeatedly). */
export function useCopy(ms = 1600) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        return false;
      }
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), ms);
      return true;
    },
    [ms],
  );
  return { copied, copy, setCopied };
}

/**
 * The copy icon that turns into a tick: the copy glyph blurs away and the tick pops in on a spring,
 * tinted with the success colour. Every copy button uses this, so they all confirm the same way.
 */
export function CopyIcon({ copied, size = 14, className, tint = true }: { copied: boolean; size?: number; className?: string; tint?: boolean }) {
  return (
    <span className={cn("relative grid shrink-0 place-items-center", className)} style={{ width: size, height: size }}>
      <AnimatePresence initial={false} mode="popLayout">
        {copied ? (
          <motion.span
            key="tick"
            initial={{ scale: 0.4, opacity: 0, filter: "blur(3px)" }}
            animate={{ scale: 1, opacity: 1, filter: "blur(0px)", transition: spring.slow }}
            exit={{ scale: 0.6, opacity: 0, filter: "blur(3px)", transition: exitFor.fast }}
            className={cn("grid place-items-center", tint && "text-success")}
          >
            <Icon icon={Tick02Icon} size={size} strokeWidth={2.2} />
          </motion.span>
        ) : (
          <motion.span
            key="copy"
            initial={{ scale: 0.7, opacity: 0, filter: "blur(3px)" }}
            animate={{ scale: 1, opacity: 1, filter: "blur(0px)", transition: spring.moderate }}
            exit={{ scale: 0.7, opacity: 0, filter: "blur(3px)", transition: exitFor.fast }}
            className="grid place-items-center"
          >
            <Icon icon={Copy01Icon} size={size} />
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
