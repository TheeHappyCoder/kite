"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";

import {
  AiMagicIcon,
  Mailbox01Icon,
  Delete02Icon,
  Clock01Icon,
  FileEditIcon,
  InboxIcon,
  PencilEdit02Icon,
  Search01Icon,
  SentIcon,
  Settings01Icon,
  StarIcon,
  Calendar03Icon,
  UserCheck01Icon,
  TimeScheduleIcon,
  BrushCleaningIcon,
  Folder02Icon,
  Note01Icon,
  Cancel01Icon,
  Tag01Icon,
  Folder01Icon,
  ArrowRight01Icon,
  Settings02Icon,
  Menu01Icon,
  Home01Icon,
  FlowIcon,
  ContactBookIcon,
  ArrowDown01Icon,
  Add01Icon,
  CloudDownloadIcon,
} from "@hugeicons/core-free-icons";
import { accountName, type Account, type Mailbox } from "@/lib/mail/types";
import type { View } from "@/lib/mail/store";
import type { SavedSearch } from "@/lib/settings";
import { blurFade, exitFor, spring, springSnappy } from "@/lib/motion";
import { ALL_ACCOUNTS, inScope, makeScope, scopeIds, type AccountScope } from "@/lib/mail/scope";
import { useShortcuts, type ShortcutAction } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { AccountFace } from "./account-face";
import { Tooltip } from "../ui/tooltip";
import { KeyCombo } from "../ui/kbd";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { AiLogo } from "../ai-logos";
import { UsageRing } from "../ui/usage-ring";
import { ringLabel, type AiUsageSummary } from "@/lib/ai-pricing";
import { accountSpec, labelDepth, leafName, sortLabels, type MailLabel } from "@/lib/mail/providers";
import { stableHandlers } from "../ui/stable";
import { DesktopUpdate } from "../desktop/update";
import { SPACE_COLORS, THREAD_DRAG, spaceTree, type Space } from "@/lib/spaces";
import { ContextMenu, type MenuItem, type MenuPoint } from "../ui/context-menu";
import { SpaceDot } from "./space-picker";

type MailboxItem = { id: Mailbox; label: string; icon: IconData };

/** Where new mail lands: the things to look at first. */
const PRIMARY: MailboxItem[] = [
  { id: "inbox", label: "Inbox", icon: InboxIcon },
  { id: "screener", label: "Screener", icon: UserCheck01Icon },
];

