"use client";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import { useShortcuts, type ShortcutAction } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { KeyCombo } from "./kbd";
import { FLUID_ITEM, FluidList } from "./fluid-hover";

export type MenuItem = {
  id: string;
  label: string;
  icon?: IconData;
  /** Drawn instead of the icon (a space's colour dot). */
  leading?: React.ReactNode;
  /** Shows the user's binding for it. */
  shortcut?: ShortcutAction;
  /** A muted word after the label. */
  detail?: string;
  /** A tick on the right (it's on, or it's in there). */
  checked?: boolean;
  /** Indents it (a pocket under its space). */
  depth?: number;
  onSelect?: () => void;
  /** Opens to the side instead of acting. */
  submenu?: MenuItem[];
  /** Starts a new group (a divider above it). */
  section?: boolean;
  danger?: boolean;
  disabled?: boolean;
};

export type MenuPoint = { x: number; y: number };

const WIDTH = 248;
const SUB_WIDTH = 236;

/**
 * A menu at a point: right-click on a row, the Menu key, or a "More" button. Arrow keys move,
 * → opens a submenu and ← leaves it, Enter picks, Escape or a click outside closes it.
 */
export function ContextMenu({ at, items, onClose, label = "Actions" }: { at: MenuPoint | null; items: MenuItem[]; onClose: () => void; label?: string }) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>{at ? <MenuBody key={`${at.x}:${at.y}`} at={at} items={items} onClose={onClose} label={label} /> : null}</AnimatePresence>,
    document.body,
  );
}

function MenuBody({ at, items, onClose, label }: { at: MenuPoint; items: MenuItem[]; onClose: () => void; label: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(-1);
  /** The submenu open (by its parent's index), and the row lit inside it (-1 = none, keyboard still on the parent). */
  const [sub, setSub] = useState<{ index: number; active: number } | null>(null);
  const usable = items.filter((i) => !i.disabled);

  // Kept inside the window: flipped up or left when it would run off.
  useLayoutEffect(() => {
    const box = root.current?.getBoundingClientRect();
    if (!box) return;
    const left = at.x + box.width > window.innerWidth - 8 ? Math.max(8, at.x - box.width) : at.x;
    const top = at.y + box.height > window.innerHeight - 8 ? Math.max(8, window.innerHeight - 8 - box.height) : at.y;
    setPlace({ left, top });
  }, [at]);

  // Focus waits for the menu to be placed: a hidden element can't take it.
  const placed = !!place;
  useEffect(() => {
    if (placed) root.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) onClose();
    };
    const blur = () => onClose();
    window.addEventListener("mousedown", away, true);
    window.addEventListener("blur", blur);
    window.addEventListener("resize", blur);
    return () => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("blur", blur);
      window.removeEventListener("resize", blur);
    };
  }, [onClose]);

  const pick = (item: MenuItem | undefined) => {
    if (!item || item.disabled) return;
    if (item.submenu) return;
    onClose();
    item.onSelect?.();
  };
  const step = (list: MenuItem[], from: number, by: number) => {
    if (!list.some((i) => !i.disabled)) return -1;
    let at = from;
    do at = (at + by + list.length) % list.length;
    while (list[at].disabled);
    return at;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    const subItems = sub ? (items[sub.index].submenu ?? []) : null;
    const inSub = !!sub && sub.active >= 0 && !!subItems;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        if (inSub) setSub({ index: sub!.index, active: -1 });
        else onClose();
        break;
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const by = e.key === "ArrowDown" ? 1 : -1;
        if (inSub) setSub({ index: sub!.index, active: step(subItems!, sub!.active, by) });
        else {
          setSub(null);
          setActive(step(items, active < 0 && by < 0 ? 0 : active, by));
        }
        break;
      }
      case "ArrowRight":
        if (!inSub && items[active]?.submenu?.length) {
          e.preventDefault();
          setSub({ index: active, active: step(items[active].submenu!, -1, 1) });
        }
        break;
      case "ArrowLeft":
        if (inSub) {
          e.preventDefault();
          setSub({ index: sub!.index, active: -1 });
        }
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (inSub) pick(subItems![sub!.active]);
        else if (items[active]?.submenu?.length) setSub({ index: active, active: step(items[active].submenu!, -1, 1) });
        else pick(items[active]);
        break;
      default:
        // A letter jumps to the next row starting with it.
        if (e.key.length === 1 && /\S/.test(e.key) && !e.ctrlKey && !e.metaKey) {
          const list = inSub ? subItems! : items;
          const from = inSub ? sub!.active : active;
          const found = [...list.slice(from + 1), ...list.slice(0, from + 1)].find((i) => !i.disabled && i.label.toLowerCase().startsWith(e.key.toLowerCase()));
          if (found) {
            const index = list.indexOf(found);
            if (inSub) setSub({ index: sub!.index, active: index });
            else setActive(index);
          }
        }
    }
  };

  // The submenu lines up with the row that opened it.
  const [subTop, setSubTop] = useState(0);
  const subIndex = sub?.index ?? null;
  useLayoutEffect(() => {
    if (subIndex === null) return;
    const row = root.current?.querySelector<HTMLElement>(`[data-row="${subIndex}"]`);
    const box = root.current?.getBoundingClientRect();
    if (row && box) setSubTop(row.getBoundingClientRect().top - box.top);
  }, [subIndex]);

  const openRight = place ? place.left + WIDTH + SUB_WIDTH < window.innerWidth - 8 : true;
  if (!usable.length) return null;
  return (
    <motion.div
      ref={root}
      role="menu"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
      {...blurFade({ y: -4, blur: 4, speed: "moderate" })}
      style={{ left: place?.left ?? at.x, top: place?.top ?? at.y, width: WIDTH, visibility: place ? undefined : "hidden" }}
      className="fixed z-[60] rounded-xl border border-pane-border bg-pane-raised p-1 text-pane-fg shadow-[0_12px_32px_rgba(0,0,0,0.28)] outline-none"
    >
      <Rows
        items={items}
        active={active}
        openSub={sub?.index ?? null}
        onHover={(index) => {
          setActive(index);
          setSub(items[index]?.submenu?.length ? { index, active: -1 } : null);
        }}
        onPick={(index) => (items[index].submenu ? setSub({ index, active: -1 }) : pick(items[index]))}
      />
      {sub && items[sub.index]?.submenu ? (
        <motion.div
          key={sub.index}
          role="menu"
          {...blurFade({ x: openRight ? -4 : 4, blur: 4, speed: "moderate" })}
          style={{ width: SUB_WIDTH, top: subTop - 5 }}
          className={cn(
            "scroll-fade absolute z-10 max-h-[min(420px,70vh)] overflow-y-auto rounded-xl border border-pane-border bg-pane-raised p-1 shadow-[0_12px_32px_rgba(0,0,0,0.28)]",
            openRight ? "left-[calc(100%+6px)]" : "right-[calc(100%+6px)]",
          )}
        >
          <Rows items={items[sub.index].submenu!} active={sub.active} openSub={null} onHover={(i) => setSub({ index: sub.index, active: i })} onPick={(i) => pick(items[sub.index].submenu![i])} />
        </motion.div>
      ) : null}
    </motion.div>
  );
}

