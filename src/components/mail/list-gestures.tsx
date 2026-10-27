"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { animate } from "motion/react";
import { spring } from "@/lib/motion";
import type { SwipeSide, SwipeTone } from "@/lib/swipe";
import type { IconData } from "../icon";

/** One side of a row's swipe: what shows behind the row and what runs when it goes through. */
export type RowSwipe = { label: string; icon: IconData; tone: SwipeTone; run: () => void };
export type RowSwipes = Partial<Record<SwipeSide, RowSwipe>>;
/** The swipe on screen, for the backdrop's icon and words. */
export type ShownSwipe = { side: SwipeSide; action: RowSwipe | null };

/** Movement before a touch counts as a swipe, a pull or a scroll. */
const SLOP = 10;
/** A swipe goes through past this share of the row's width (at least `SWIPE_MIN` px). */
const SWIPE_AT = 0.32;
const SWIPE_MIN = 72;
/** Pull to refresh: the finger's travel counts half; past `PULL_AT` it refreshes, the list rests at `PULL_HOLD` meanwhile. */
const PULL_AT = 64;
const PULL_MAX = 96;
const PULL_HOLD = 52;
/** The click a touch device fires after a swipe or a pull is dropped. */
const SWALLOW_MS = 400;

type Gesture = {
  x: number;
  y: number;
  row: HTMLElement | null;
  /** Rows' swipes, read when the touch starts (null: this row doesn't swipe). */
  swipes: RowSwipes | null;
  mode: "undecided" | "swipe" | "pull" | "none";
  atTop: boolean;
  side: SwipeSide | null;
  armed: boolean;
};

/**
 * Touch gestures on the message list: swipe a row sideways for its actions, pull down from the top
 * to refresh. Touch events only (mouse and pen keep clicks, hover and text selection). Everything moves
 * by writing transforms, so a gesture never re-renders the rows; the backdrop's words render once per side.
 */
