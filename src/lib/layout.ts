"use client";

import { useLayoutEffect, useState, useSyncExternalStore } from "react";

// How much of the app fits: the window width picks the sidebar's form, and each pane group
// measures itself to decide whether two panes fit side by side. Nothing assumes a wide screen.

/** The sidebar: labels and all (`full`), icons only (`rail`), or a drawer behind a menu button. */
export type SidebarMode = "full" | "rail" | "drawer";

/** Window widths where the sidebar changes form. The desktop window goes down to 720 px (rail). */
const SIDEBAR_FULL_FROM = 1024;
const SIDEBAR_RAIL_FROM = 640;

/** The narrowest the list and the reader may get side by side; below both, one pane shows at a time. */
export const LIST_MIN_PX = 300;
export const DETAIL_MIN_PX = 380;
/** The resize handle between them (w-2). */
export const PANE_GAP_PX = 8;
/** The narrowest pane area that still holds both side by side. */
export const TWO_PANES_MIN = LIST_MIN_PX + DETAIL_MIN_PX + PANE_GAP_PX;

const queries = {
  full: `(min-width: ${SIDEBAR_FULL_FROM}px)`,
  rail: `(min-width: ${SIDEBAR_RAIL_FROM}px)`,
};

function subscribe(listener: () => void) {
  const lists = Object.values(queries).map((q) => window.matchMedia(q));
  lists.forEach((l) => l.addEventListener("change", listener));
  return () => lists.forEach((l) => l.removeEventListener("change", listener));
}

function sidebarMode(): SidebarMode {
  if (window.matchMedia(queries.full).matches) return "full";
  if (window.matchMedia(queries.rail).matches) return "rail";
  return "drawer";
}

/** The sidebar's form for the window's width (the full sidebar while rendering on the server). */
export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(subscribe, sidebarMode, () => "full");
}

/** The mail column folded away by choice (wide windows): the sidebar is a rail, and hovering it peeks. Remembered on this computer. */
const COLUMN_KEY = "kite-sidebar-column";
const columnListeners = new Set<() => void>();
function readColumnCollapsed() {
  try {
    return localStorage.getItem(COLUMN_KEY) === "collapsed";
  } catch {
    return false;
  }
}

export function useColumnCollapsed(): [boolean, () => void] {
  const collapsed = useSyncExternalStore(
    (listener) => {
      columnListeners.add(listener);
      return () => columnListeners.delete(listener);
    },
    readColumnCollapsed,
    () => false,
  );
  const toggle = () => {
    try {
      if (collapsed) localStorage.removeItem(COLUMN_KEY);
      else localStorage.setItem(COLUMN_KEY, "collapsed");
    } catch {
      // Storage unavailable: nothing to remember it in, so it stays as it is.
    }
    columnListeners.forEach((l) => l());
  };
  return [collapsed, toggle];
}

/**
 * An element's width, measured before paint and kept current (null until it's on screen). Pass
 * the returned ref to the element; it follows the element when it mounts later.
 */
export function useWidth<T extends HTMLElement>() {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width] as const;
}
