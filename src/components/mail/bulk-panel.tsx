"use client";

import {
  Archive02Icon,
  Cancel01Icon,
  Clock01Icon,
  Delete02Icon,
  Mail01Icon,
  MailOpen01Icon,
  SpamIcon,
  StarIcon,
  GitMergeIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import type { Account, Thread } from "@/lib/mail/types";
import { useShortcuts, type ShortcutAction } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { KeyCombo } from "../ui/kbd";
import { Avatar } from "./avatar";
import { CircleButton } from "./circle-button";

/** What can be done to every selected conversation at once. */
export type BulkAction = "archive" | "snooze" | "star" | "read" | "spam" | "delete" | "merge" | "label";

type ActionDef = { id: BulkAction; icon: IconData; label: string; shortcut: ShortcutAction };

/** Labels follow the selection: Star becomes Unstar when every thread is starred, and so on. */
function bulkActions(threads: Thread[]): ActionDef[] {
  if (threads.length && threads.every((t) => t.mailbox === "trash")) return [
    { id: "archive", icon: Mail01Icon, label: "Move to inbox", shortcut: "archive" },
    { id: "delete", icon: Delete02Icon, label: "Delete permanently…", shortcut: "delete" },
  ];
  const allStarred = threads.length > 0 && threads.every((t) => t.starred);
  const anyUnread = threads.some((t) => t.unread);
  return [
    { id: "archive", icon: Archive02Icon, label: "Archive", shortcut: "archive" },
    { id: "snooze", icon: Clock01Icon, label: "Snooze until tomorrow", shortcut: "snooze" },
    { id: "star", icon: StarIcon, label: allStarred ? "Unstar" : "Star", shortcut: "star" },
    { id: "read", icon: anyUnread ? MailOpen01Icon : Mail01Icon, label: anyUnread ? "Mark read" : "Mark unread", shortcut: "toggleRead" },
    { id: "label", icon: Tag01Icon, label: "Labels…", shortcut: "label" },
    { id: "spam", icon: SpamIcon, label: "Report spam", shortcut: "spam" },
    { id: "delete", icon: Delete02Icon, label: "Delete", shortcut: "delete" },
    // Local only: two or more conversations from one account become one.
    ...(threads.length > 1 && new Set(threads.map((t) => t.accountId)).size === 1
      ? [{ id: "merge" as const, icon: GitMergeIcon, label: "Merge", shortcut: "merge" as const }]
      : []),
  ];
}

/** Compact actions for the list header while threads are selected. */
export function BulkBar({
  threads,
  total,
  onAction,
  onSelectAll,
  onClear,
}: {
  threads: Thread[];
  total: number;
  onAction: (action: BulkAction) => void;
  onSelectAll: () => void;
  onClear: () => void;
}) {
  const all = threads.length === total;
  return (
    <div className="blur-fade flex min-w-0 items-center gap-1 whitespace-nowrap pb-1">
      <CircleButton icon={Cancel01Icon} label="Clear selection" shortcut="clearSelection" onClick={onClear} className="size-7" />
      <span className="pl-1 text-[13px] font-medium tabular-nums">{all ? `All ${total}` : threads.length} selected</span>
      {!all ? (
        <button onClick={onSelectAll} className="truncate rounded-full px-1.5 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft">
          Select all
        </button>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        {bulkActions(threads).map((a) => (
          <CircleButton key={a.id} icon={a.icon} label={a.label} shortcut={a.shortcut} onClick={() => onAction(a.id)} className="size-7 border-transparent" />
        ))}
      </div>
    </div>
  );
}

/** Fills the reader pane while threads are selected: who's in the selection and what you can do. */
export function BulkPanel({
  threads,
  accounts,
  onAction,
  onClear,
}: {
  threads: Thread[];
  accounts: Account[];
  onAction: (action: BulkAction) => void;
  onClear: () => void;
}) {
  const shortcuts = useShortcuts();
  const own = new Set(accounts.map((a) => a.email.toLowerCase()));
  const senderOf = (t: Thread) =>
    t.messages.find((m) => m.from.name !== "You" && !own.has(m.from.email.toLowerCase()))?.from ?? t.messages[t.messages.length - 1].from;
  const shown = threads.slice(0, 6);
  const faces = [...new Map(threads.map((t) => senderOf(t)).map((s) => [s.email.toLowerCase(), s])).values()].slice(0, 5);
  const clear = shortcuts.primary("clearSelection");

  return (
    <section className="grid h-full place-items-center overflow-y-auto bg-pane p-8 text-pane-fg">
      <div className="w-full max-w-sm">
        <div className="blur-fade-up flex justify-center" style={{ "--i": 0 } as React.CSSProperties}>
          {faces.map((s, i) => (
            // Initials avatars are tinted see-through; the pane-coloured backing keeps the stack solid.
            <span key={s.email} className={cn("flex rounded-full bg-pane ring-4 ring-pane", i > 0 && "-ml-3")}>
              <Avatar name={s.name} email={s.email} className="size-10" />
            </span>
          ))}
        </div>
        <h2 className="blur-fade-up mt-4 text-center text-[17px] font-semibold tracking-tight" style={{ "--i": 1 } as React.CSSProperties}>
          {threads.length} {threads.length === 1 ? "conversation" : "conversations"} selected
        </h2>

        <ul className="blur-fade-up mt-4 overflow-hidden rounded-xl border border-pane-border" style={{ "--i": 2 } as React.CSSProperties}>
          {shown.map((t) => (
            <li key={t.id} className="flex items-baseline gap-2 border-b border-pane-border px-3 py-2 text-[12.5px] last:border-b-0">
              <span className="w-24 shrink-0 truncate font-medium">{senderOf(t).name}</span>
              <span className="min-w-0 flex-1 truncate text-pane-muted">{t.subject}</span>
            </li>
          ))}
          {threads.length > shown.length ? (
            <li className="px-3 py-2 text-[12px] text-pane-muted">and {threads.length - shown.length} more</li>
          ) : null}
        </ul>

        <div className="blur-fade-up mt-4 grid grid-cols-2 gap-1.5" style={{ "--i": 3 } as React.CSSProperties}>
          {bulkActions(threads).map((a) => {
            const combo = shortcuts.primary(a.shortcut);
            return (
              <button
                key={a.id}
                onClick={() => onAction(a.id)}
                className="flex h-9 items-center gap-2 rounded-full border border-pane-border px-3 text-[12.5px] font-medium transition-colors hover:bg-pane-hover active:scale-[0.98]"
              >
                <Icon icon={a.icon} size={15} className="text-pane-muted" />
                <span className="flex-1 truncate text-left">{a.label}</span>
                {combo ? <KeyCombo combo={combo} keyClassName="bg-pane-hover text-pane-muted" /> : null}
              </button>
            );
          })}
        </div>

        <button
          onClick={onClear}
          className="blur-fade-up mx-auto mt-4 flex items-center gap-1.5 text-[12px] text-pane-muted hover:text-pane-fg"
          style={{ "--i": 4 } as React.CSSProperties}
        >
          Clear selection
          {clear ? <KeyCombo combo={clear} keyClassName="bg-pane-hover text-pane-muted" /> : null}
        </button>
      </div>
    </section>
  );
}