export function useListGestures({
  bindKey,
  swipesFor,
  onRefresh,
}: {
  /** Changes when the scroller is a new element (the list's key). */
  bindKey: string;
  swipesFor: (threadId: string) => RowSwipes | null;
  /** Null: no pull to refresh. */
  onRefresh: (() => Promise<void> | void) | null;
}) {
  /** The list's scroller, the shared backdrop inside the row list (placed behind the row being swiped), the pull indicator above the scroller. */
  const scroller = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const indicator = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState<ShownSwipe | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const latest = useRef({ swipesFor, onRefresh, refreshing });
  useEffect(() => {
    latest.current = { swipesFor, onRefresh, refreshing };
  });

  /** How far the list is pulled down now. */
  const pulled = useRef(0);
  const setPull = useCallback(
    (d: number) => {
      pulled.current = d;
      const list = scroller.current;
      const dot = indicator.current;
      if (list) list.style.transform = d ? `translateY(${d}px)` : "";
      if (dot) {
        dot.style.transform = `translateY(${d}px)`;
        dot.style.opacity = String(Math.min(1, d / PULL_AT));
        dot.style.setProperty("--pull", String(Math.min(1, d / PULL_AT)));
        dot.toggleAttribute("data-armed", d >= PULL_AT);
      }
    },
    [],
  );

  /** The list rests open with the spinner while `onRefresh` runs, then closes. */
  const refresh = useCallback(
    async (from = 0) => {
      const run = latest.current.onRefresh;
      if (!run || latest.current.refreshing) return;
      setRefreshing(true);
      let at = from;
      const open = animate(from, PULL_HOLD, { ...spring.moderate, onUpdate: (v) => setPull((at = v)) });
      try {
        await run();
      } finally {
        open.stop();
        animate(at, 0, { ...spring.moderate, onUpdate: setPull, onComplete: () => setPull(0) });
        setRefreshing(false);
      }
    },
    [setPull],
  );

  useEffect(() => {
    const list = scroller.current;
    if (!list) return;
    let gesture: Gesture | null = null;
    let swallowUntil = 0;
    const rowX = new WeakMap<HTMLElement, number>();

    const moveRow = (row: HTMLElement, x: number) => {
      rowX.set(row, x);
      row.style.transform = x ? `translateX(${x}px)` : "";
      row.toggleAttribute("data-swiping", x !== 0);
    };
    const hideBackdrop = () => {
      const back = backdrop.current;
      if (back) {
        back.style.display = "";
        back.removeAttribute("data-armed");
      }
      setShown(null);
    };
    const slide = (row: HTMLElement, to: number, done?: () => void) =>
      animate(rowX.get(row) ?? 0, to, { ...spring.moderate, onUpdate: (x) => moveRow(row, x), onComplete: done });
    const placeBackdrop = (row: HTMLElement) => {
      const back = backdrop.current;
      if (!back) return;
      Object.assign(back.style, {
        display: "block",
        top: `${row.offsetTop}px`,
        left: `${row.offsetLeft}px`,
        width: `${row.offsetWidth}px`,
        height: `${row.offsetHeight}px`,
      });
    };

    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) {
        gesture = null;
        return;
      }
      const touch = e.touches[0];
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-thread]");
      const id = row?.dataset.thread;
      gesture = {
        x: touch.clientX,
        y: touch.clientY,
        row,
        swipes: id ? latest.current.swipesFor(id) : null,
        mode: "undecided",
        atTop: list.scrollTop <= 0,
        side: null,
        armed: false,
      };
    };

    const move = (e: TouchEvent) => {
      const g = gesture;
      if (!g || g.mode === "none" || e.touches.length !== 1) return;
      const touch = e.touches[0];
      let dx = touch.clientX - g.x;
      let dy = touch.clientY - g.y;
      if (g.mode === "undecided") {
        const pullable = g.atTop && !!latest.current.onRefresh && !latest.current.refreshing;
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) {
          // At the top a downward drag scrolls nothing: hold the browser off while deciding, so a pull stays ours.
          if (pullable && dy > 0 && e.cancelable) e.preventDefault();
          return;
        }
        if (!e.cancelable) g.mode = "none";
        else if (g.row && g.swipes && Math.abs(dx) > Math.abs(dy) * 1.2) g.mode = "swipe";
        else if (pullable && dy > 0 && list.scrollTop <= 0) g.mode = "pull";
        else g.mode = "none";
        if (g.mode === "none") return;
        // Measured from here, so nothing jumps by the slop.
        g.x = touch.clientX;
        g.y = touch.clientY;
        dx = dy = 0;
      }
      e.preventDefault();

      if (g.mode === "pull") {
        setPull(Math.min(PULL_MAX, Math.max(0, dy) * 0.5));
        return;
      }

      const row = g.row!;
      const side: SwipeSide = dx >= 0 ? "right" : "left";
      const action = g.swipes?.[side] ?? null;
      // Nothing set for this side: the row gives a little and springs back.
      moveRow(row, action ? Math.max(-row.offsetWidth, Math.min(row.offsetWidth, dx)) : dx * 0.15);
      if (side !== g.side) {
        g.side = side;
        placeBackdrop(row);
        setShown({ side, action });
      }
      const armed = !!action && Math.abs(dx) >= Math.max(SWIPE_MIN, row.offsetWidth * SWIPE_AT);
      if (armed !== g.armed) {
        g.armed = armed;
        backdrop.current?.toggleAttribute("data-armed", armed);
        if (armed) navigator.vibrate?.(8);
      }
    };

    const end = () => {
      const g = gesture;
      gesture = null;
      if (!g || g.mode === "undecided" || g.mode === "none") return;
      swallowUntil = performance.now() + SWALLOW_MS;
      if (g.mode === "pull") {
        const at = pulled.current;
        if (at >= PULL_AT) void refresh(at);
        else animate(at, 0, { ...spring.moderate, onUpdate: setPull, onComplete: () => setPull(0) });
        return;
      }
      const row = g.row!;
      const action = g.armed && g.side ? g.swipes?.[g.side] : undefined;
      if (!action) {
        slide(row, 0, hideBackdrop);
        return;
      }
      slide(row, (g.side === "right" ? 1 : -1) * row.offsetWidth, () => {
        action.run();
        // Most actions take the row out of the list; one that stays (star, read, pin) slides back.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (row.isConnected) slide(row, 0, hideBackdrop);
            else hideBackdrop();
          }),
        );
      });
    };

    const cancel = () => {
      const g = gesture;
      gesture = null;
      if (g?.mode === "swipe" && g.row) slide(g.row, 0, hideBackdrop);
      if (g?.mode === "pull") setPull(0);
    };

    const click = (e: MouseEvent) => {
      if (performance.now() >= swallowUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };

    list.addEventListener("touchstart", start, { passive: true });
    list.addEventListener("touchmove", move, { passive: false });
    list.addEventListener("touchend", end);
    list.addEventListener("touchcancel", cancel);
    list.addEventListener("click", click, true);
    return () => {
      list.removeEventListener("touchstart", start);
      list.removeEventListener("touchmove", move);
      list.removeEventListener("touchend", end);
      list.removeEventListener("touchcancel", cancel);
      list.removeEventListener("click", click, true);
    };
  }, [bindKey, setPull, refresh]);

  return { scroller, backdrop, indicator, shown, refreshing, refresh };
}
