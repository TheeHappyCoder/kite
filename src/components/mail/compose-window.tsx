"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { animate, AnimatePresence, LayoutGroup, motion, useMotionValue } from "motion/react";
import { Cancel01Icon, DragDropVerticalIcon } from "@hugeicons/core-free-icons";
import { blurFade, exitFor, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";

/** How many compose windows can be open at once (minimised ones count). */
export const MAX_COMPOSERS = 4;

const MARGIN = 16;
const GAP = 12;
const MIN_W = 380;
const MIN_H = 320;
const DEFAULT = { w: 580, h: 600 };
const SIZE_KEY = "kite-compose-size";
/** Below this window width a compose window fills the screen (no dragging or resizing). */
const PHONE = 640;
const phone = () => window.innerWidth < PHONE;

type Rect = { x: number; y: number; w: number; h: number };
type Edges = { l?: boolean; r?: boolean; t?: boolean; b?: boolean };

function savedSize() {
  try {
    const size = JSON.parse(localStorage.getItem(SIZE_KEY) ?? "null") as { w?: unknown; h?: unknown } | null;
    if (typeof size?.w === "number" && typeof size.h === "number") return { w: size.w, h: size.h };
  } catch {}
  return DEFAULT;
}

function saveSize(w: number, h: number) {
  try {
    localStorage.setItem(SIZE_KEY, JSON.stringify({ w: Math.round(w), h: Math.round(h) }));
  } catch {}
}

/** Keeps a window inside the viewport, shrinking it when the viewport is smaller (filling a phone's). */
function fit(rect: Rect): Rect {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  if (vw < PHONE) return { x: 0, y: 0, w: vw, h: vh };
  const w = Math.max(Math.min(MIN_W, vw - 2 * MARGIN), Math.min(rect.w, vw - 2 * MARGIN));
  const h = Math.max(Math.min(MIN_H, vh - 2 * MARGIN), Math.min(rect.h, vh - 2 * MARGIN));
  return {
    w,
    h,
    x: Math.min(Math.max(MARGIN, rect.x), vw - w - MARGIN),
    y: Math.min(Math.max(MARGIN, rect.y), vh - h - MARGIN),
  };
}

/** Where a new window opens: side by side from the bottom right, in staggered rows when they don't fit. */
function startRect(slot: number): Rect {
  const { w, h } = fit({ x: 0, y: 0, ...savedSize() });
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const across = Math.max(1, Math.floor((vw - 2 * MARGIN + GAP) / (w + GAP)));
  const col = slot % across;
  const row = Math.floor(slot / across);
  return fit({ x: vw - MARGIN - (col + 1) * w - col * GAP - row * 32, y: vh - h - MARGIN - row * 36, w, h });
}

/** Where minimised composers sit: along the bottom, left or right edge, never over the middle. */
export type DockEdge = "bottom" | "left" | "right";
/** An edge and the tab's centre along it (0 to 1), so a spot survives viewport changes. */
export type DockSpot = { edge: DockEdge; at: number };

const DOCK_KEY = "kite-compose-dock";
/** Space between tabs on one edge. */
const TAB_GAP = 12;
/** How each edge turns a tab drawn for the bottom edge, so its open side always meets the edge. */
const TAB_TURN: Record<DockEdge, number> = { bottom: 0, left: 90, right: -90 };

function savedSpot(): DockSpot {
  try {
    const spot = JSON.parse(localStorage.getItem(DOCK_KEY) ?? "null") as { edge?: unknown; at?: unknown } | null;
    if ((spot?.edge === "bottom" || spot?.edge === "left" || spot?.edge === "right") && typeof spot.at === "number") return { edge: spot.edge, at: spot.at };
  } catch {}
  return { edge: "bottom", at: 1 };
}

/** The edge nearest a point (the top is left free), and where along it the point falls. */
function spotAt(px: number, py: number): DockSpot {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const bottom = vh - py;
  if (px <= bottom && px <= vw - px) return { edge: "left", at: py / vh };
  if (vw - px <= bottom) return { edge: "right", at: py / vh };
  return { edge: "bottom", at: px / vw };
}

type DockEntry = { spot: DockSpot; seq: number; size: { w: number; h: number } | null; shown: boolean };
type Placement = { x: number; y: number };

/**
 * Lays out minimised composers' tabs. Each composer keeps its spot while it's open (minimise it
 * again and it goes back there); tabs on one edge line up in order of their spots without
 * overlapping, and the side edges stop short of the bottom row. mail-app holds one for the session.
 */
export class ComposeDock {
  private entries = new Map<number, DockEntry>();
  private listeners = new Set<() => void>();
  private version = 0;
  private seq = 0;
  /** The tab being dragged and the spot it would land on. */
  private preview: { id: number; spot: DockSpot } | null = null;

  private changed = () => {
    this.version++;
    for (const listener of this.listeners) listener();
  };

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1) window.addEventListener("resize", this.changed);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) window.removeEventListener("resize", this.changed);
    };
  };

  snapshot = () => this.version;

  /** A tab appeared or changed size. A composer minimised for the first time takes the last spot a tab was dropped on. */
  show(id: number, size: { w: number; h: number }) {
    const entry = this.entries.get(id);
    if (entry?.shown && entry.size?.w === size.w && entry.size.h === size.h) return;
    this.entries.set(id, entry ? { ...entry, size, shown: true } : { spot: savedSpot(), seq: ++this.seq, size, shown: true });
    this.changed();
  }

  /** The tab went away (restored); its spot is kept for next time. */
  hide(id: number) {
    const entry = this.entries.get(id);
    if (!entry?.shown) return;
    entry.shown = false;
    this.changed();
  }

  /** The composer closed. */
  remove(id: number) {
    if (this.entries.delete(id)) this.changed();
  }

  edgeOf(id: number): DockEdge {
    if (this.preview?.id === id) return this.preview.spot.edge;
    return this.entries.get(id)?.spot.edge ?? savedSpot().edge;
  }

  /** While dragging: where the tab would land. */
  drag(id: number, spot: DockSpot) {
    this.preview = { id, spot };
    this.changed();
  }

  /** Drops a tab on a spot, and remembers it for the next composer minimised. */
  drop(id: number, spot: DockSpot) {
    const entry = this.entries.get(id);
    this.preview = null;
    if (entry) entry.spot = spot;
    try {
      localStorage.setItem(DOCK_KEY, JSON.stringify(spot));
    } catch {}
    this.changed();
  }

  /** The tab's box on screen: as measured along the bottom, turned on its side along the left and right. */
  boxOf(id: number) {
    const size = this.entries.get(id)?.size;
    if (!size) return null;
    return this.edgeOf(id) === "bottom" ? size : { w: size.h, h: size.w };
  }

  /** Where every shown tab goes: flush against its edge. */
  layout(): Map<number, Placement> {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const tabs = [...this.entries]
      .filter(([, e]) => e.shown && e.size)
      .map(([id, e]) => ({ id, seq: e.seq, size: this.boxOf(id)!, spot: this.preview?.id === id ? this.preview.spot : e.spot }));
    const band = (edge: DockEdge) => Math.max(0, ...tabs.filter((t) => t.spot.edge === edge).map((t) => (edge === "bottom" ? t.size.h : t.size.w)));
    const bands = { bottom: band("bottom"), left: band("left"), right: band("right") };
    const placed = new Map<number, Placement>();
    for (const edge of ["bottom", "left", "right"] as const) {
      const row = tabs
        .filter((t) => t.spot.edge === edge)
        // Same spot: the one minimised first ends up furthest along.
        .sort((a, b) => a.spot.at - b.spot.at || b.seq - a.seq);
      if (!row.length) continue;
      const along = (t: (typeof row)[number]) => (edge === "bottom" ? t.size.w : t.size.h);
      const length = edge === "bottom" ? vw : vh;
      // The bottom row runs between the side columns; the side columns stop above the bottom row.
      const lo = MARGIN + (edge === "bottom" && bands.left ? bands.left + TAB_GAP : 0);
      const hi = length - MARGIN - (edge === "bottom" ? (bands.right ? bands.right + TAB_GAP : 0) : bands.bottom ? bands.bottom + TAB_GAP : 0);
      const starts = row.map((t) => Math.round(Math.min(Math.max(lo, t.spot.at * length - along(t) / 2), hi - along(t))));
      for (let i = 1; i < row.length; i++) starts[i] = Math.max(starts[i], starts[i - 1] + along(row[i - 1]) + TAB_GAP);
      for (let i = row.length - 1; i >= 0; i--) starts[i] = Math.max(lo, Math.min(starts[i], (i === row.length - 1 ? hi : starts[i + 1] - TAB_GAP) - along(row[i])));
      row.forEach((t, i) => {
        if (edge === "bottom") placed.set(t.id, { x: starts[i], y: vh - t.size.h });
        else placed.set(t.id, { x: edge === "left" ? 0 : vw - t.size.w, y: starts[i] });
      });
    }
    return placed;
  }
}


