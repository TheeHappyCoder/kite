"use client";

import { memo, useCallback, useState } from "react";
import { motion } from "motion/react";
import { SPACE_TABS, type SpaceTab } from "@/lib/spaces";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";

const TAB_KEY = "kite-space-tab";

function readTabs(): Record<string, SpaceTab> {
  try {
    const saved = JSON.parse(localStorage.getItem(TAB_KEY) ?? "{}") as Record<string, string>;
    return Object.fromEntries(Object.entries(saved).filter(([, tab]) => SPACE_TABS.some((t) => t.id === tab))) as Record<string, SpaceTab>;
  } catch {
    return {};
  }
}

/** The tab a space opens on, remembered per space (localStorage `kite-space-tab`); Conversations by default. */
export function useSpaceTab(spaceId: string | null): [SpaceTab, (tab: SpaceTab) => void] {
  const [tabs, setTabs] = useState(readTabs);
  const tab = (spaceId && tabs[spaceId]) || "conversations";
  const setTab = useCallback(
    (next: SpaceTab) => {
      if (!spaceId) return;
      setTabs((current) => {
        const saved = { ...current, [spaceId]: next };
        if (next === "conversations") delete saved[spaceId];
        try {
          localStorage.setItem(TAB_KEY, JSON.stringify(saved));
        } catch {
          // Storage unavailable: the tab lasts this page load.
        }
        return saved;
      });
    },
    [spaceId],
  );
  return [tab, setTab];
}

/**
 * Conversations / Files / People under a space's header: the inbox tabs' track (inbox-tabs.tsx),
 * the raised pill sliding to the chosen one. Memoised: the sliding pill makes Motion measure on
 * every re-render.
 */
export const SpaceTabs = memo(function SpaceTabs({ value, counts, onChange }: { value: SpaceTab; counts: Partial<Record<SpaceTab, number>>; onChange: (tab: SpaceTab) => void }) {
  return (
    <div className="@container min-w-0">
    <FluidList
      axis="x"
      tone="pill"
      glide
      role="tablist"
      aria-label="What this space shows"
      className="flex w-full min-w-0 items-center gap-0.5 rounded-full bg-pane-2 p-[3px] shadow-[inset_0_0_0_1px_var(--pane-border)]"
    >
      {SPACE_TABS.map((t) => {
        const active = t.id === value;
        const count = counts[t.id];
        return (
          <button
            key={t.id}
            {...FLUID_ITEM}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "relative flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2 text-[12.5px] outline-none transition-[color,font-weight] duration-150 focus-visible:ring-2 focus-visible:ring-accent/40 touch:h-10",
              active ? "font-medium text-pane-fg" : "text-pane-muted data-[lit]:text-pane-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId="space-tab-pill"
                transition={spring.moderate}
                className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
              />
            ) : null}
            <span className="relative truncate">{t.label}</span>
            {count ? <span className="relative text-[11px] tabular-nums text-pane-muted @max-[300px]:hidden">{count}</span> : null}
          </button>
        );
      })}
    </FluidList>
    </div>
  );
});
