"use client";

import { memo } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { InboxSide, InboxTab } from "@/lib/mail/sides";
import type { ShortcutAction } from "@/lib/shortcuts";
import { blurFade, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Tooltip } from "../ui/tooltip";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";

/** The tab shortcuts, by position. */
export const TAB_SHORTCUTS: ShortcutAction[] = ["tab1", "tab2", "tab3", "tab4"];

/**
 * A segmented track: the raised pill slides to the chosen tab (layoutId) and a softer
 * hover glides between tabs (FluidList `glide`), so the hover never reads as a second selection. Only the
 * open tab's count is in the accent.
 * Memoised: the sliding pill makes Motion measure the page each time it re-renders.
 */
export const InboxTabs = memo(function InboxTabs({
  tabs,
  value,
  counts,
  onChange,
}: {
  /** The provider's tabs in view (lib/mail/sides.ts `inboxTabs`). */
  tabs: InboxTab[];
  value: InboxSide;
  counts: Record<InboxSide, number>;
  onChange: (side: InboxSide) => void;
}) {
  return (
    <FluidList
      axis="x"
      tone="pill"
      glide
      role="tablist"
      className="flex w-full min-w-0 items-center gap-0.5 overflow-x-auto rounded-full bg-pane-2 p-[3px] shadow-[inset_0_0_0_1px_var(--pane-border)] [scrollbar-width:none]"
    >
      {tabs.map((c, i) => {
        const active = c.id === value;
        const count = counts[c.id];
        return (
          <Tooltip key={c.id} label={`${c.label} tab`} shortcut={TAB_SHORTCUTS[i]} className="flex shrink-0 grow basis-auto">
            <button
              {...FLUID_ITEM}
              role="tab"
              aria-selected={active}
              onClick={() => onChange(c.id)}
              className={cn(
                "relative flex h-8 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] outline-none transition-[color,font-weight] duration-150 focus-visible:ring-2 focus-visible:ring-accent/40",
                active ? "font-medium text-pane-fg" : "text-pane-muted data-[lit]:text-pane-fg",
              )}
            >
              {active ? (
                <motion.span
                  layoutId="inbox-side-pill"
                  transition={spring.moderate}
                  className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
                />
              ) : null}
              <span className="relative">{c.label}</span>
              <AnimatePresence mode="popLayout" initial={false}>
                {count ? (
                  <motion.span
                    key={count}
                    {...blurFade({ y: 4, blur: 4 })}
                    className={cn(
                      "relative rounded-full px-1.5 text-[11px] font-medium tabular-nums transition-colors duration-150",
                      active ? "bg-accent-soft text-accent" : "bg-pane-border/60 text-pane-muted",
                    )}
                  >
                    {count}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </button>
          </Tooltip>
        );
      })}
    </FluidList>
  );
});
