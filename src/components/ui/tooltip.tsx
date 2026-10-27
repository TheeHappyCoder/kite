"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { directionalBlurFade, springSnappy } from "@/lib/motion";
import { useShortcuts, type ShortcutAction } from "@/lib/shortcuts";
import { KeyCombo } from "./kbd";

/*
 * One shared tooltip for the whole app. The first hover waits OPEN_DELAY; once a
 * tooltip is showing, hovering another trigger moves the same bubble there and
 * the new label flows in from the direction the pointer travelled.
 */

const OPEN_DELAY = 320;
const CLOSE_DELAY = 90;
const WARM_WINDOW = 450;
const GAP = 8;

type Side = "top" | "bottom" | "left" | "right";

type Tip = {
  id: string;
  label: string;
  shortcut?: ShortcutAction;
  rect: DOMRect;
  side: Side;
};

type Api = {
  show: (tip: Tip) => void;
  hide: (id: string, immediate?: boolean) => void;
};

const TooltipContext = createContext<Api | null>(null);

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  const [tip, setTip] = useState<Tip | null>(null);
  const [session, setSession] = useState(0);
  const [direction, setDirection] = useState({ x: 0, y: 0 });
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastClosedAt = useRef(0);
  const current = useRef<Tip | null>(null);

  const clearTimers = () => {
    if (openTimer.current) clearTimeout(openTimer.current);
    if (closeTimer.current) clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };

  const api = useMemo<Api>(
    () => ({
      show: (next) => {
        clearTimers();
        const previous = current.current;
        if (previous) {
          // Already open: glide over and slide the label in from the travel direction.
          const dx = next.rect.left + next.rect.width / 2 - (previous.rect.left + previous.rect.width / 2);
          const dy = next.rect.top + next.rect.height / 2 - (previous.rect.top + previous.rect.height / 2);
          setDirection(
            Math.abs(dx) >= Math.abs(dy) ? { x: Math.sign(dx), y: 0 } : { x: 0, y: Math.sign(dy) },
          );
          current.current = next;
          setTip(next);
          return;
        }
        const warm = Date.now() - lastClosedAt.current < WARM_WINDOW;
        const open = () => {
          setDirection({ x: 0, y: 0 });
          setSession((s) => s + 1);
          current.current = next;
          setTip(next);
        };
        if (warm) open();
        else openTimer.current = setTimeout(open, OPEN_DELAY);
      },
      hide: (id, immediate) => {
        if (openTimer.current) {
          clearTimeout(openTimer.current);
          openTimer.current = null;
        }
        if (current.current?.id !== id) return;
        const close = () => {
          current.current = null;
          lastClosedAt.current = Date.now();
          setTip(null);
        };
        if (immediate) close();
        else closeTimer.current = setTimeout(close, CLOSE_DELAY);
      },
    }),
    [],
  );

  useEffect(() => clearTimers, []);

  return (
    <TooltipContext.Provider value={api}>
      {children}
      <TooltipLayer tip={tip} session={session} direction={direction} />
    </TooltipContext.Provider>
  );
}

function position(tip: Tip) {
  const { rect, side } = tip;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  switch (side) {
    case "top":
      return { left: cx, top: rect.top - GAP, translate: "-50% -100%" };
    case "bottom":
      return { left: cx, top: rect.bottom + GAP, translate: "-50% 0" };
    case "left":
      return { left: rect.left - GAP, top: cy, translate: "-100% -50%" };
    case "right":
      return { left: rect.right + GAP, top: cy, translate: "0 -50%" };
  }
}

function TooltipLayer({ tip, session, direction }: { tip: Tip | null; session: number; direction: { x: number; y: number } }) {
  const { primary } = useShortcuts();
  if (typeof document === "undefined") return null;
  const pos = tip ? position(tip) : null;
  const combo = tip?.shortcut ? primary(tip.shortcut) : undefined;

  return createPortal(
    <AnimatePresence>
      {tip && pos ? (
        <motion.div
          key={session}
          role="tooltip"
          className="pointer-events-none fixed z-[100]"
          initial={{ left: pos.left, top: pos.top, opacity: 0, filter: "blur(4px)", scale: 0.96 }}
          animate={{ left: pos.left, top: pos.top, opacity: 1, filter: "blur(0px)", scale: 1 }}
          exit={{ opacity: 0, filter: "blur(4px)", scale: 0.96, transition: { duration: 0.14 } }}
          transition={{ left: springSnappy, top: springSnappy, default: { duration: 0.2 } }}
        >
          <div style={{ translate: pos.translate }}>
            <motion.div
              layout
              transition={springSnappy}
              className="overflow-hidden whitespace-nowrap rounded-lg bg-tooltip px-2 py-1 text-[12px] font-medium text-tooltip-fg shadow-lg"
              style={{ borderRadius: 8 }}
            >
              <AnimatePresence mode="popLayout" initial={false} custom={direction}>
                <motion.span
                  key={tip.id}
                  custom={direction}
                  variants={directionalBlurFade}
                  initial="initial"
                  animate="animate"
                  exit="exit"
                  className="flex items-center gap-2"
                >
                  {tip.label}
                  {combo ? (
                    <KeyCombo combo={combo} keyClassName="bg-tooltip-fg/15 text-tooltip-fg/80" />
                  ) : null}
                </motion.span>
              </AnimatePresence>
            </motion.div>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

export function Tooltip({
  label,
  shortcut,
  side = "bottom",
  children,
  className,
}: {
  label: string;
  shortcut?: ShortcutAction;
  side?: Side;
  children: React.ReactNode;
  className?: string;
}) {
  const api = useContext(TooltipContext);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);

  const show = useCallback(() => {
    const el = ref.current;
    if (!api || !el) return;
    const rect = el.getBoundingClientRect();
    let resolved = side;
    if (side === "bottom" && rect.bottom + 40 > window.innerHeight) resolved = "top";
    if (side === "top" && rect.top < 40) resolved = "bottom";
    api.show({ id, label, shortcut, rect, side: resolved });
  }, [api, id, label, shortcut, side]);

  // If the label changes while open (e.g. Star → Unstar), refresh it in place.
  const shownLabel = useRef(label);
  useEffect(() => {
    if (shownLabel.current !== label && ref.current?.matches(":hover")) show();
    shownLabel.current = label;
  }, [label, show]);

  useEffect(() => () => api?.hide(id, true), [api, id]);

  return (
    <span
      ref={ref}
      className={className ?? "inline-flex"}
      onPointerEnter={show}
      onPointerLeave={() => api?.hide(id)}
      onPointerDown={() => api?.hide(id, true)}
      onFocus={(e) => {
        if (e.target.matches(":focus-visible")) show();
      }}
      onBlur={() => api?.hide(id, true)}
    >
      {children}
    </span>
  );
}
