"use client";

import { memo, useId } from "react";
import { motion } from "motion/react";
import type { ShortcutAction } from "@/lib/shortcuts";
import { spring, springSnappy } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { CountBadge } from "./count-badge";
import { Tooltip } from "./tooltip";

export type ExpandingTab<T extends string> = {
  id: T;
  label: string;
  icon: IconData;
  /** In a badge beside the name; a dot on the icon while the name is folded away. */
  count?: number;
  shortcut?: ShortcutAction;
};

/**
 * A soft track the width of its pane, split into equal parts, with the open one raised in white
 * (a pill that slides between them). Once the track has room every tab spells its name and count;
 * on a narrow pane the others fold to an icon with a dot and the open one takes the extra space.
 * Widths and the pill move on one snappy spring with no blur, so switching lands at once.
 * Memoised: layout animations make Motion measure the page on every re-render.
 */
function ExpandingTabsImpl<T extends string>({
  tabs,
  value,
  onChange,
  label,
  dots = true,
  className,
}: {
  tabs: ExpandingTab<T>[];
  value: T;
  onChange: (id: T) => void;
  /** What the tabs choose, for screen readers. */
  label: string;
  /** A dot on a folded tab with a count: off where counts are totals, not something waiting (a space's files). */
  dots?: boolean;
  className?: string;
}) {
  const pill = useId();
  return (
    <div role="tablist" aria-label={label} className={cn("@container/tabs flex h-9 w-full items-center gap-0.5 rounded-full bg-pane-2 p-[3px] touch:h-11", className)}>
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <Tooltip
            key={tab.id}
            label={tab.count ? `${tab.label} · ${tab.count}` : tab.label}
            shortcut={tab.shortcut}
            className={cn("flex h-full min-w-0", active ? "flex-[2] @min-[380px]/tabs:flex-1" : "flex-1")}
          >
            <motion.button
              layout
              transition={springSnappy}
              whileTap={{ scale: 0.97, transition: spring.fast }}
              type="button"
              role="tab"
              aria-selected={active}
              aria-label={tab.label}
              onClick={() => onChange(tab.id)}
              className={cn(
                "relative flex size-full min-w-0 items-center justify-center rounded-full px-2 text-[13px] outline-none transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-accent/50",
                active ? "font-medium text-pane-fg" : "text-pane-muted hover:text-pane-fg",
              )}
            >
              {active ? (
                <motion.span
                  layoutId={pill}
                  transition={springSnappy}
                  className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_0_0_1px_var(--pane-border),0_1px_2px_rgba(0,0,0,0.06)]"
                />
              ) : null}
              <motion.span layout="position" transition={springSnappy} className="relative flex min-w-0 items-center gap-1.5">
                <span className="relative flex shrink-0">
                  <Icon icon={tab.icon} size={16} />
                  {dots && !active && tab.count ? (
                    <span aria-hidden className="absolute -right-1 -top-0.5 size-1.5 rounded-full bg-accent ring-2 ring-pane-2 @min-[380px]/tabs:hidden" />
                  ) : null}
                </span>
                <span className={cn("truncate", !active && "hidden @min-[380px]/tabs:inline")}>{tab.label}</span>
                {tab.count ? <CountBadge count={tab.count} active={active} className={cn(!active && "hidden @min-[380px]/tabs:inline")} /> : null}
              </motion.span>
            </motion.button>
          </Tooltip>
        );
      })}
    </div>
  );
}

export const ExpandingTabs = memo(ExpandingTabsImpl) as typeof ExpandingTabsImpl;
