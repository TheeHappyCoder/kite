"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowDown01Icon,
  Cancel01Icon,
  Clock01Icon,
  FileEditIcon,
  Home01Icon,
  Folder01Icon,
  InboxIcon,
  Mailbox01Icon,
  Delete02Icon,
  Search01Icon,
  SentIcon,
  Settings02Icon,
  StarIcon,
  Tag01Icon,
  Tick02Icon,
  TimeScheduleIcon,
  UserCheck01Icon,
} from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import type { View } from "@/lib/mail/store";
import { accountName, type Account, type Mailbox } from "@/lib/mail/types";
import { accountSpec, labelDepth, leafName, sortLabels, type MailLabel } from "@/lib/mail/providers";
import type { SavedSearch } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { AccentTitle } from "../ui/accent-title";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";

// The mail list's title switches between Home, mailboxes, saved searches and your own labels/folders
// when the mail column isn't showing (rail and drawer widths, lib/layout.ts).

const MAILBOXES: { id: Mailbox; label: string; icon: IconData }[] = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "screener", label: "Screener", icon: UserCheck01Icon },
  { id: "starred", label: "Starred", icon: StarIcon },
  { id: "snoozed", label: "Snoozed", icon: Clock01Icon },
  { id: "scheduled", label: "Scheduled", icon: TimeScheduleIcon },
  { id: "sent", label: "Sent", icon: SentIcon },
  { id: "drafts", label: "Drafts", icon: FileEditIcon },
  { id: "archive", label: "All mail", icon: Mailbox01Icon },
  { id: "trash", label: "Trash", icon: Delete02Icon },
];

/** Counts worth showing: mail that needs you, not totals. */
const COUNTED = new Set<Mailbox>(["inbox", "screener", "scheduled", "drafts"]);

