"use client";

import { Mail01Icon, MailOpen01Icon, NotificationOff02Icon, Notification02Icon } from "@hugeicons/core-free-icons";
import { type Thread } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { CircleButton } from "./circle-button";
import { BUTTON_ICONS } from "./button-icons";
import { BUTTON_INFO, DIVIDER, MENU_ORDER, TOOLBAR_SIZES, fitToolbar, tidySlots, type ButtonAction, type ToolbarLayout, type ToolbarSlot } from "@/lib/buttons";
import { type ThreadMenuItem } from "./thread-menu";
import { accountSpec } from "@/lib/mail/providers";
import { capitalise } from "@/lib/format";
import type { Props } from "./reader";

/** A conversation action as the reader shows it now: on a button or in More. */
type ReaderAction = ThreadMenuItem & { active?: boolean; badge?: number; iconClassName?: string };

/**
 * Every action (lib/buttons.ts) as it stands for this conversation, or missing where it doesn't apply:
 * Trash keeps the way back, Delete for good and how you see it; a scheduled send has nothing to write.
 */
export function readerActions(props: Props, thread: Thread, fileCount: number): Partial<Record<ButtonAction, ReaderAction>> {
  const trash = thread.mailbox === "trash";
  const writing = !thread.scheduled;
  const organise = !trash && !thread.scheduled;
  const acts: Partial<Record<ButtonAction, ReaderAction>> = {
    archive: { id: "archive", icon: trash ? Mail01Icon : BUTTON_ICONS.archive, label: trash ? "Move to inbox" : "Archive", shortcut: "archive", onSelect: props.onArchive },
    trash: { id: "trash", icon: BUTTON_ICONS.trash, label: trash ? "Delete permanently…" : "Delete", shortcut: "delete", danger: trash, onSelect: props.onDelete },
    star: {
      id: "star",
      icon: BUTTON_ICONS.star,
      label: thread.starred ? "Unstar" : "Star",
      shortcut: "star",
      onSelect: props.onStar,
      iconClassName: cn(thread.starred && "fill-warning text-warning"),
    },
    chat: { id: "chat", icon: BUTTON_ICONS.chat, label: props.chat ? "Show as email" : "Show as chat", shortcut: "chatView", onSelect: props.onToggleChat, active: props.chat },
    people: {
      id: "people",
      icon: BUTTON_ICONS.people,
      label: props.people ? "Hide people" : "People in this conversation",
      shortcut: "people",
      onSelect: props.onTogglePeople,
      active: !!props.people,
    },
    screenshot: { id: "screenshot", icon: BUTTON_ICONS.screenshot, label: "Screenshot", shortcut: "screenshot", onSelect: () => props.onScreenshot() },
  };
  if (fileCount) {
    acts.files = {
      id: "files",
      icon: BUTTON_ICONS.files,
      label: props.filesOpen ? "Hide files" : "Files in this conversation",
      shortcut: "threadFiles",
      onSelect: props.onToggleFiles,
      active: props.filesOpen,
      badge: fileCount,
    };
  }
  if (writing) {
    acts.replyAll = { id: "replyAll", icon: BUTTON_ICONS.replyAll, label: "Reply all", shortcut: "replyAll", onSelect: () => props.onCompose("replyAll") };
    acts.forward = { id: "forward", icon: BUTTON_ICONS.forward, label: "Forward", shortcut: "forward", onSelect: () => props.onCompose("forward") };
  }
  if (!trash) acts.snooze = { id: "snooze", icon: BUTTON_ICONS.snooze, label: "Snooze until tomorrow", shortcut: "snooze", onSelect: props.onSnooze };
  if (organise) {
    Object.assign(acts, {
      read: { id: "read", icon: thread.unread ? MailOpen01Icon : Mail01Icon, label: thread.unread ? "Mark as read" : "Mark as unread", shortcut: "toggleRead", onSelect: props.onToggleRead },
      pin: { id: "pin", icon: BUTTON_ICONS.pin, label: thread.pinned ? "Unpin" : "Pin to the top", shortcut: "pin", onSelect: props.onPin, active: thread.pinned },
      labels: { id: "labels", icon: BUTTON_ICONS.labels, label: `${capitalise(accountSpec(props.account).organise.plural)}…`, shortcut: "label", onSelect: props.onLabels },
      mute: {
        id: "mute",
        icon: thread.muted ? Notification02Icon : NotificationOff02Icon,
        label: thread.muted ? "Unmute" : "Mute conversation",
        shortcut: "mute",
        onSelect: props.onMute,
      },
      summarise: { id: "summarise", icon: BUTTON_ICONS.summarise, label: "Summarise with AI", shortcut: "summarise", onSelect: props.onSummarise },
      note: { id: "note", icon: BUTTON_ICONS.note, label: thread.note ? "Edit private note" : "Add a private note", shortcut: "note", onSelect: () => props.onRequestEdit("note") },
      rename: { id: "rename", icon: BUTTON_ICONS.rename, label: "Rename subject", onSelect: () => props.onRequestEdit("rename") },
      merge: { id: "merge", icon: BUTTON_ICONS.merge, label: "Merge with…", shortcut: "merge", onSelect: props.onMerge },
      calendar: { id: "calendar", icon: BUTTON_ICONS.calendar, label: "Add to calendar…", shortcut: "addToCalendar", onSelect: props.onAddToCalendar },
      spam: { id: "spam", danger: true, icon: BUTTON_ICONS.spam, label: "Report spam", shortcut: "spam", onSelect: props.onSpam },
    } satisfies Partial<Record<ButtonAction, ReaderAction>>);
  }
  return acts;
}

