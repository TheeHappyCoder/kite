"use client";

import { memo, useMemo } from "react";
import { InboxIcon, Notification03Icon, Tag01Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import type { InboxSide, InboxTab } from "@/lib/mail/sides";
import type { ShortcutAction } from "@/lib/shortcuts";
import type { IconData } from "../icon";
import { ExpandingTabs, type ExpandingTab } from "../ui/expanding-tabs";

/** The tab shortcuts, by position. */
export const TAB_SHORTCUTS: ShortcutAction[] = ["tab1", "tab2", "tab3", "tab4"];

/** Each tab's icon (Outlook's Focused / Other share Primary's and Updates'). */
const TAB_ICONS: Record<InboxSide, IconData> = {
  important: InboxIcon,
  newsletters: Tag01Icon,
  other: UserGroupIcon,
  notifications: Notification03Icon,
};

/** The inbox's tabs as ExpandingTabs: the full-width track under the list's title. */
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
  const items = useMemo(
    () =>
      tabs.map((tab, i): ExpandingTab<InboxSide> => ({
        id: tab.id,
        label: tab.label,
        icon: TAB_ICONS[tab.id],
        count: counts[tab.id],
        shortcut: TAB_SHORTCUTS[i],
      })),
    [tabs, counts],
  );
  return (
    <div className="pb-1">
      <ExpandingTabs tabs={items} value={value} onChange={onChange} label="Inbox tabs" />
    </div>
  );
});