const MAILBOXES: MailboxItem[] = [
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


type Props = {
  accounts: Account[];
  /** Unread inbox conversations per account id. */
  unread: Record<string, number>;
  aiLabel?: string | null;
  aiPreset?: string | null;
  onOpenAi: () => void;
  /** With an AI connected, its row opens Settings → AI (usage and limits). */
  onOpenAiUsage: () => void;
  /** Live AI usage, for the ring beside the model name. */
  aiUsage?: AiUsageSummary | null;
  /** The accounts in view (lib/mail/scope.ts). */
  accountId: AccountScope;
  view: View;
  counts: { mailbox: Partial<Record<Mailbox, number>> };
  /** What needs you on Home: replies you owe plus what's due today (nudges, snoozes waking, sends). */
  homeCount: number;
  /** The user's labels/folders for the accounts in view. */
  labels: MailLabel[];
  theme: "light" | "dark";
  onAccount: (scope: AccountScope) => void;
  onView: (view: View) => void;
  onCompose: () => void;
  onToggleTheme: () => void;
  onOpenPalette: () => void;
  onOpenShortcuts: () => void;
  onAddAccount: () => void;
  demo: boolean;
  /** e.g. "Syncing 140 of 650" or "Up to date". */
  syncLabel?: string | null;
  /** Accounts on their first sync: their faces' rings run as spinners. */
  syncing?: string[];
  /** Accounts that need signing in again. */
  reconnecting?: string[];
  /** Hide the Screener mailbox when it's turned off and empty. */
  screener: boolean;
  savedSearches: SavedSearch[];
  /** The search in the list right now, to highlight its saved entry. */
  activeQuery: string;
  onSearch: (query: string) => void;
  onRemoveSearch: (id: string) => void;
  /** `full` (labels and all) or `rail` (icons only, labels in tooltips); see lib/layout.ts. */
  mode?: "full" | "rail";
  /** The rail's "Show sidebar": opens the full sidebar as a drawer. */
  onExpand?: () => void;
  /** Kite's spaces and pockets (lib/spaces.ts). */
  spaces: Space[];
  onCreateSpace: (name: string, parentId: string | null) => Promise<Space | null>;
  onUpdateSpace: (id: string, patch: { name?: string; color?: string; parentId?: string | null }) => void;
  onDeleteSpace: (id: string) => void;
  /** Conversations dropped on a space (Shift held: moved out of the Inbox too). */
  onDropOnSpace: (spaceId: string, threadIds: string[], move: boolean) => void;
  /** Inside the drawer: fills it instead of taking its own width. */
  inDrawer?: boolean;
};

/** The sidebar is an icon rail: rows show their icon only, with the label in a tooltip. */
const RailContext = createContext(false);

function NavItem({
  icon,
  label,
  count,
  active,
  color,
  trailing,
  leading,
  emphasis,
  onClick,
}: {
  icon: IconData;
  leading?: React.ReactNode;
  label: string;
  count?: number;
  active?: boolean;
  color?: string;
  trailing?: React.ReactNode;
  /** The count as an accent pill (unread inbox). */
  emphasis?: boolean;
  onClick: () => void;
}) {
  const rail = useContext(RailContext);
  if (rail) {
    const glyph = leading ?? (
      <Icon
        icon={icon}
        size={18}
        className={cn("shrink-0 transition-colors duration-150", !color && (active ? "text-frame-fg" : "text-frame-fg/55 group-data-[lit]/nav:text-frame-fg"))}
        style={color ? { color } : undefined}
      />
    );
    return (
      <Tooltip label={count ? `${label} · ${count}` : label} side="right" className="flex">
        <button
          {...FLUID_ITEM}
          onClick={onClick}
          aria-label={label}
          aria-current={active ? "page" : undefined}
          className="group/nav relative grid h-10 w-full shrink-0 place-items-center rounded-[10px] transition-[color,background-color] duration-150 short:h-8 touch:h-11"
        >
          {active ? <motion.span layoutId="sidebar-active" transition={springSnappy} className="absolute inset-0 rounded-[10px] bg-white/[0.1]" /> : null}
          <span className="relative grid place-items-center">
            {glyph}
            {count ? (
              <span aria-hidden className={cn("absolute -right-1 -top-0.5 size-2 rounded-full", emphasis ? "bg-lime" : "bg-white/80")} />
            ) : trailing ? (
              <span className="absolute -right-1.5 -top-1">{trailing}</span>
            ) : null}
          </span>
        </button>
      </Tooltip>
    );
  }
  return (
    <button
      {...FLUID_ITEM}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        // The selected row eases into a heavier weight (Geist is variable) instead of snapping.
        "group/nav relative flex h-9 w-full items-center gap-3 rounded-[10px] px-2.5 text-[14px] transition-[color,background-color,font-weight] duration-150 touch:h-11",
        active ? "font-medium text-frame-fg" : "text-frame-fg/85 data-[lit]:text-frame-fg",
      )}
    >
      {active ? <motion.span layoutId="sidebar-active" transition={springSnappy} className="absolute inset-0 rounded-[10px] bg-white/[0.1]" /> : null}
      <span className="relative flex min-w-0 flex-1 items-center gap-3">
        {leading ?? (
          <Icon
            icon={icon}
            size={18}
            className={cn("shrink-0 transition-colors duration-150", !color && (active ? "text-frame-fg" : "text-frame-fg/55 group-data-[lit]/nav:text-frame-fg/80"))}
            style={color ? { color } : undefined}
          />
        )}
        <span className="flex-1 truncate text-left">{label}</span>
        {trailing}
        {count ? (
          <span className={cn("text-[13px] tabular-nums", emphasis ? "font-medium text-frame-fg/75" : "text-frame-fg/40")}>{count}</span>
        ) : null}
      </span>
    </button>
  );
}

/** Collapsed sections, remembered on this computer. */
const COLLAPSED_KEY = "kite-sidebar-collapsed";
const collapsedListeners = new Set<() => void>();
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSED_KEY) ?? "";
  } catch {
    return "";
  }
}
function useCollapsed(id: string): [boolean, () => void] {
  const raw = useSyncExternalStore(
    (listener) => {
      collapsedListeners.add(listener);
      return () => collapsedListeners.delete(listener);
    },
    readCollapsed,
    () => "",
  );
  const ids = raw ? raw.split(",") : [];
  const collapsed = ids.includes(id);
  const toggle = () => {
    const next = collapsed ? ids.filter((x) => x !== id) : [...ids, id];
    try {
      localStorage.setItem(COLLAPSED_KEY, next.join(","));
    } catch {
      // Storage unavailable: the section still toggles for this page load.
    }
    collapsedListeners.forEach((l) => l());
  };
  return [collapsed, toggle];
}