function Rows({
  items,
  active,
  openSub,
  onHover,
  onPick,
}: {
  items: MenuItem[];
  active: number;
  openSub: number | null;
  onHover: (index: number) => void;
  onPick: (index: number) => void;
}) {
  const shortcuts = useShortcuts();
  const groups: { item: MenuItem; index: number }[][] = [];
  items.forEach((item, index) => {
    if (item.section || !groups.length) groups.push([]);
    groups[groups.length - 1].push({ item, index });
  });
  return (
    <>
      {groups.map((group, g) => (
        <Fragment key={group[0].item.id}>
          {g > 0 ? <div role="separator" className="mx-2 my-1 h-px bg-pane-border" /> : null}
          <FluidList tone="pane" follow="[data-active=true]" className="flex flex-col">
            {group.map(({ item, index }) => {
              const combo = item.shortcut ? shortcuts.primary(item.shortcut) : undefined;
              const lit = index === active || index === openSub;
              return (
                <div key={item.id} data-row={index}>
                  <button
                    {...FLUID_ITEM}
                    role="menuitem"
                    tabIndex={-1}
                    aria-haspopup={item.submenu ? "menu" : undefined}
                    aria-expanded={item.submenu ? index === openSub : undefined}
                    aria-disabled={item.disabled || undefined}
                    data-active={lit}
                    onPointerEnter={() => !item.disabled && onHover(index)}
                    onClick={() => !item.disabled && onPick(index)}
                    className={cn(
                      "relative flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-[background-color] duration-150 touch:h-11",
                      item.danger && "text-warning",
                      item.disabled && "opacity-45",
                    )}
                    style={item.depth ? { paddingLeft: 10 + item.depth * 14 } : undefined}
                  >
                    {item.leading ?? (item.icon ? <Icon icon={item.icon} size={15} className={item.danger ? undefined : "shrink-0 text-pane-muted"} /> : null)}
                    <span className="min-w-0 flex-1 truncate">
                      {item.label}
                      {item.detail ? <span className="text-pane-muted"> {item.detail}</span> : null}
                    </span>
                    {item.checked ? <Icon icon={Tick02Icon} size={13} className="shrink-0 text-accent" /> : null}
                    {combo ? <KeyCombo combo={combo} keyClassName="bg-pane-2 text-pane-muted" /> : null}
                    {item.submenu ? <Icon icon={ArrowRight01Icon} size={13} className="shrink-0 text-pane-muted" /> : null}
                  </button>
                </div>
              );
            })}
          </FluidList>
        </Fragment>
      ))}
    </>
  );
}
