"use client";

import { Command } from "cmdk";
import {
  Archive02Icon,
  Mailbox01Icon,
  Clock01Icon,
  FileEditIcon,
  InboxIcon,
  Mail01Icon,
  Moon02Icon,
  PencilEdit02Icon,
  SentIcon,
  StarIcon,
  Home01Icon,
  FlowIcon,
  ContactBookIcon,
  Calendar03Icon,
  UserCheck01Icon,
  KeyboardIcon,
  TimeScheduleIcon,
  BrushCleaningIcon,
  Settings01Icon,
  Folder02Icon,
  PinIcon,
  NotificationOff02Icon,
  Notification02Icon,
  Note01Icon,
  PencilEdit01Icon,
  GitMergeIcon,
  CalendarAdd01Icon,
  Camera01Icon,
  TranslateIcon,
  TickDouble02Icon,
  Tag01Icon,
  FolderAddIcon,
  FolderExportIcon,
} from "@hugeicons/core-free-icons";
import { accountName, type Account } from "@/lib/mail/types";
import type { View } from "@/lib/mail/store";
import { spaceLabel, spaceTree, type Space } from "@/lib/spaces";
import { Icon, type IconData } from "../icon";
import { useShortcuts, type ShortcutAction } from "@/lib/shortcuts";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { KeyCombo } from "../ui/kbd";

type Props = {
  open: boolean;
  accounts: Account[];
  hasSelection: boolean;
  onOpenChange: (open: boolean) => void;
  onView: (view: View) => void;
  onAccount: (id: string | "all") => void;
  onCompose: () => void;
  onToggleTheme: () => void;
  onArchive: () => void;
  onStar: () => void;
  onSnooze: () => void;
  onOpenShortcuts: () => void;
  screener: boolean;
  /** Local actions for the open conversation (null when none is open). */
  conversation: {
    pinned: boolean;
    muted: boolean;
    hasNote: boolean;
    onPin: () => void;
    onMute: () => void;
    onNote: () => void;
    onRename: () => void;
    onMerge: () => void;
    onAddToCalendar: () => void;
    onScreenshot: () => void;
    /** Translate the newest message on this PC (components/mail/translate.tsx). */
    onTranslate: () => void;
    /** "Labels…" / "Folders…" for this conversation's provider. */
    labelsLabel: string;
    onLabels: () => void;
  } | null;
  /** The user's labels/folders to jump to. */
  labels: { accountId: string; id: string; name: string; account: string | null }[];
  /** "Mark all read" for the current inbox tab, when it has unread mail. */
  markAllRead: { label: string; onSelect: () => void } | null;
  /** Kite's spaces, to go to ("Acme / Website"). */
  spaces: Space[];
  /** Opens the space picker for the open conversation or the ticked rows (null when there's nothing to put). */
  pickSpace: ((move: boolean) => void) | null;
};

const MAILBOXES: { id: Extract<View, { kind: "mailbox" }>["mailbox"]; label: string; icon: IconData }[] = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "screener", label: "Screener", icon: UserCheck01Icon },
  { id: "starred", label: "Starred", icon: StarIcon },
  { id: "snoozed", label: "Snoozed", icon: Clock01Icon },
  { id: "scheduled", label: "Scheduled", icon: TimeScheduleIcon },
  { id: "sent", label: "Sent", icon: SentIcon },
  { id: "drafts", label: "Drafts", icon: FileEditIcon },
  { id: "archive", label: "All mail", icon: Mailbox01Icon },
];