export function MailboxSwitcher({
  title,
  view,
  counts,
  screener,
  accounts,
  labels,
  savedSearches,
  activeQuery,
  onView,
  onSearch,
  onRemoveSearch,
}: {
  title: string;
  view: View;
  counts: Partial<Record<Mailbox, number>>;
  /** Show the Screener (on, or holding someone). */
  screener: boolean;
  accounts: Account[];
  labels: MailLabel[];
  savedSearches: SavedSearch[];
  activeQuery: string;
  onView: (view: View) => void;
  onSearch: (query: string) => void;
  onRemoveSearch: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  const go = (next: View) => {
    setOpen(false);
    onView(next);
  };
  const groups = accounts
    .map((account) => ({ account, spec: accountSpec(account), labels: labels.filter((l) => l.accountId === account.id) }))
    .filter((g) => g.labels.length);
  const nouns = new Set(groups.map((g) => g.spec.organise.plural));
  const noun = nouns.size === 1 ? [...nouns][0] : "labels and folders";

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="-ml-1.5 flex max-w-full items-center gap-1.5 rounded-xl px-1.5 py-0.5 text-left transition-colors duration-150 hover:bg-pane-hover"
      >
        <h1 className="truncate text-[20px] font-medium tracking-[-0.035em]">
          <AccentTitle text={title} />
        </h1>
        <Icon icon={ArrowDown01Icon} size={14} className={cn("shrink-0 text-pane-muted transition-transform duration-150", open && "rotate-180")} />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            {...blurFade({ y: -6, blur: 6, speed: "moderate" })}
            className="scroll-fade absolute left-0 top-10 z-30 max-h-[min(70vh,540px)] w-[272px] max-w-[calc(100vw-32px)] overflow-y-auto rounded-2xl border border-pane-border bg-pane p-1.5 text-pane-fg shadow-[0_24px_60px_-20px_rgb(10_30_60/0.45)]"
          >
            <FluidList tone="pane" className="flex flex-col gap-px">
              <Row icon={Home01Icon} label="Home" active={false} onClick={() => go({ kind: "home" })} />
              {MAILBOXES.filter((m) => m.id !== "screener" || screener).map((m) => (
                <Row
                  key={m.id}
                  icon={m.icon}
                  label={m.label}
                  count={COUNTED.has(m.id) ? counts[m.id] : undefined}
                  active={view.kind === "mailbox" && view.mailbox === m.id && !activeQuery}
                  onClick={() => go({ kind: "mailbox", mailbox: m.id })}
                />
              ))}
            </FluidList>

            {savedSearches.length ? (
              <>
                <Heading>Saved searches</Heading>
                <FluidList tone="pane" className="flex flex-col gap-px">
                  {savedSearches.map((saved) => (
                    <div key={saved.id} className="group/saved relative">
                      <Row
                        icon={Search01Icon}
                        label={saved.name}
                        active={activeQuery === saved.query}
                        onClick={() => {
                          setOpen(false);
                          onSearch(saved.query);
                        }}
                      />
                      <button
                        {...FLUID_IGNORE}
                        aria-label="Remove saved search"
                        onClick={() => onRemoveSearch(saved.id)}
                        className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-pane-muted opacity-0 hover:bg-pane-hover hover:text-pane-fg group-hover/saved:opacity-100 touch:opacity-100"
                      >
                        <Icon icon={Cancel01Icon} size={12} />
                      </button>
                    </div>
                  ))}
                </FluidList>
              </>
            ) : null}

            {groups.length ? (
              <>
                <Heading
                  action={
                    <button
                      onClick={() => go({ kind: "settings", section: "labels" })}
                      className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] font-medium text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                    >
                      <Icon icon={Settings02Icon} size={12} />
                      Manage
                    </button>
                  }
                >
                  {noun.charAt(0).toUpperCase() + noun.slice(1)}
                </Heading>
                {groups.map(({ account, spec, labels: own }) => (
                  <div key={account.id}>
                    {groups.length > 1 ? (
                      <div className="flex items-center gap-1.5 truncate px-2.5 pb-0.5 pt-1.5 text-[11px] text-pane-muted">
                        <span className="size-1.5 shrink-0 rounded-full" style={{ background: account.color }} />
                        {accountName(account)}
                      </div>
                    ) : null}
                    <FluidList tone="pane" className="flex flex-col gap-px">
                      {sortLabels(own, spec).map((label) => (
                        <Row
                          key={label.id}
                          indent={labelDepth(label, spec)}
                          icon={label.kind === "folder" ? Folder01Icon : Tag01Icon}
                          dot={label.kind === "tag" ? label.color : undefined}
                          label={leafName(label, spec)}
                          count={label.unread || undefined}
                          active={view.kind === "label" && view.accountId === account.id && view.labelId === label.id}
                          onClick={() => go({ kind: "label", accountId: account.id, labelId: label.id })}
                        />
                      ))}
                    </FluidList>
                  </div>
                ))}
              </>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Heading({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="mt-2 flex items-center justify-between border-t border-pane-border px-2.5 pb-1 pt-2.5 text-[11.5px] font-medium text-pane-muted">
      {children}
      {action}
    </div>
  );
}

function Row({
  icon,
  label,
  count,
  active,
  indent = 0,
  dot,
  onClick,
}: {
  icon: IconData;
  label: string;
  count?: number;
  active: boolean;
  indent?: number;
  dot?: string | null;
  onClick: () => void;
}) {
  return (
    <button
      {...FLUID_ITEM}
      role="menuitem"
      onClick={onClick}
      style={{ paddingLeft: 10 + indent * 14 }}
      className="flex h-8 w-full items-center gap-2.5 rounded-lg pr-2.5 text-left text-[13px] transition-[background-color] duration-150 touch:h-11"
    >
      {dot ? (
        <span className="grid size-4 shrink-0 place-items-center">
          <span className="size-2.5 rounded-full" style={{ background: dot }} />
        </span>
      ) : (
        <Icon icon={icon} size={16} className={cn("shrink-0", active ? "text-accent" : "text-pane-muted")} />
      )}
      <span className={cn("min-w-0 flex-1 truncate", active && "font-medium")}>{label}</span>
      {count ? <span className="text-[12px] tabular-nums text-pane-muted">{count}</span> : null}
      {active ? <Icon icon={Tick02Icon} size={14} className="shrink-0 text-accent" /> : null}
    </button>
  );
}
