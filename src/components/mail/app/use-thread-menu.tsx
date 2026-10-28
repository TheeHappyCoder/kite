"use client";

import { useCallback, useState } from "react";
import {
  Archive02Icon,
  Calendar03Icon,
  Clock01Icon,
  Delete02Icon,
  Folder02Icon,
  GitMergeIcon,
  InboxIcon,
  Mail01Icon,
  MailOpen01Icon,
  Notification02Icon,
  NotificationOff02Icon,
  PinIcon,
  Add01Icon,
  Remove01Icon,
  SpamIcon,
  StarIcon,
  Tag01Icon,
  UserBlock01Icon,
} from "@hugeicons/core-free-icons";
import type { View } from "@/lib/mail/store";
import type { Thread } from "@/lib/mail/types";
import { spaceLabel, spaceTree, type Space } from "@/lib/spaces";
import { ContextMenu, type MenuItem, type MenuPoint } from "../../ui/context-menu";
import { SpaceDot } from "../space-picker";
import type { BulkAction } from "../bulk-panel";

type Deps = {
  view: View;
  spaces: Space[];
  /** The list as shown (with overrides applied). */
  threads: Thread[];
  checked: Set<string>;
  one: {
    archive: (id: string) => void;
    remove: (id: string) => void;
    toggleRead: (id: string) => void;
    snooze: (id: string) => void;
    star: (id: string) => void;
    spam: (id: string) => void;
    pin: (id: string) => void;
    mute: (id: string) => void;
    block: (id: string) => void;
    merge: (thread: Thread) => void;
    addToCalendar: (thread: Thread) => void;
  };
  bulk: (action: BulkAction) => void;
  labels: (threads: Thread[]) => void;
  /** Opens the space picker for these (to move when `move`). */
  pickSpace: (threads: Thread[], move: boolean) => void;
  put: (threads: Thread[], spaceId: string, how: { move?: boolean; from?: string[] }) => void;
  takeOut: (threads: Thread[], spaceId: string, deep?: boolean) => void;
};

/**
 * The actions menu for conversations: right-click a row, its More button, or the Menu key. On a
 * ticked row it acts on everything ticked. Holds what the hover row no longer shows (read, star,
 * pin, mute, labels, merge) plus spaces.
 */
export function useThreadMenu(deps: Deps) {
  const [menu, setMenu] = useState<{ at: MenuPoint; ids: string[] } | null>(null);
  const { checked, threads } = deps;

  const openFor = useCallback(
    (id: string, at: MenuPoint) => setMenu({ at, ids: checked.has(id) ? [...checked] : [id] }),
    [checked],
  );

  const targets = menu ? threads.filter((t) => menu.ids.includes(t.id) && !t.scheduled) : [];
  const items = targets.length ? build(targets, deps) : [];
  const element = <ContextMenu at={targets.length ? (menu?.at ?? null) : null} items={items} label="Conversation actions" onClose={() => setMenu(null)} />;
  return { openFor, element, open: !!menu };
}

function build(targets: Thread[], d: Deps): MenuItem[] {
  const many = targets.length > 1;
  const first = targets[0];
  const trash = targets.every((t) => t.mailbox === "trash");
  // Several: the bulk path (one Undo for all); one: the row's own actions.
  const act = (bulk: BulkAction, one: (id: string) => void) => () => (many ? d.bulk(bulk) : one(first.id));
  const unread = targets.some((t) => t.unread);
  const starred = targets.every((t) => t.starred);
  const here = d.view.kind === "space" ? d.view.spaceId : null;

  const spaceItems = (move: boolean): MenuItem[] => {
    const tree = spaceTree(d.spaces);
    return [
      ...tree.map(({ space, depth }) => {
        const all = targets.every((t) => t.spaces?.includes(space.id));
        return {
          id: space.id,
          label: space.name,
          depth,
          leading: <SpaceDot space={space} />,
          checked: all,
          disabled: all && !move,
          // From the space in view to one of its pockets (or another space): a move between them.
          onSelect: () => d.put(targets, space.id, { move, from: here && here !== space.id ? [here] : [] }),
        };
      }),
      { id: "new", label: tree.length ? "New space…" : "Make a space…", icon: Add01Icon, section: tree.length > 0, onSelect: () => d.pickSpace(targets, move) },
    ];
  };

  const items: MenuItem[] = [
    trash
      ? { id: "restore", label: "Move to inbox", icon: InboxIcon, shortcut: "archive", onSelect: act("archive", d.one.archive) }
      : { id: "archive", label: "Archive", icon: Archive02Icon, shortcut: "archive", onSelect: act("archive", d.one.archive), disabled: targets.every((t) => t.mailbox !== "inbox") },
    { id: "delete", label: trash ? "Delete forever…" : "Delete", icon: Delete02Icon, shortcut: "delete", onSelect: act("delete", d.one.remove) },
    ...(trash ? [] : [{ id: "snooze", label: "Snooze until tomorrow", icon: Clock01Icon, shortcut: "snooze" as const, onSelect: act("snooze", d.one.snooze) }]),

    { id: "read", section: true, label: unread ? "Mark as read" : "Mark as unread", icon: unread ? MailOpen01Icon : Mail01Icon, shortcut: "toggleRead", onSelect: act("read", d.one.toggleRead) },
    { id: "star", label: starred ? "Unstar" : "Star", icon: StarIcon, shortcut: "star", onSelect: act("star", d.one.star) },
    ...(many
      ? []
      : [
          { id: "pin", label: first.pinned ? "Unpin" : "Pin to the top", icon: PinIcon, shortcut: "pin" as const, onSelect: () => d.one.pin(first.id) },
          { id: "mute", label: first.muted ? "Unmute" : "Mute", icon: first.muted ? Notification02Icon : NotificationOff02Icon, shortcut: "mute" as const, onSelect: () => d.one.mute(first.id) },
        ]),

    { id: "space", section: true, label: "Add to space", icon: Folder02Icon, shortcut: "space", submenu: spaceItems(false) },
    ...(targets.some((t) => t.mailbox === "inbox") ? [{ id: "moveSpace", label: "Move to space", icon: Folder02Icon, shortcut: "moveSpace" as const, submenu: spaceItems(true) }] : []),
    ...(here && targets.some((t) => t.spaces?.includes(here))
      ? [{ id: "out", label: `Take out of ${spaceLabel(d.spaces, here)}`, icon: Remove01Icon, onSelect: () => d.takeOut(targets, here) }]
      : []),
    { id: "labels", label: "Labels / folders…", icon: Tag01Icon, shortcut: "label", onSelect: () => (many ? d.bulk("label") : d.labels([first])) },

    ...(many
      ? [{ id: "merge", section: true, label: "Merge into one conversation", icon: GitMergeIcon, shortcut: "merge" as const, onSelect: () => d.bulk("merge") }]
      : [
          { id: "merge", section: true, label: "Merge with…", icon: GitMergeIcon, shortcut: "merge" as const, onSelect: () => d.one.merge(first) },
          { id: "calendar", label: "Add to calendar…", icon: Calendar03Icon, shortcut: "addToCalendar" as const, onSelect: () => d.one.addToCalendar(first) },
        ]),

    ...(trash ? [] : [{ id: "spam", section: true, label: "Report spam", icon: SpamIcon, shortcut: "spam" as const, danger: true, onSelect: act("spam", d.one.spam) }]),
    ...(many || trash ? [] : [{ id: "block", label: "Block the sender", icon: UserBlock01Icon, danger: true, onSelect: () => d.one.block(first.id) }]),
  ];
  return items;
}
