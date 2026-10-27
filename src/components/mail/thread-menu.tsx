"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { AnimatePresence, motion } from "motion/react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import { useShortcuts, type ShortcutAction } from "@/lib/shortcuts";
import { Icon, type IconData } from "../icon";
import { KeyCombo } from "../ui/kbd";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { CircleButton } from "./circle-button";

export type ThreadMenuItem = {
  id: string;
  icon: IconData;
  label: string;
  shortcut?: ShortcutAction;
  onSelect: () => void;
  /** Starts a new group (a divider above it). */
  section?: boolean;
  /** Reports something: shown in the warning colour. */
  danger?: boolean;
};

/**
 * The reader's "More" menu: conversation actions that don't need a toolbar button of their own.
 * `trigger` swaps the round More button for another one (compose's AI menu), `up` opens it upwards,
 * `footer` adds something under the items (compose's own Rewrite instruction), given a way to close.
 */
export function ThreadMenu({
  items,
  trigger,
  up,
  footer,
}: {
  items: ThreadMenuItem[];
  trigger?: (open: boolean, toggle: () => void) => React.ReactNode;
  up?: boolean;
  footer?: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const shortcuts = useShortcuts();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      {trigger ? trigger(open, () => setOpen((v) => !v)) : <CircleButton icon={MoreHorizontalIcon} label="More" active={open} onClick={() => setOpen((v) => !v)} />}
      <AnimatePresence>
        {open ? (
          <motion.div
            {...blurFade({ y: up ? 6 : -6, blur: 6, speed: "moderate" })}
            role="menu"
            className={cn(
              "absolute z-30 w-60 overflow-hidden rounded-2xl border border-pane-border bg-pane p-1.5 shadow-xl",
              up ? "bottom-10 left-0" : "right-0 top-11",
            )}
          >
            {sections(items).map((group, g) => (
              <Fragment key={group[0].id}>
                {g > 0 ? <div role="separator" className="mx-2 my-1 h-px bg-pane-border" /> : null}
                <FluidList tone="pane" className="flex flex-col">
                  {group.map((item) => {
                    const combo = item.shortcut ? shortcuts.primary(item.shortcut) : undefined;
                    return (
                      <button
                        key={item.id}
                        {...FLUID_ITEM}
                        role="menuitem"
                        onClick={() => {
                          setOpen(false);
                          item.onSelect();
                        }}
                        className={cn("relative flex h-9 w-full items-center gap-2.5 rounded-xl px-2.5 text-left text-[13px] touch:h-11", item.danger && "text-warning")}
                      >
                        <Icon icon={item.icon} size={16} className={item.danger ? undefined : "text-pane-muted"} />
                        <span className="flex-1 truncate">{item.label}</span>
                        {combo ? <KeyCombo combo={combo} keyClassName="bg-pane-2 text-pane-muted" /> : null}
                      </button>
                    );
                  })}
                </FluidList>
              </Fragment>
            ))}
            {footer ? footer(() => setOpen(false)) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Splits the menu at its dividers, so the hover highlight stays within one group. */
function sections(items: ThreadMenuItem[]) {
  const groups: ThreadMenuItem[][] = [];
  for (const item of items) {
    if (item.section || !groups.length) groups.push([]);
    groups[groups.length - 1].push(item);
  }
  return groups;
}