/** A group up to its first divider. */
/** How finely the toolbar measures its room (useWidthStep): a re-render per step of a resize, not per pixel. */
export const TOOLBAR_STEP = 12;

/**
 * The toolbar as it fits in the header's `width` (its content box): room off for Back (with its
 * line), More, and the subject's least width while it's up there; null (not measured yet) = all of it.
 */
export function toolbarFor(
  bar: ToolbarLayout,
  acts: Partial<Record<ButtonAction, ReaderAction>>,
  width: number | null,
  { back, subject }: { back: boolean; subject: boolean },
): ToolbarLayout {
  if (width === null) return bar;
  const touch = typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
  const button = touch ? TOOLBAR_SIZES.touchButton : TOOLBAR_SIZES.button;
  const { gap, divider } = TOOLBAR_SIZES;
  const taken = (back ? button + gap + divider + gap : 0) + (subject ? TOOLBAR_SIZES.subject : 0) + gap + button;
  return fitToolbar(bar, (action) => !!acts[action], width - taken, button);
}

/** More: every action that applies and isn't on the toolbar, in BUTTON_INFO's groups (a divider between). */
export function moreItems(acts: Partial<Record<ButtonAction, ReaderAction>>, placed: Set<ToolbarSlot>): ThreadMenuItem[] {
  let group: string | null = null;
  return MENU_ORDER.flatMap((action) => {
    const act = acts[action];
    if (!act || placed.has(action)) return [];
    const section = group !== null && group !== BUTTON_INFO[action].group;
    group = BUTTON_INFO[action].group;
    return [{ id: act.id, icon: act.icon, label: act.label, shortcut: act.shortcut, onSelect: act.onSelect, danger: act.danger, section }];
  });
}

/** One side of the toolbar: its buttons in order, a thin line where the layout has a divider. */
export function ToolbarGroup({ slots, acts }: { slots: ToolbarSlot[]; acts: Partial<Record<ButtonAction, ReaderAction>> }) {
  return tidySlots(slots.filter((slot) => slot === DIVIDER || acts[slot])).map((slot, i) => {
    if (slot === DIVIDER) return <span key={`divider:${i}`} className="mx-1.5 h-5 w-px shrink-0 bg-pane-border" />;
    const act = acts[slot]!;
    return (
      <CircleButton
        key={slot}
        icon={act.icon}
        label={act.label}
        shortcut={act.shortcut}
        onClick={act.onSelect}
        active={act.active}
        badge={act.badge}
        iconClassName={act.iconClassName}
      />
    );
  });
}