/**
 * A minimised composer: a tab growing out of a window edge, like a folder tab, with a grip to drag
 * it, the message to restore it and Close. Dragged by the grip, it snaps to the nearest edge
 * (bottom, left or right) and stays there.
 */
function DockTab({
  dock,
  id,
  title,
  detail,
  onRestore,
  onClose,
}: {
  dock: ComposeDock;
  id: number;
  title: string;
  detail: string;
  onRestore: () => void;
  onClose: () => void;
}) {
  const measure = useRef<HTMLDivElement>(null);
  const [held, setHeld] = useState<Placement | null>(null);
  useSyncExternalStore(dock.subscribe, dock.snapshot, () => 0);
  const edge = dock.edgeOf(id);
  const box = dock.boxOf(id);
  const slot = dock.layout().get(id);
  const tipSide = edge === "bottom" ? "top" : edge === "left" ? "right" : "left";

  // The tab is measured as drawn for the bottom edge; the dock turns it for the sides.
  useLayoutEffect(() => {
    const el = measure.current;
    if (!el) return;
    const report = () => dock.show(id, { w: el.offsetWidth, h: el.offsetHeight });
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => {
      observer.disconnect();
      dock.hide(id);
    };
  }, [dock, id]);

  const grab = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    let last: DockSpot | null = null;
    track(
      e,
      "grabbing",
      (dx, dy) => {
        const px = e.clientX + dx;
        const py = e.clientY + dy;
        last = spotAt(px, py);
        dock.drag(id, last);
        // The tab follows the pointer, turned for the edge it would land on; the others make room.
        const size = dock.boxOf(id);
        if (!size) return;
        setHeld({
          x: Math.min(Math.max(0, px - size.w / 2), window.innerWidth - size.w),
          y: Math.min(Math.max(0, py - size.h / 2), window.innerHeight - size.h),
        });
      },
      () => {
        setHeld(null);
        if (last) dock.drop(id, last);
      },
    );
  };

  // Lands on its slot at once the first time, follows the pointer while held, and glides otherwise.
  const at = held ?? slot;
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const placed = useRef(false);
  const toX = at?.x;
  const toY = at?.y;
  const following = !!held;
  useLayoutEffect(() => {
    if (toX === undefined || toY === undefined) return;
    if (!placed.current || following) {
      placed.current = true;
      x.set(toX);
      y.set(toY);
      return;
    }
    const moves = [animate(x, toX, spring.moderate), animate(y, toY, spring.moderate)];
    return () => moves.forEach((m) => m.stop());
  }, [toX, toY, following, x, y]);

  return (
    <motion.div
      style={{ x, y, width: box?.w, height: box?.h, visibility: at ? "visible" : "hidden" }}
      className="fixed left-0 top-0 z-30 select-none"
    >
      <div ref={measure} className="absolute left-1/2 top-1/2 w-max" style={{ transform: `translate(-50%, -50%) rotate(${TAB_TURN[edge]}deg)` }}>
        {/* Rises out of its edge (the tab's own "down" always points at the edge). */}
        <motion.div {...blurFade({ y: 10, speed: "moderate" })}>
          <div
            className={cn(
              "ink-chrome relative flex h-[34px] items-center gap-0.5 rounded-t-xl bg-frame pl-1 pr-1.5 pt-0.5 text-frame-fg",
              "shadow-[inset_0_1px_0_rgb(255_255_255/0.07)] [filter:drop-shadow(0_-2px_10px_rgb(0_0_0/0.22))]",
            )}
          >
            <Tooltip label="Drag along the edge" side={tipSide} className="inline-flex">
              <span
                onPointerDown={grab}
                className={cn(
                  "grid h-6 w-5 shrink-0 touch-none place-items-center rounded-md text-frame-muted transition-colors duration-150 hover:bg-frame-hover hover:text-frame-fg",
                  held ? "cursor-grabbing" : "cursor-grab",
                )}
              >
                <Icon icon={DragDropVerticalIcon} size={14} />
              </span>
            </Tooltip>
            <Tooltip label="Restore" shortcut="minimizeCompose" side={tipSide} className="flex min-w-0">
              <button
                onClick={onRestore}
                className="flex h-6 min-w-0 max-w-56 items-center gap-1.5 rounded-md px-1.5 text-left text-[12.5px] transition-colors duration-150 hover:bg-frame-hover"
              >
                <span className="shrink-0 font-medium">{title}</span>
                {detail ? (
                  <span data-sensitive className="min-w-0 truncate text-frame-muted">
                    {detail}
                  </span>
                ) : null}
              </button>
            </Tooltip>
            <Tooltip label="Close and keep draft" side={tipSide} className="inline-flex">
              <button
                aria-label="Close"
                onClick={onClose}
                className="grid size-6 shrink-0 place-items-center rounded-full text-frame-muted transition-colors duration-150 hover:bg-frame-hover hover:text-frame-fg"
              >
                <Icon icon={Cancel01Icon} size={12} />
              </button>
            </Tooltip>
          </div>
        </motion.div>
      </div>
    </motion.div>
  );
}

