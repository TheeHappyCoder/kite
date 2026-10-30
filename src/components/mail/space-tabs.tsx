"use client";

import { memo, useCallback, useMemo, useState } from "react";
import { BubbleChatIcon, Folder01Icon, UserMultipleIcon } from "@hugeicons/core-free-icons";
import { SPACE_TABS, type SpaceTab } from "@/lib/spaces";
import type { IconData } from "../icon";
import { ExpandingTabs, type ExpandingTab } from "../ui/expanding-tabs";

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

/** Each tab's icon. */
const TAB_ICONS: Record<SpaceTab, IconData> = { conversations: BubbleChatIcon, files: Folder01Icon, people: UserMultipleIcon };

/**
 * Conversations / Files / People under a space's header: the inbox's ExpandingTabs, an icon per tab
 * and the counts in badges (no dots: they're totals, not something waiting).
 */
export const SpaceTabs = memo(function SpaceTabs({ value, counts, onChange }: { value: SpaceTab; counts: Partial<Record<SpaceTab, number>>; onChange: (tab: SpaceTab) => void }) {
  const items = useMemo(
    () => SPACE_TABS.map((t): ExpandingTab<SpaceTab> => ({ id: t.id, label: t.label, icon: TAB_ICONS[t.id], count: counts[t.id] })),
    [counts],
  );
  return <ExpandingTabs tabs={items} value={value} onChange={onChange} label="What this space shows" dots={false} className="min-w-0" />;
});