/** A quiet heading that folds its section; `action` shows on hover. */
function Section({ id, title, action, children }: { id: string; title: string; action?: React.ReactNode; children: React.ReactNode }) {
  const [collapsed, toggle] = useCollapsed(id);
  if (useContext(RailContext)) {
    // The rail has no headings: a divider, then the icons (folded sections stay folded).
    return collapsed ? null : <FluidList className="mt-2 flex flex-col gap-px border-t border-frame-border pt-2">{children}</FluidList>;
  }
  return (
    <div className="mt-5">
      <div className="group/section flex h-7 items-center pr-1">
        <button
          onClick={toggle}
          aria-expanded={!collapsed}
          className="flex h-full min-w-0 flex-1 items-center justify-between gap-1 rounded-md px-2.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-frame-fg/40 transition-colors hover:text-frame-fg/70"
        >
          <span className="truncate">{title}</span>
          <Icon
            icon={ArrowDown01Icon}
            size={13}
            className={cn("shrink-0 opacity-0 transition-[transform,opacity] group-hover/section:opacity-100", collapsed && "-rotate-90 opacity-100")}
          />
        </button>
        {action}
      </div>
      <AnimatePresence initial={false}>
        {collapsed ? null : (
          <motion.div
            initial={{ height: 0, opacity: 0, filter: "blur(4px)" }}
            animate={{ height: "auto", opacity: 1, filter: "blur(0px)" }}
            exit={{ height: 0, opacity: 0, filter: "blur(4px)" }}
            transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <FluidList className="flex flex-col gap-px">{children}</FluidList>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function FrameIconButton({ label, shortcut, icon, onClick, side = "top" }: { label: string; shortcut?: ShortcutAction; icon: IconData; onClick: () => void; side?: "top" | "right" }) {
  return (
    <Tooltip label={label} shortcut={shortcut} side={side}>
      <button
        aria-label={label}
        onClick={onClick}
        className="grid size-8 place-items-center rounded-lg text-frame-muted transition-colors hover:bg-frame-hover hover:text-frame-fg touch:size-11"
      >
        <Icon icon={icon} size={16} />
      </button>
    </Tooltip>
  );
}

/** Views that belong to Mail: the mail column shows beside the rail while one is open. */
const MAIL_VIEWS = new Set<View["kind"]>(["mailbox", "label", "space", "home", "cleanup"]);

/**
 * The navigation is one dark panel floating on the sky like the panes (a solid surface keeps every
 * row equally readable): a rail of the app's sections and your accounts, and, while Mail is open,
 * the mail column (New message, then MAILBOXES and LABELS). Rail mode (narrower windows) shows the
 * rail only; the mail list's title then switches mailboxes. The drawer shows both.
 * Memoised (see stableHandlers): it re-renders when its data changes, not on every keystroke in the app.
 */
export const Sidebar = stableHandlers(function Sidebar(props: Props) {
  const mail = MAIL_VIEWS.has(props.view.kind);
  const column = !!props.inDrawer || (props.mode !== "rail" && mail);
  return (
    <div
      className={cn(
        "ink-chrome flex shrink-0 overflow-hidden bg-[rgb(22_24_30/0.86)] text-frame-fg backdrop-blur-2xl backdrop-saturate-150",
        props.inDrawer ? "h-full w-full" : "my-2 ml-2 mr-2 rounded-2xl shadow-[0_24px_60px_-28px_rgb(5_15_35/0.65),inset_0_1px_0_rgb(255_255_255/0.07)]",
      )}
    >
      <LayoutGroup id="sidebar-rail">
        <SectionRail {...props} mail={mail} column={column} />
      </LayoutGroup>
      {column ? (
        <LayoutGroup id="sidebar-column">
          <MailColumn {...props} />
        </LayoutGroup>
      ) : null}
    </div>
  );
});

function SectionRail(props: Props & { mail: boolean; column: boolean }) {
  const { view, counts } = props;
  return (
    <RailContext value>
      <aside className="flex min-h-0 w-[60px] shrink-0 flex-col bg-black/25 pb-3 pt-3 short:pb-2 short:pt-2">
        <div className="scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto px-2 [scrollbar-width:none]">
        <FluidList className="flex flex-col gap-1 short:gap-0.5">
          <NavItem icon={InboxIcon} label="Mail" count={props.column ? undefined : counts.mailbox.inbox} emphasis active={props.mail} onClick={() => props.onView({ kind: "mailbox", mailbox: "inbox" })} />
          <NavItem icon={Calendar03Icon} label="Calendar" active={view.kind === "calendar"} onClick={() => props.onView({ kind: "calendar" })} />
          <NavItem icon={FlowIcon} label="Automations" active={view.kind === "automations"} onClick={() => props.onView({ kind: "automations" })} />
          <NavItem icon={Folder02Icon} label="Files" active={view.kind === "files"} onClick={() => props.onView({ kind: "files" })} />
          <NavItem icon={Note01Icon} label="Notes" active={view.kind === "notes"} onClick={() => props.onView({ kind: "notes" })} />
          <NavItem icon={ContactBookIcon} label="Contacts" active={view.kind === "contacts"} onClick={() => props.onView({ kind: "contacts" })} />
        </FluidList>

        <div className="mx-2 my-3 h-px shrink-0 bg-white/[0.08] short:my-2" />
        <RailAccounts {...props} />
        </div>

        <FluidList className="mt-2 flex flex-col gap-1 border-t border-white/[0.08] px-2 pt-2 short:gap-0.5">
          <DesktopUpdate trigger={(open, label) => <NavItem icon={CloudDownloadIcon} label={label} onClick={open} trailing={<span className="block size-1.5 rounded-full bg-lime" />} />} />
          <NavItem icon={Search01Icon} label="Search or jump to" onClick={props.onOpenPalette} />
          <NavItem
            icon={AiMagicIcon}
            label={props.aiLabel ? `${props.aiLabel} · ${props.aiUsage ? ringLabel(props.aiUsage) : "usage and limits"}` : "Connect your AI"}
            leading={props.aiPreset && props.aiPreset !== "custom" ? <AiLogo id={props.aiPreset} size={18} /> : undefined}
            trailing={props.aiLabel ? <UsageRing share={props.aiUsage?.ring.share ?? null} size={10} stroke={2} /> : null}
            onClick={props.aiLabel ? props.onOpenAiUsage : props.onOpenAi}
          />
          <NavItem icon={Settings01Icon} label="Settings" active={view.kind === "settings"} onClick={() => props.onView({ kind: "settings" })} />
        </FluidList>
      </aside>
    </RailContext>
  );
}

/**
 * Your accounts in the rail, each with its unread count: click one to see only it, click it again
 * (or All) for every account; Ctrl or ⌘-click adds or removes one from what's in view. Adding one is
 * in Settings → Accounts.
 */
function RailAccounts(props: Props) {
  const { accounts, accountId, unread } = props;
  const ids = scopeIds(accountId);
  const toggle = (id: string, add: boolean) => {
    if (!add) return props.onAccount(ids?.length === 1 && ids[0] === id ? ALL_ACCOUNTS : id);
    const current = ids ?? accounts.map((a) => a.id);
    props.onAccount(makeScope(current.includes(id) ? current.filter((x) => x !== id) : [...current, id], accounts));
  };
  return (
    <FluidList className="flex flex-col items-center gap-1.5">
      {accounts.length > 1 ? (
        <Tooltip label="All accounts" side="right" className="flex w-full">
          <button
            {...FLUID_ITEM}
            aria-label="All accounts"
            aria-pressed={!ids}
            onClick={() => props.onAccount(ALL_ACCOUNTS)}
            className={cn(
              "grid h-9 w-full shrink-0 place-items-center rounded-[10px] text-[11px] font-semibold tracking-wide transition-colors duration-150 short:h-8",
              !ids ? "bg-white/[0.1] text-frame-fg" : "text-frame-fg/55 data-[lit]:bg-white/[0.06] data-[lit]:text-frame-fg",
            )}
          >
            All
          </button>
        </Tooltip>
      ) : null}
      {accounts.map((account) => {
        const shown = !!ids?.includes(account.id);
        const count = unread[account.id] ?? 0;
        const reconnect = props.reconnecting?.includes(account.id) && !props.syncing?.includes(account.id);
        return (
          <Tooltip
            key={account.id}
            label={`${accountName(account)}${reconnect ? " · reconnect needed" : count ? ` · ${count} unread` : ""}`}
            side="right"
            className="flex w-full"
          >
            <button
              {...FLUID_ITEM}
              aria-label={accountName(account)}
              aria-pressed={shown}
              onClick={(e) => toggle(account.id, e.ctrlKey || e.metaKey)}
              className={cn("relative grid h-10 w-full shrink-0 place-items-center rounded-[10px] transition-colors duration-150 short:h-9", shown ? "bg-white/[0.1]" : "data-[lit]:bg-white/[0.06]")}
            >
              {/* Just the face in its ring: unread is a lime dot (the count is in the tooltip and the Inbox row), a reconnect an amber one. */}
              <AccountFace account={account} tone="frame" marked={false} syncing={props.syncing?.includes(account.id)} className="size-6 text-[9px]" />
              {reconnect ? (
                <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-warning shadow-[0_0_0_2px_rgb(22_24_30)]" />
              ) : count ? (
                <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-lime shadow-[0_0_0_2px_rgb(22_24_30)]" />
              ) : null}
            </button>
          </Tooltip>
        );
      })}
      {/* Adding accounts lives in Settings → Accounts; the demo keeps a way in. */}
      {props.demo ? (
        <Tooltip label="Connect your mail" side="right" className="flex w-full">
          <button
            {...FLUID_ITEM}
            aria-label="Connect your mail"
            onClick={props.onAddAccount}
            className="grid h-9 w-full shrink-0 place-items-center rounded-[10px] text-frame-fg/45 transition-colors duration-150 data-[lit]:bg-white/[0.06] data-[lit]:text-frame-fg short:h-8"
          >
            <Icon icon={Add01Icon} size={16} />
          </button>
        </Tooltip>
      ) : null}
    </FluidList>
  );
}

/** The mail column: New message, then Home and Today, MAILBOXES, LABELS and saved searches. */
function MailColumn(props: Props) {
  const shortcuts = useShortcuts();
  const { view, counts } = props;
  const mailboxActive = (id: Mailbox) => view.kind === "mailbox" && view.mailbox === id && !props.activeQuery;
  const openMailbox = (id: Mailbox) => props.onView({ kind: "mailbox", mailbox: id });
  const compose = shortcuts.primary("compose");
  return (
    <aside className={cn("flex shrink-0 flex-col px-2.5 pb-3 pt-3", props.inDrawer ? "min-w-0 flex-1" : "w-[220px]")}>
      {/* The first row, not a banner: the rows' own shape, a frosted fill and a hairline of light on top. */}
      <button
        onClick={props.onCompose}
        className="group/compose flex h-9 items-center gap-3 rounded-[10px] bg-white/[0.08] px-2.5 text-[14px] font-medium text-frame-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.08),0_0_0_1px_rgb(255_255_255/0.05)] transition-[background-color,transform] duration-150 hover:bg-white/[0.12] active:translate-y-px touch:h-11"
      >
        <Icon icon={PencilEdit02Icon} size={18} className="shrink-0 text-frame-fg/80 transition-colors duration-150 group-hover/compose:text-frame-fg" />
        <span className="flex-1 text-left">New message</span>
        {compose ? <KeyCombo combo={compose} keyClassName="bg-white/[0.08] text-frame-fg/50" /> : null}
      </button>

      <nav className="-mx-1 mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto px-1 pb-2 scroll-fade [scrollbar-width:none]">
        <FluidList className="flex flex-col gap-px">
          <NavItem icon={Home01Icon} label="Home" count={props.homeCount || undefined} active={view.kind === "home"} onClick={() => props.onView({ kind: "home" })} />
        </FluidList>

        <Section id="mailboxes" title="Mailboxes">
          {[...PRIMARY.filter((m) => m.id !== "screener" || props.screener || counts.mailbox.screener), ...MAILBOXES].map((m) => (
            <NavItem
              key={m.id}
              icon={m.icon}
              label={m.label}
              count={COUNTED.has(m.id) ? counts.mailbox[m.id] : undefined}
              emphasis={m.id === "inbox"}
              active={mailboxActive(m.id)}
              onClick={() => openMailbox(m.id)}
            />
          ))}
          <NavItem icon={BrushCleaningIcon} label="Cleanup" active={view.kind === "cleanup"} onClick={() => props.onView({ kind: "cleanup" })} />
        </Section>

        <SpaceSection {...props} />

        <LabelSection accounts={props.accounts} labels={props.labels} view={view} onView={props.onView} />

        {props.savedSearches.length ? (
          <Section id="searches" title="Searches">
            {props.savedSearches.map((saved) => (
              <div key={saved.id} className="group relative">
                <NavItem icon={Search01Icon} label={saved.name} active={props.activeQuery === saved.query} onClick={() => props.onSearch(saved.query)} />
                <Tooltip label="Remove saved search" side="right" className="absolute right-1.5 top-1/2 flex -translate-y-1/2">
                  <button
                    {...FLUID_IGNORE}
                    aria-label="Remove saved search"
                    onClick={() => props.onRemoveSearch(saved.id)}
                    className="grid size-6 place-items-center rounded-md text-frame-muted opacity-0 hover:bg-white/10 hover:text-frame-fg group-hover:opacity-100 touch:opacity-100"
                  >
                    <Icon icon={Cancel01Icon} size={12} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </Section>
        ) : null}
      </nav>

      {props.demo ? (
        <button
          onClick={props.onAddAccount}
          className="mt-2 flex items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-[12.5px] text-frame-fg/60 transition-colors duration-150 hover:bg-white/[0.06] hover:text-frame-fg"
        >
          <span className="size-1.5 shrink-0 rounded-full bg-lime" />
          <span className="min-w-0 flex-1 truncate">Connect your mail</span>
          <Icon icon={ArrowRight01Icon} size={13} />
        </button>
      ) : null}
    </aside>
  );
}

/** Navigation in the drawer: each of these closes it as well. */
const CLOSES_DRAWER = ["onView", "onCompose", "onOpenPalette", "onOpenShortcuts", "onAddAccount", "onOpenAi", "onOpenAiUsage", "onSearch"] as const;

/**
 * The full sidebar over the panes, from the left edge: narrow windows (behind the menu button) and
 * the rail's "Show sidebar". Picking somewhere to go closes it, as do Escape and the backdrop.
 */
export function SidebarDrawer({ open, onClose, ...props }: Props & { open: boolean; onClose: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  const closing = Object.fromEntries(
    CLOSES_DRAWER.map((key) => [
      key,
      (...args: unknown[]) => {
        onClose();
        (props[key] as (...a: unknown[]) => void)(...args);
      },
    ]),
  ) as Pick<Props, (typeof CLOSES_DRAWER)[number]>;
  return (
    <AnimatePresence>
      {open ? (
        <div key="drawer" className="fixed inset-0 z-40">
          <motion.div
            className="absolute inset-0 bg-black/45 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: spring.moderate }}
            exit={{ opacity: 0, transition: exitFor.moderate }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal
            aria-label="Sidebar"
            {...blurFade({ x: -16, blur: 6, speed: "moderate" })}
            className="absolute inset-y-0 left-0 w-[300px] max-w-[88vw] shadow-2xl"
          >
            {/* Its own layout group, so its highlight never flies over from the rail. */}
            <LayoutGroup id="sidebar-drawer">
              <Sidebar {...props} {...closing} mode="full" inDrawer onExpand={undefined} />
            </LayoutGroup>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

/** Narrow windows: the frame's top bar, with the menu (the sidebar as a drawer), search and New message. */
export function SidebarTopBar({
  accounts,
  accountId,
  onMenu,
  onOpenPalette,
  onCompose,
}: {
  accounts: Account[];
  accountId: AccountScope;
  onMenu: () => void;
  onOpenPalette: () => void;
  onCompose: () => void;
}) {
  const inView = accounts.filter((a) => inScope(accountId, a.id));
  return (
    <header className="flex h-12 shrink-0 items-center gap-1 px-2 text-frame-fg">
      <FrameIconButton label="Menu" shortcut="menu" icon={Menu01Icon} onClick={onMenu} side="right" />
      <span className="min-w-0 flex-1 truncate px-1 text-[14px] font-semibold tracking-tight">{scopeTitle(inView, accounts)}</span>
      <FrameIconButton label="Search or jump to" shortcut="palette" icon={Search01Icon} onClick={onOpenPalette} />
      <Tooltip label="New message" shortcut="compose">
        <button
          aria-label="New message"
          onClick={onCompose}
          className="grid size-9 place-items-center rounded-full bg-frame-active text-frame-active-fg shadow-[0_8px_24px_-10px_rgb(10_30_60/0.45)] transition-opacity hover:opacity-90 touch:size-11"
        >
          <Icon icon={PencilEdit02Icon} size={16} />
        </button>
      </Tooltip>
    </header>
  );
}

/** What the switcher says: one account's name, "All accounts", two names, or a count. */
function scopeTitle(inView: Account[], all: Account[]) {
  if (!all.length) return "Kite";
  if (inView.length === 1) return accountName(inView[0]);
  if (inView.length === all.length) return "All accounts";
  return inView.length === 2 ? `${accountName(inView[0])} + ${accountName(inView[1])}` : `${inView.length} accounts`;
}

/** Shown before "Show all" when an account has many labels. */
const LABELS_SHOWN = 12;

/**
 * The user's own labels/folders, named the way each provider names them. Nested names are
 * indented under their parent; with several accounts in view, each account gets its own group.
 */
function LabelSection({ accounts, labels, view, onView }: { accounts: Account[]; labels: MailLabel[]; view: View; onView: (view: View) => void }) {
  const [expanded, setExpanded] = useState(false);
  const groups = accounts
    .map((account) => ({ account, spec: accountSpec(account), labels: labels.filter((l) => l.accountId === account.id) }))
    .filter((g) => g.labels.length);
  if (!groups.length) return null;
  const nouns = new Set(groups.map((g) => g.spec.organise.plural));
  const noun = nouns.size === 1 ? [...nouns][0] : "labels & folders";
  const title = noun.charAt(0).toUpperCase() + noun.slice(1);
  const total = groups.reduce((n, g) => n + g.labels.length, 0);
  let shown = 0;
  return (
    <Section
      id="labels"
      title={title}
      action={
        <Tooltip label={`Make, rename or delete ${noun}`} side="right">
          <button
            aria-label={`Manage ${noun}`}
            onClick={() => onView({ kind: "settings", section: "labels" })}
            className="grid size-6 place-items-center rounded-md text-frame-muted opacity-0 transition-opacity hover:bg-frame-hover hover:text-frame-fg focus-visible:opacity-100 group-hover/section:opacity-100 touch:opacity-100"
          >
            <Icon icon={Settings02Icon} size={13} />
          </button>
        </Tooltip>
      }
    >
      {groups.map(({ account, spec, labels: own }) => {
        const sorted = sortLabels(own, spec).filter(() => expanded || shown++ < LABELS_SHOWN);
        if (!sorted.length) return null;
        return (
          <div key={account.id} className="flex flex-col gap-px">
            {groups.length > 1 ? (
              <div className="flex items-center gap-1.5 truncate px-2.5 pb-0.5 pt-1.5 text-[11px] text-frame-muted">
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: account.color }} />
                {accountName(account)}
              </div>
            ) : null}
            {sorted.map((label, i) => (
              <div key={label.id} className="blur-fade" style={{ "--i": i, paddingLeft: labelDepth(label, spec) * 14 } as React.CSSProperties}>
                <NavItem
                  icon={label.kind === "folder" ? Folder01Icon : Tag01Icon}
                  color={label.color ?? undefined}
                  label={leafName(label, spec)}
                  count={label.unread || undefined}
                  active={view.kind === "label" && view.accountId === account.id && view.labelId === label.id}
                  onClick={() => onView({ kind: "label", accountId: account.id, labelId: label.id })}
                />
              </div>
            ))}
          </div>
        );
      })}
      {total > LABELS_SHOWN ? (
        <button
          {...FLUID_ITEM}
          onClick={() => setExpanded((v) => !v)}
          className="relative h-8 rounded-lg px-2.5 text-left text-[12.5px] text-frame-muted transition-colors duration-150 data-[lit]:text-frame-fg"
        >
          {expanded ? "Show fewer" : `Show all ${total}`}
        </button>
      ) : null}
    </Section>
  );
}

type SpaceEdit = { kind: "new"; parentId: string | null } | { kind: "rename"; id: string } | null;

/**
 * SPACES: Kite's own places for mail, across accounts, with pockets inside them. Drop conversations
 * on one to add them (Shift: move), right-click for New pocket, Rename, Colour and Delete.
 */
function SpaceSection(props: Props) {
  const rail = useContext(RailContext);
  const [edit, setEdit] = useState<SpaceEdit>(null);
  const [menu, setMenu] = useState<{ at: MenuPoint; space: Space } | null>(null);
  const tree = spaceTree(props.spaces);
  if (rail && !tree.length) return null;
  const top = tree.filter((t) => t.depth === 0).map((t) => t.space);
  const commit = async (name: string | null) => {
    const current = edit;
    setEdit(null);
    if (!name?.trim() || !current) return;
    if (current.kind === "new") {
      const made = await props.onCreateSpace(name.trim(), current.parentId);
      if (made) props.onView({ kind: "space", spaceId: made.id });
    } else props.onUpdateSpace(current.id, { name: name.trim() });
  };
  const items = (space: Space): MenuItem[] => {
    const depth = tree.find((t) => t.space.id === space.id)?.depth ?? 0;
    return [
      { id: "open", label: "Open", icon: ArrowRight01Icon, onSelect: () => props.onView({ kind: "space", spaceId: space.id }) },
      ...(depth < 3 ? [{ id: "pocket", label: "New pocket inside", icon: Add01Icon, onSelect: () => setEdit({ kind: "new", parentId: space.id }) }] : []),
      { id: "rename", label: "Rename", icon: PencilEdit02Icon, onSelect: () => setEdit({ kind: "rename", id: space.id }) },
      {
        id: "colour",
        label: "Colour",
        icon: Folder02Icon,
        submenu: SPACE_COLORS.map((color) => ({
          id: color,
          label: color === space.color ? "This one" : "Use this colour",
          leading: <span className="size-3 shrink-0 rounded-full" style={{ background: color }} />,
          checked: color === space.color,
          onSelect: () => props.onUpdateSpace(space.id, { color }),
        })),
      },
      ...(space.parentId ? [{ id: "lift", label: "Make it a space of its own", icon: ArrowRight01Icon, onSelect: () => props.onUpdateSpace(space.id, { parentId: null }) }] : []),
      { id: "delete", label: "Delete", icon: Delete02Icon, danger: true, section: true, onSelect: () => props.onDeleteSpace(space.id) },
    ];
  };
  return (
    <Section
      id="spaces"
      title="Spaces"
      action={
        <Tooltip label="New space" side="right">
          <button
            aria-label="New space"
            onClick={() => setEdit({ kind: "new", parentId: null })}
            className="grid size-6 place-items-center rounded-md text-frame-muted opacity-0 transition-opacity hover:bg-frame-hover hover:text-frame-fg focus-visible:opacity-100 group-hover/section:opacity-100 touch:opacity-100"
          >
            <Icon icon={Add01Icon} size={13} />
          </button>
        </Tooltip>
      }
    >
      {top.map((space) => (
        <SpaceRow key={space.id} space={space} depth={0} all={props.spaces} props={props} edit={edit} onCommit={commit} onMenu={(at, s) => setMenu({ at, space: s })} />
      ))}
      {edit?.kind === "new" && !edit.parentId ? <SpaceInput depth={0} onDone={commit} /> : null}
      {!tree.length && edit?.kind !== "new" && !rail ? (
        <button
          {...FLUID_ITEM}
          onClick={() => setEdit({ kind: "new", parentId: null })}
          className="relative flex h-9 items-center gap-3 rounded-[10px] px-2.5 text-left text-[13px] text-frame-fg/50 transition-colors duration-150 data-[lit]:text-frame-fg touch:h-11"
        >
          <Icon icon={Add01Icon} size={18} className="shrink-0" />
          <span className="truncate">Make a space, like a client</span>
        </button>
      ) : null}
      <ContextMenu at={menu?.at ?? null} items={menu ? items(menu.space) : []} label={menu?.space.name} onClose={() => setMenu(null)} />
    </Section>
  );
}

function SpaceRow({
  space,
  depth,
  all,
  props,
  edit,
  onCommit,
  onMenu,
}: {
  space: Space;
  depth: number;
  all: Space[];
  props: Props;
  edit: SpaceEdit;
  onCommit: (name: string | null) => void;
  onMenu: (at: MenuPoint, space: Space) => void;
}) {
  const rail = useContext(RailContext);
  const [collapsed, toggle] = useCollapsed(`space:${space.id}`);
  const [over, setOver] = useState(false);
  const pockets = all.filter((s) => s.parentId === space.id).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const active = props.view.kind === "space" && props.view.spaceId === space.id;
  const making = edit?.kind === "new" && edit.parentId === space.id;
  const open = !collapsed || making;
  if (edit?.kind === "rename" && edit.id === space.id && !rail) return <SpaceInput depth={depth} initial={space.name} onDone={onCommit} />;
  return (
    <>
      <div
        className={cn("group/space relative rounded-[10px] transition-shadow duration-150", over && "shadow-[inset_0_0_0_1.5px_var(--color-lime)]")}
        style={rail ? undefined : { paddingLeft: depth * 14 }}
        onContextMenu={(e) => {
          e.preventDefault();
          onMenu({ x: e.clientX, y: e.clientY }, space);
        }}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes(THREAD_DRAG)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = e.shiftKey ? "move" : "copy";
          if (!over) setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false);
          const raw = e.dataTransfer.getData(THREAD_DRAG);
          if (!raw) return;
          e.preventDefault();
          try {
            props.onDropOnSpace(space.id, JSON.parse(raw) as string[], e.shiftKey);
          } catch {
            // Not a list of conversations.
          }
        }}
      >
        <NavItem
          icon={Folder02Icon}
          leading={
            <span className="grid size-[18px] shrink-0 place-items-center">
              <SpaceDot space={space} className="size-2.5" />
            </span>
          }
          label={space.name}
          count={space.threads || undefined}
          active={active}
          onClick={() => props.onView({ kind: "space", spaceId: space.id })}
        />
        {pockets.length && !rail ? (
          <button
            {...FLUID_IGNORE}
            aria-label={open ? `Fold ${space.name}` : `Show the pockets in ${space.name}`}
            aria-expanded={open}
            onClick={toggle}
            className="absolute right-1.5 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded-md text-frame-muted opacity-0 transition-opacity hover:bg-white/10 hover:text-frame-fg group-hover/space:opacity-100 touch:opacity-100"
          >
            <Icon icon={ArrowDown01Icon} size={12} className={cn("transition-transform", !open && "-rotate-90")} />
          </button>
        ) : null}
      </div>
      {open && !rail
        ? pockets.map((pocket) => <SpaceRow key={pocket.id} space={pocket} depth={depth + 1} all={all} props={props} edit={edit} onCommit={onCommit} onMenu={onMenu} />)
        : null}
      {making && !rail ? <SpaceInput depth={depth + 1} onDone={onCommit} /> : null}
    </>
  );
}

/** Naming a space or pocket in place: Enter keeps it, Escape lets it go. */
function SpaceInput({ depth, initial = "", onDone }: { depth: number; initial?: string; onDone: (name: string | null) => void }) {
  const [name, setName] = useState(initial);
  return (
    <div className="flex h-9 items-center gap-3 rounded-[10px] bg-white/[0.06] px-2.5 touch:h-11" style={{ marginLeft: depth * 14 }}>
      <span className="grid size-[18px] shrink-0 place-items-center">
        <span className="size-2.5 rounded-full border-2 border-frame-fg/40" />
      </span>
      <input
        autoFocus
        value={name}
        maxLength={80}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={() => onDone(name.trim() && name.trim() !== initial ? name : null)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onDone(name);
          if (e.key === "Escape") onDone(null);
        }}
        placeholder={depth ? "Pocket name" : "Space name"}
        aria-label={depth ? "New pocket's name" : "New space's name"}
        className="min-w-0 flex-1 bg-transparent text-[14px] text-frame-fg outline-none placeholder:text-frame-fg/40"
      />
    </div>
  );
}