export function CommandPalette(props: Props) {
  const run = (fn: () => void) => () => {
    fn();
    props.onOpenChange(false);
  };

  return (
    <Command.Dialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      label="Command palette"
      overlayClassName="blur-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
      contentClassName="blur-fade-down fixed inset-x-0 top-[18%] z-50 mx-auto w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-pane-border bg-pane text-pane-fg shadow-2xl"
    >
      <Command.Input
        placeholder="Type a command or jump to…"
        className="h-12 w-full border-b border-pane-border bg-transparent px-4 text-[14px] outline-none placeholder:text-pane-muted"
      />
      <Command.List className="scroll-fade max-h-[360px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-pane-muted">
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-pane-muted">No matches.</Command.Empty>
        <FluidList tone="pane" follow="[data-selected=true]">

        <Command.Group heading="Actions">
          <Item icon={PencilEdit02Icon} label="New message" shortcut="compose" onSelect={run(props.onCompose)} />
          {props.hasSelection ? (
            <>
              <Item icon={Archive02Icon} label="Archive conversation" shortcut="archive" onSelect={run(props.onArchive)} />
              <Item icon={StarIcon} label="Star conversation" shortcut="star" onSelect={run(props.onStar)} />
              <Item icon={Clock01Icon} label="Snooze until tomorrow" shortcut="snooze" onSelect={run(props.onSnooze)} />
            </>
          ) : null}
          {props.conversation ? (
            <>
              <Item icon={PinIcon} label={props.conversation.pinned ? "Unpin conversation" : "Pin conversation to the top"} shortcut="pin" onSelect={run(props.conversation.onPin)} />
              <Item
                icon={props.conversation.muted ? Notification02Icon : NotificationOff02Icon}
                label={props.conversation.muted ? "Unmute conversation" : "Mute conversation"}
                shortcut="mute"
                onSelect={run(props.conversation.onMute)}
              />
              <Item icon={Note01Icon} label={props.conversation.hasNote ? "Edit private note" : "Add a private note"} shortcut="note" onSelect={run(props.conversation.onNote)} />
              <Item icon={PencilEdit01Icon} label="Rename subject (only in Kite)" onSelect={run(props.conversation.onRename)} />
              <Item icon={GitMergeIcon} label="Merge with another conversation…" shortcut="merge" onSelect={run(props.conversation.onMerge)} />
              <Item icon={CalendarAdd01Icon} label="Add to calendar…" shortcut="addToCalendar" onSelect={run(props.conversation.onAddToCalendar)} />
              <Item icon={Camera01Icon} label="Screenshot the conversation" shortcut="screenshot" onSelect={run(props.conversation.onScreenshot)} />
              <Item icon={TranslateIcon} label="Translate the newest message" shortcut="translate" onSelect={run(props.conversation.onTranslate)} />
              <Item icon={Tag01Icon} label={props.conversation.labelsLabel} shortcut="label" onSelect={run(props.conversation.onLabels)} />
            </>
          ) : null}
          {props.pickSpace ? (
            <>
              <Item icon={FolderAddIcon} label="Add to space…" shortcut="space" onSelect={run(() => props.pickSpace?.(false))} />
              <Item icon={FolderExportIcon} label="Move to space…" shortcut="moveSpace" onSelect={run(() => props.pickSpace?.(true))} />
            </>
          ) : null}
          {props.markAllRead ? (
            <Item icon={TickDouble02Icon} label={`Mark all read in ${props.markAllRead.label}`} onSelect={run(props.markAllRead.onSelect)} />
          ) : null}
          <Item icon={Moon02Icon} label="Toggle light / dark panes" shortcut="theme" onSelect={run(props.onToggleTheme)} />
          <Item icon={KeyboardIcon} label="Keyboard shortcuts" shortcut="shortcuts" onSelect={run(props.onOpenShortcuts)} />
          <Item icon={Settings01Icon} label="Settings" shortcut="settings" onSelect={run(() => props.onView({ kind: "settings" }))} />
        </Command.Group>

        <Command.Group heading="Go to">
          <Item icon={Home01Icon} label="Home: replies you owe, who owes you, your day" shortcut="home" onSelect={run(() => props.onView({ kind: "home" }))} />
          <Item icon={ContactBookIcon} label="Contacts: everyone your mail knows" shortcut="contacts" onSelect={run(() => props.onView({ kind: "contacts" }))} />
          <Item icon={FlowIcon} label="Automations: what Kite does by itself" shortcut="automations" onSelect={run(() => props.onView({ kind: "automations" }))} />
          <Item icon={Calendar03Icon} label="Calendar: month, week, day, agenda" shortcut="calendar" onSelect={run(() => props.onView({ kind: "calendar" }))} />
          {MAILBOXES.filter((m) => props.screener || m.id !== "screener").map((m) => (
            <Item
              key={m.id}
              icon={m.icon}
              label={m.label}
              onSelect={run(() => {
                props.onView({ kind: "mailbox", mailbox: m.id });
              })}
            />
          ))}
          <Item icon={Folder02Icon} label="All files" shortcut="files" onSelect={run(() => props.onView({ kind: "files" }))} />
          <Item icon={Note01Icon} label="Notes" shortcut="notes" onSelect={run(() => props.onView({ kind: "notes" }))} />
          <Item icon={BrushCleaningIcon} label="Cleanup: who fills your inbox" onSelect={run(() => props.onView({ kind: "cleanup" }))} />
          {props.accounts.length > 1 ? (
            <Item icon={Mail01Icon} label="Switch to all accounts" shortcut="accountAll" onSelect={run(() => props.onAccount("all"))} />
          ) : null}
          {props.accounts.map((a, i) => (
            <Item
              key={a.id}
              icon={Mail01Icon}
              label={`Switch to ${accountName(a)} · ${a.email}`}
              shortcut={i < 9 ? (`account${i + 1}` as ShortcutAction) : undefined}
              onSelect={run(() => props.onAccount(a.id))}
            />
          ))}
        </Command.Group>

        {props.spaces.length ? (
          <Command.Group heading="Spaces">
            {spaceTree(props.spaces).map(({ space }) => (
              <Item
                key={space.id}
                icon={Folder02Icon}
                color={space.color}
                label={`Go to ${spaceLabel(props.spaces, space.id)}`}
                onSelect={run(() => props.onView({ kind: "space", spaceId: space.id }))}
              />
            ))}
          </Command.Group>
        ) : null}

        {props.labels.length ? (
          <Command.Group heading="Labels">
            {props.labels.map((l) => (
              <Item
                key={`${l.accountId}:${l.id}`}
                icon={Tag01Icon}
                label={l.account ? `${l.name} · ${l.account}` : l.name}
                onSelect={run(() => props.onView({ kind: "label", accountId: l.accountId, labelId: l.id }))}
              />
            ))}
          </Command.Group>
        ) : null}

        </FluidList>
      </Command.List>
    </Command.Dialog>
  );
}

function Item({
  icon,
  label,
  shortcut,
  color,
  onSelect,
}: {
  icon: IconData;
  label: string;
  shortcut?: ShortcutAction;
  color?: string;
  onSelect: () => void;
}) {
  const { primary } = useShortcuts();
  const combo = shortcut ? primary(shortcut) : undefined;
  return (
    <Command.Item
      {...FLUID_ITEM}
      value={label}
      onSelect={onSelect}
      className="relative flex h-9 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13.5px]"
    >
      <Icon icon={icon} size={16} className="text-pane-muted" style={color ? { color } : undefined} />
      <span className="flex-1">{label}</span>
      {combo ? <KeyCombo combo={combo} keyClassName="bg-pane-2 text-pane-muted" /> : null}
    </Command.Item>
  );
}