/** Follows the pointer from `e` until release, calling `move` with the distance travelled. */
function track(e: React.PointerEvent, cursor: string, move: (dx: number, dy: number) => void, done: () => void) {
  e.preventDefault();
  const startX = e.clientX;
  const startY = e.clientY;
  const previous = document.body.style.cursor;
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";
  const onMove = (ev: PointerEvent) => move(ev.clientX - startX, ev.clientY - startY);
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    document.body.style.cursor = previous;
    document.body.style.userSelect = "";
    done();
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

const HANDLES: { edges: Edges; cursor: string; className: string }[] = [
  { edges: { t: true }, cursor: "ns-resize", className: "inset-x-3 -top-1 h-2" },
  { edges: { b: true }, cursor: "ns-resize", className: "inset-x-3 -bottom-1 h-2" },
  { edges: { l: true }, cursor: "ew-resize", className: "inset-y-3 -left-1 w-2" },
  { edges: { r: true }, cursor: "ew-resize", className: "inset-y-3 -right-1 w-2" },
  { edges: { t: true, l: true }, cursor: "nwse-resize", className: "-left-1 -top-1 size-4" },
  { edges: { t: true, r: true }, cursor: "nesw-resize", className: "-right-1 -top-1 size-4" },
  { edges: { b: true, l: true }, cursor: "nesw-resize", className: "-bottom-1 -left-1 size-4" },
  { edges: { b: true, r: true }, cursor: "nwse-resize", className: "-bottom-1 -right-1 size-4" },
];

/**
 * A floating compose window: dragged by its title bar, resized from any edge or corner, kept on
 * screen when the viewport changes. Minimised, it stays mounted (drafts keep saving, and it restores
 * where it was) and shows a tab in the dock instead.
 */
export function ComposeWindow({
  id,
  slot,
  z,
  minimized,
  away = false,
  dock,
  tab,
  onFront,
  onRestore,
  onClose,
  className,
  children,
  ...rest
}: {
  id: number;
  slot: number;
  z: number;
  minimized: boolean;
  /** Sending: the window steps aside (still mounted, so a failed send brings it back as it was). */
  away?: boolean;
  dock: ComposeDock;
  /** What the minimised tab says: the kind of message, then the subject or who it's to. */
  tab: { title: string; detail: string };
  onFront: () => void;
  onRestore: () => void;
  onClose: () => void;
  className?: string;
  children: ReactNode;
} & Pick<React.HTMLAttributes<HTMLDivElement>, "onKeyDown" | "onDragOver" | "onDragLeave" | "onDrop">) {
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const w = useMotionValue(DEFAULT.w);
  const h = useMotionValue(DEFAULT.h);
  const slotRef = useRef(slot);

  const rect = (): Rect => ({ x: x.get(), y: y.get(), w: w.get(), h: h.get() });
  const set = (next: Rect) => {
    x.set(next.x);
    y.set(next.y);
    w.set(next.w);
    h.set(next.h);
  };

  // Place once on open (the viewport is only known in the browser), and refit when it changes.
  useEffect(() => {
    const place = (next: Rect) => {
      x.set(next.x);
      y.set(next.y);
      w.set(next.w);
      h.set(next.h);
    };
    place(startRect(slotRef.current));
    const onResize = () => place(fit({ x: x.get(), y: y.get(), w: w.get(), h: h.get() }));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [x, y, w, h]);
  useEffect(() => () => dock.remove(id), [dock, id]);

  const drag = (e: React.PointerEvent) => {
    const target = e.target as Element;
    if (e.button !== 0 || phone() || !target.closest("[data-window-drag]") || target.closest("button, input, select, textarea, a, [role=radio], [role=radiogroup]")) return;
    const start = rect();
    track(
      e,
      "grabbing",
      (dx, dy) => {
        const next = fit({ ...start, x: start.x + dx, y: start.y + dy });
        x.set(next.x);
        y.set(next.y);
      },
      () => {},
    );
  };

  const resize = (e: React.PointerEvent, edges: Edges, cursor: string) => {
    if (e.button !== 0 || phone()) return;
    const start = rect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const minW = Math.min(MIN_W, vw - 2 * MARGIN);
    const minH = Math.min(MIN_H, vh - 2 * MARGIN);
    track(
      e,
      cursor,
      (dx, dy) => {
        let { x: left, y: top } = start;
        let right = start.x + start.w;
        let bottom = start.y + start.h;
        if (edges.l) left = Math.min(Math.max(MARGIN, start.x + dx), right - minW);
        if (edges.r) right = Math.max(Math.min(vw - MARGIN, right + dx), left + minW);
        if (edges.t) top = Math.min(Math.max(MARGIN, start.y + dy), bottom - minH);
        if (edges.b) bottom = Math.max(Math.min(vh - MARGIN, bottom + dy), top + minH);
        set({ x: left, y: top, w: right - left, h: bottom - top });
      },
      () => saveSize(w.get(), h.get()),
    );
  };

  return (
    <>
      <motion.div
        {...rest}
        data-composer={id}
        hidden={minimized}
        inert={away}
        initial={false}
        animate={away ? { opacity: 0, scale: 0.97, filter: "blur(6px)", transition: exitFor.slow } : { opacity: 1, scale: 1, filter: "blur(0px)", transition: spring.slow }}
        onPointerDownCapture={onFront}
        onPointerDown={drag}
        onFocusCapture={onFront}
        style={{ left: x, top: y, width: w, height: h, zIndex: z }}
        // The entrance is CSS; it's dropped while away so the motion above can take the window out.
        className={cn("fixed flex flex-col", !away && "blur-fade-up", away && "pointer-events-none", className)}
      >
        <LayoutGroup id={`composer-${id}`}>
          {children}
        </LayoutGroup>
        {HANDLES.map((handle) => (
          <div
            key={handle.cursor + handle.className}
            aria-hidden
            onPointerDown={(e) => resize(e, handle.edges, handle.cursor)}
            className={cn("absolute z-10 max-sm:hidden", handle.className)}
            style={{ cursor: handle.cursor }}
          />
        ))}
      </motion.div>
      <AnimatePresence>
        {minimized ? <DockTab key="tab" dock={dock} id={id} title={tab.title} detail={tab.detail} onRestore={onRestore} onClose={onClose} /> : null}
      </AnimatePresence>
    </>
  );
}
