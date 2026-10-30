"use client";

import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { formatAmount } from "@/lib/automations/values";
import { ALL_ACCOUNTS, scopeIds, singleAccount, type AccountScope } from "@/lib/mail/scope";
import { AnimatePresence, motion } from "motion/react";
import {
  Archive02Icon,
  Attachment01Icon,
  Calendar03Icon,
  Cancel01Icon,
  Clock01Icon,
  FilterHorizontalIcon,
  PencilEdit02Icon,
  RefreshIcon,
  Search01Icon,
  StarIcon,
  Tick02Icon,
  UserBlock01Icon,
  AlarmClockIcon,
  TimeScheduleIcon,
  Bookmark02Icon,
  BookmarkCheck01Icon,
  PinIcon,
  NotificationOff02Icon,
  Notification02Icon,
  Note01Icon,
  TickDouble02Icon,
  CrownIcon,
  Delete02Icon,
  Mail01Icon,
  MailOpen01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { THREAD_DRAG, spaceLabel, spacePeople, type Space } from "@/lib/spaces";
import { threadFiles } from "@/lib/mail/attachments";
import { SpaceTabs, useSpaceTab } from "./space-tabs";
import dynamic from "next/dynamic";
import { SpaceDot } from "./space-picker";
import { setThreadDragImage } from "./drag-image";
import { SpaceHeader, type SpaceHeaderActions } from "./space-header";
import type { SwipeAction, SwipePrefs, SwipeTone } from "@/lib/swipe";
import { useListGestures, type RowSwipe, type RowSwipes } from "./list-gestures";
import { threadHasInvite } from "@/lib/calendar/invite";
import { differenceInCalendarDays, format } from "date-fns";
import { accountName, type Account, type Mailbox, type Thread } from "@/lib/mail/types";
import { lastMessageDate, type View } from "@/lib/mail/store";
import type { ShortcutAction } from "@/lib/shortcuts";
import { cn, formatListDate } from "@/lib/utils";
import { exitFor, spring } from "@/lib/motion";
import { Icon, type IconData } from "../icon";
import { Avatar } from "./avatar";
import { FirstSyncState, SyncStrip, type FirstSync } from "./first-sync";
import { Tooltip } from "../ui/tooltip";
import { InboxTabs } from "./inbox-tabs";
import type { InboxSide, InboxTab } from "@/lib/mail/sides";
import { CircleButton } from "./circle-button";
import { BulkBar, type BulkAction } from "./bulk-panel";
import { ContactHints, SearchHints } from "./search-hints";
import { contactToken } from "@/lib/mail/search";
import type { Recipient } from "@/lib/mail/compose";
import type { SavedSearch } from "@/lib/settings";
import { GoogleLogo, MicrosoftLogo } from "../brand-logos";
import { messagePreview } from "@/lib/mail/quotes";
import { accountSpec, type MailLabel } from "@/lib/mail/providers";
import type { Provider } from "@/lib/mail/types";
import { LabelChip, type LabelLookup } from "./labels";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { BUTTON_ICONS } from "./button-icons";
import type { HoverAction } from "@/lib/buttons";
import { stableHandlers } from "../ui/stable";
import { Spinner } from "../ui/spinner";
import { AccentTitle } from "../ui/accent-title";
import { MailboxSwitcher } from "./mailbox-switcher";
/** "Search older mail" at the provider(s) for the current query. */
export type RemoteSearch = { query: string; status: "loading" | "done" | "error"; found: number };

// A space's Files and People tabs load when one is first opened.
const SpaceFiles = dynamic(() => import("./space-contents").then((m) => m.SpaceFiles), { ssr: false });
const SpacePeople = dynamic(() => import("./space-contents").then((m) => m.SpacePeople), { ssr: false });

const VIEW_TITLES: Record<string, string> = {
  inbox: "Inbox",
  screener: "Screener",
  snoozed: "Snoozed",
  scheduled: "Scheduled",
  starred: "Starred",
  sent: "Sent",
  drafts: "Drafts",
  archive: "All mail",
  trash: "Trash",
};

type Props = {
  view: View;
  /** Kite's spaces (lib/spaces.ts): chips on rows, and the space view's header. */
  spaces: Space[];
  /** Right-click on a row, the Menu key or its More button: the actions menu at a point. */
  onRowMenu: (id: string, at: { x: number; y: number }) => void;
  onOpenSpace: (id: string) => void;
  /** The space view's header: pockets, note, rename. */
  spaceActions: SpaceHeaderActions;
  threads: Thread[];
  accounts: Account[];
  accountId: AccountScope;
  /** The provider's inbox tabs in view; one tab (no tabs at the provider) shows none. */
  tabs: InboxTab[];
  side: InboxSide;
  sideCounts: Record<InboxSide, number>;
  query: string;
  selectedId: string | null;
  onQuery: (q: string) => void;
  onSide: (side: InboxSide) => void;
  onSelect: (id: string) => void;
  onArchive: (id: string) => void;
  onStar: (id: string) => void;
  onSnooze: (id: string) => void;
  onAllow: (id: string) => void;
  onBlock: (id: string) => void;
  onPin: (id: string) => void;
  onMute: (id: string) => void;
  onToggleRead: (id: string) => void;
  onTrash: (id: string) => void;
  onEmptyTrash?: () => void;
  /** What swiping a row does, per direction (Settings → Buttons). */
  swipe: SwipePrefs;
  /** The hover row's buttons, before More (Settings → Buttons). */
  hover: HoverAction[];
  /** Marks every unread conversation in the current inbox tab read. */
  onMarkAllRead: () => void;
  onCompose: () => void;
  /** Resolves once new mail is checked and the list read again (pull to refresh holds open until then). */
  onRefresh: () => Promise<void> | void;
  /** The title as a switcher between mailboxes, saved searches and labels. */
  switcher?: {
    counts: Partial<Record<Mailbox, number>>;
    screener: boolean;
    labels: MailLabel[];
    onView: (view: View) => void;
    onSearch: (query: string) => void;
  };
  /** Refresh is checking for new mail now, or just finished (button, shortcut or pull). */
  checking: "busy" | "done" | null;
  /** Bulk select: ticked threads (separate from the open one). */
  checked: Set<string>;
  onCheck: (id: string, mode: "toggle" | "range") => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onBulk: (action: BulkAction) => void;
  savedSearches: SavedSearch[];
  onSaveSearch: () => void;
  onRemoveSearch: (id: string) => void;
  /** Live accounts only. */
  onSearchRemote?: () => void;
  onLoadMore?: () => void;
  paging?: boolean;
  remoteSearch: RemoteSearch | null;
  /** Providers of the accounts in view (their logos on "Search older mail in …"). */
  searchProviders: Provider[];
  /** Their services for a sentence: "Gmail and iCloud Mail". */
  searchWhere: string;
  /** Changes when the list's scope changes, replaying the entrance animation. */
  listKey: string;
  /** Resolves a conversation's label ids to the account's labels/folders. */
  labelOf: LabelLookup;
  onOpenLabel: (accountId: string, id: string) => void;
  loading: boolean;
  /** Accounts in view still on their first sync (null when none). */
  firstSync: FirstSync | null;
  /** Lower-cased addresses of the user's VIPs. */
  vips: Set<string>;
  /** People for a `from:` / `to:` being typed in the search field. */
  searchContacts: (query: string, role: "from" | "to") => Promise<Recipient[]>;
};

/** Memoised with stable handlers: typing re-renders the header and the list, not every row. */
export const MessageList = stableHandlers(forwardRef<HTMLInputElement, Props>(function MessageList(props, searchRef) {
  const { view, threads, selectedId } = props;
  const isInbox = view.kind === "mailbox" && view.mailbox === "inbox";
  /** Everything else: one line per conversation (sender, subject, and the amount an automation collected). */
  const compact = isInbox && props.side !== "important" && !props.query.trim();
  const isScreener = view.kind === "mailbox" && view.mailbox === "screener";
  const account = props.accounts.find((a) => a.id === props.accountId);
  const isScheduled = view.kind === "mailbox" && view.mailbox === "scheduled";
  const title =
    view.kind === "cleanup"
        ? "Cleanup"
        : view.kind === "settings"
          ? "Settings"
        : view.kind === "files"
          ? "All files"
        : view.kind === "notes"
          ? "Notes"
        : view.kind === "calendar"
          ? "Calendar"
        : view.kind === "home"
          ? "Home"
        : view.kind === "contacts"
          ? "Contacts"
        : view.kind === "automations"
          ? "Automations"
        : view.kind === "label"
          ? (props.labelOf(view.accountId, view.labelId)?.name ?? "Label")
        : view.kind === "space"
          ? (props.spaces.find((s) => s.id === view.spaceId)?.name ?? "Space")
        : isInbox && account && props.accounts.length > 1
          ? accountName(account)
          : isInbox && props.accounts.length > 1
            ? props.accountId === ALL_ACCOUNTS
              ? "All inboxes"
              : `${scopeIds(props.accountId)!.length} inboxes`
            : VIEW_TITLES[view.mailbox];
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [focused, setFocused] = useState(false);
  const query = props.query.trim();

  // `from:` / `to:` autocomplete: the term at the caret, people for it (looked up once typing
  // pauses), the highlighted one, and a term the user closed with Escape.
  const [caret, setCaret] = useState<number | null>(null);
  const token = focused ? contactToken(props.query, Math.min(caret ?? props.query.length, props.query.length)) : null;
  const tokenKey = token ? `${token.start}:${token.role}:${token.value.toLowerCase()}` : "";
  const [found, setFound] = useState<{ key: string; people: Recipient[] } | null>(null);
  const [activeFor, setActiveFor] = useState({ key: "", index: 0 });
  const [dismissed, setDismissed] = useState("");
  const people = found && found.key === tokenKey ? found.people : null;
  const active = activeFor.key === tokenKey ? Math.min(activeFor.index, Math.max(0, (people?.length ?? 1) - 1)) : 0;
  const suggesting = !!token && dismissed !== tokenKey;
  const { searchContacts } = props;
  useEffect(() => {
    if (!token?.value || dismissed === tokenKey) return;
    let live = true;
    const timer = setTimeout(() => {
      searchContacts(token.value, token.role)
        .then((list) => live && setFound({ key: tokenKey, people: list }))
        .catch(() => live && setFound({ key: tokenKey, people: [] }));
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The token's parts are in its key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenKey, dismissed, searchContacts]);
  /** Writes the picked address into the term, then a space, with the caret after it. */
  const pickPerson = (person: Recipient) => {
    if (!token) return;
    const rest = props.query.slice(token.end).replace(/^\s+/, "");
    const next = `${props.query.slice(0, token.start)}${person.email} ${rest}`;
    const at = token.start + person.email.length + 1;
    props.onQuery(next);
    setCaret(at);
    requestAnimationFrame(() => inputRef.current?.setSelectionRange(at, at));
  };
  // A space view: Conversations, or the files and people in them (worked out from the same list).
  const spaceId = view.kind === "space" ? view.spaceId : null;
  const [spaceTab, setSpaceTab] = useSpaceTab(spaceId);
  const tabbed = !!spaceId && !query && !props.checked.size;
  const shownTab = tabbed ? spaceTab : "conversations";
  const { accounts, onSelect } = props;
  const spaceFiles = useMemo(() => (spaceId ? threadFiles(threads) : []), [spaceId, threads]);
  const spaceFolks = useMemo(() => (spaceId ? spacePeople(threads, new Set(accounts.map((a) => a.email.toLowerCase()))) : []), [spaceId, threads, accounts]);
  const spaceCounts = useMemo(() => ({ conversations: threads.length, files: spaceFiles.length, people: spaceFolks.length }), [threads.length, spaceFiles.length, spaceFolks.length]);
  const openFromTab = useCallback(
    (threadId: string) => {
      setSpaceTab("conversations");
      onSelect(threadId);
    },
    [setSpaceTab, onSelect],
  );
  const savedCurrent = !!query && props.savedSearches.some((s) => s.query === query);
  const remote = props.remoteSearch?.query === query ? props.remoteSearch : null;

  // Rows are memoised: they get one stable set of handlers that call the latest props.
  const latest = useRef(props);
  useLayoutEffect(() => {
    latest.current = props;
  });
  const rowActions = useMemo<RowActions>(
    () => ({
      select: (id) => latest.current.onSelect(id),
      check: (id, mode) => latest.current.onCheck(id, mode),
      archive: (id) => latest.current.onArchive(id),
      trash: (id) => latest.current.onTrash(id),
      toggleRead: (id) => latest.current.onToggleRead(id),
      star: (id) => latest.current.onStar(id),
      snooze: (id) => latest.current.onSnooze(id),
      allow: (id) => latest.current.onAllow(id),
      block: (id) => latest.current.onBlock(id),
      pin: (id) => latest.current.onPin(id),
      mute: (id) => latest.current.onMute(id),
      openLabel: (accountId, id) => latest.current.onOpenLabel(accountId, id),
      openSpace: (id) => latest.current.onOpenSpace(id),
      menu: (id, at) => latest.current.onRowMenu(id, at),
      // Dragging a ticked row takes every ticked one with it.
      dragged: (id) => (latest.current.checked.has(id) ? [...latest.current.checked] : [id]),
    }),
    [],
  );

  // Touch: swipe a row for the actions set in Settings (the Screener's are Allow and Block), pull down to refresh.
  const swipesFor = useCallback((id: string): RowSwipes | null => {
    const p = latest.current;
    const thread = p.threads.find((t) => t.id === id);
    if (!thread || thread.scheduled) return null;
    if (p.view.kind === "mailbox" && p.view.mailbox === "screener") {
      return {
        right: { label: "Allow", icon: Tick02Icon, tone: "success", run: () => p.onAllow(id) },
        left: { label: "Block", icon: UserBlock01Icon, tone: "danger", run: () => p.onBlock(id) },
      };
    }
    const side = (action: SwipeAction): RowSwipe | undefined => {
      const make = (label: string, icon: IconData, tone: SwipeTone, run: (id: string) => void): RowSwipe => ({ label, icon, tone, run: () => run(id) });
      switch (action) {
        case "archive":
          // Out of the Inbox: elsewhere there's nothing to archive.
          return thread.mailbox === "inbox" ? make("Archive", Archive02Icon, "success", p.onArchive) : undefined;
        case "trash":
          return thread.mailbox === "trash" ? undefined : make("Delete", Delete02Icon, "danger", p.onTrash);
        case "snooze":
          return make("Snooze", Clock01Icon, "warning", p.onSnooze);
        case "read":
          return thread.unread ? make("Read", MailOpen01Icon, "accent", p.onToggleRead) : make("Unread", Mail01Icon, "accent", p.onToggleRead);
        case "star":
          return make(thread.starred ? "Unstar" : "Star", StarIcon, "warning", p.onStar);
        case "pin":
          return make(thread.pinned ? "Unpin" : "Pin", PinIcon, "accent", p.onPin);
        case "mute":
          return make(thread.muted ? "Unmute" : "Mute", thread.muted ? Notification02Icon : NotificationOff02Icon, "accent", p.onMute);
        case "none":
          return undefined;
      }
    };
    const swipes = { right: side(p.swipe.right), left: side(p.swipe.left) };
    return swipes.right || swipes.left ? swipes : null;
  }, []);
  const pullable = view.kind === "mailbox" || view.kind === "label" || view.kind === "space";
  const { scroller: listRef, backdrop: backdropRef, indicator: pullRef, shown: swipeShown, refreshing, refresh } = useListGestures({
    bindKey: props.listKey,
    swipesFor,
    onRefresh: pullable ? props.onRefresh : null,
  });

  // Rows fully in view, tracked by an observer: scrolling to the selection only when it isn't
  // (scrollIntoView forces a layout on every j/k otherwise).
  const inView = useRef(new Set<string>());
  useEffect(() => {
    const scroller = listRef.current;
    if (!scroller) return;
    const seen = inView.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.thread;
          if (!id) continue;
          if (entry.intersectionRatio >= 0.99) seen.add(id);
          else seen.delete(id);
        }
      },
      { root: scroller, threshold: [0, 0.99] },
    );
    const rowsIn = (node: Node) =>
      node instanceof HTMLElement ? (node.dataset.thread ? [node] : [...node.querySelectorAll<HTMLElement>("[data-thread]")]) : [];
    rowsIn(scroller).forEach((row) => observer.observe(row));
    // Only rows arriving or leaving: changes inside a row (hover actions, the unread dot) are ignored.
    const rows = new MutationObserver((records) => {
      for (const record of records) {
        record.addedNodes.forEach((node) => rowsIn(node).forEach((row) => observer.observe(row)));
        record.removedNodes.forEach((node) =>
          rowsIn(node).forEach((row) => {
            observer.unobserve(row);
            seen.delete(row.dataset.thread!);
          }),
        );
      }
    });
    rows.observe(scroller, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      rows.disconnect();
      seen.clear();
    };
  }, [props.listKey, listRef]);

  // Only when the selection moves: not again when the list is shown after another screen.
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId === scrolledTo.current) return;
    scrolledTo.current = selectedId;
    if (!selectedId || inView.current.has(selectedId)) return;
    listRef.current?.querySelector(`[data-thread="${selectedId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selectedId, listRef]);

  return (
    <section className="flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      <header className="flex flex-col gap-3 px-3.5 pt-3">
        <div className="flex items-center gap-2 pl-1">
          {props.switcher && (view.kind === "mailbox" || view.kind === "label" || view.kind === "space") ? (
            <MailboxSwitcher
              title={title}
              view={view}
              counts={props.switcher.counts}
              screener={props.switcher.screener}
              accounts={props.accounts}
              labels={props.switcher.labels}
              spaces={props.spaces}
              savedSearches={props.savedSearches}
              activeQuery={props.query.trim()}
              onView={props.switcher.onView}
              onSearch={props.switcher.onSearch}
              onRemoveSearch={props.onRemoveSearch}
            />
          ) : (
            <h1 className="flex-1 truncate text-[20px] font-medium tracking-[-0.035em]"><AccentTitle text={title} /></h1>
          )}
          <CircleButton
            icon={RefreshIcon}
            label={props.checking === "busy" ? "Checking for new mail" : props.checking === "done" ? "Up to date" : "Refresh"}
            shortcut="refresh"
            status={props.checking}
            onClick={() => void (pullable ? refresh() : props.onRefresh())}
          />
          <CircleButton icon={FilterHorizontalIcon} label="Search filters" active={focused && !props.query} onClick={() => inputRef.current?.focus()} />
          <CircleButton icon={PencilEdit02Icon} label="New message" shortcut="compose" onClick={props.onCompose} />
        </div>

        <div className="relative">
        <label className="flex h-10 items-center gap-2 rounded-full border border-pane-border bg-pane px-3.5 text-[13.5px] transition-colors focus-within:border-accent/60">
          <Icon icon={Search01Icon} size={16} className="text-pane-muted" />
          <input
            ref={(node) => {
              inputRef.current = node;
              if (typeof searchRef === "function") searchRef(node);
              else if (searchRef) searchRef.current = node;
            }}
            value={props.query}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onChange={(e) => {
              setCaret(e.target.selectionStart);
              props.onQuery(e.target.value);
            }}
            onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
            onKeyDown={(e) => {
              if (suggesting && people?.length) {
                if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                  e.preventDefault();
                  const step = e.key === "ArrowDown" ? 1 : -1;
                  setActiveFor({ key: tokenKey, index: (active + step + people.length) % people.length });
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pickPerson(people[active]);
                  return;
                }
              }
              if (e.key === "Escape") {
                // First Escape closes the suggestions, the next clears the search.
                if (suggesting) return setDismissed(tokenKey);
                props.onQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Search"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
          />
          {props.query ? (
            <>
              {query ? (
                <Tooltip label={savedCurrent ? "Saved. Click to remove" : "Save this search"}>
                  <button
                    aria-label={savedCurrent ? "Remove saved search" : "Save this search"}
                    onClick={savedCurrent ? () => props.onRemoveSearch(props.savedSearches.find((s) => s.query === query)!.id) : props.onSaveSearch}
                    className={cn("hover:text-pane-fg", savedCurrent ? "text-accent" : "text-pane-muted")}
                  >
                    <Icon icon={savedCurrent ? BookmarkCheck01Icon : Bookmark02Icon} size={15} />
                  </button>
                </Tooltip>
              ) : null}
              <Tooltip label="Clear search">
                <button aria-label="Clear search" onClick={() => props.onQuery("")} className="text-pane-muted hover:text-pane-fg">
                  <Icon icon={Cancel01Icon} size={14} />
                </button>
              </Tooltip>
            </>
          ) : (
            <kbd className="tabular-nums text-[11px] text-pane-muted">/</kbd>
          )}
        </label>
        {suggesting && token ? (
          <ContactHints token={token} people={people} active={active} onHover={(index) => setActiveFor({ key: tokenKey, index })} onPick={pickPerson} />
        ) : focused && !props.query ? (
          <SearchHints
            saved={props.savedSearches}
            onPick={(q) => props.onQuery(q)}
            onInsert={(text) => props.onQuery(text)}
            onRemove={props.onRemoveSearch}
          />
        ) : null}
        </div>

        {props.view.kind === "mailbox" && props.view.mailbox === "trash" && !props.checked.size ? (
          <div className="flex items-center gap-3 pb-2 text-xs text-pane-muted">
            {/* One line, never wrapped: short enough for a narrow list, and cut with the full sentence on hover. */}
            <p className="min-w-0 flex-1 truncate" title="Your mail service decides how long deleted mail stays here.">Your mail service decides when it’s emptied.</p>
            <button onClick={props.onEmptyTrash} className="shrink-0 rounded-full border border-pane-border px-3 py-1.5 text-pane-fg">Empty Trash…</button>
          </div>
        ) : null}
        {props.checked.size ? (
          <BulkBar
            threads={threads.filter((t) => props.checked.has(t.id))}
            total={threads.length}
            onAction={props.onBulk}
            onSelectAll={props.onSelectAll}
            onClear={props.onClearSelection}
          />
        ) : isInbox && !props.query ? (
          <div className="flex items-center gap-1.5 pb-1">
            <div className="min-w-0 flex-1">
              <InboxTabs tabs={props.tabs} value={props.side} counts={props.sideCounts} onChange={props.onSide} />
            </div>
            {props.sideCounts[props.side] ? (
              <CircleButton
                icon={TickDouble02Icon}
                label={`Mark all read in ${props.tabs.find((s) => s.id === props.side)?.label ?? "this tab"}`}
                onClick={props.onMarkAllRead}
                className="blur-fade size-[38px]"
              />
            ) : null}
          </div>
        ) : view.kind === "space" && !props.query ? (
          <SpaceHeader
            spaceId={view.spaceId}
            spaces={props.spaces}
            count={threads.length}
            tabs={tabbed ? <SpaceTabs value={spaceTab} counts={spaceCounts} onChange={setSpaceTab} /> : undefined}
            actions={props.spaceActions}
          />
        ) : (
          <p className="px-1 pb-1 text-[12px] text-pane-muted">
            {isScreener
              ? "People emailing you for the first time wait here. Allow them in or block them for good."
              : isScheduled
                ? "Waiting to send. Kite sends them while it's running."
              : view.kind === "label" && !props.query
                ? `${threads.length} ${threads.length === 1 ? "conversation" : "conversations"}${props.accounts.length > 1 ? ` in ${(() => {
                    const owner = props.accounts.find((a) => a.id === view.accountId);
                    return owner ? accountName(owner) : "this account";
                  })()}` : ""}`
                : view.kind === "cleanup" || view.kind === "settings"
                  ? ""
                : props.query
                  ? `${threads.length} results for “${props.query}”`
                  : `${threads.length} conversations`}
          </p>
        )}
      </header>

      <AnimatePresence initial={false}>
        {props.firstSync && threads.length > 0 ? <SyncStrip progress={props.firstSync} /> : null}
      </AnimatePresence>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        ref={pullRef}
        aria-hidden
        style={{ opacity: 0 }}
        className="group/pull pointer-events-none absolute -top-10 left-1/2 z-10 grid size-9 -translate-x-1/2 place-items-center rounded-full border border-pane-border bg-pane text-pane-muted shadow-sm data-[armed]:text-accent"
      >
        {refreshing ? (
          <Spinner size={16} className="text-accent" />
        ) : (
          <Icon icon={RefreshIcon} size={16} className="[rotate:calc(var(--pull,0)*270deg)]" />
        )}
      </div>
      {refreshing ? <span role="status" className="sr-only">Checking for new mail</span> : null}
      <div
        ref={listRef}
        key={props.listKey}
        className="scroll-fade min-h-0 flex-1 touch-pan-y overflow-y-auto overflow-x-hidden overscroll-none px-2 pb-2 pt-1"
      >
        {shownTab === "files" ? (
          <SpaceFiles files={spaceFiles} onOpenConversation={openFromTab} />
        ) : shownTab === "people" ? (
          <SpacePeople people={spaceFolks} vips={props.vips} onOpenPerson={props.spaceActions.openPerson} />
        ) : threads.length === 0 && props.firstSync && !props.query ? (
          <FirstSyncState progress={props.firstSync} />
        ) : threads.length === 0 && props.loading ? (
          <ListSkeleton />
        ) : threads.length === 0 && !props.query ? (
          <EmptyList isInbox={isInbox} screener={isScreener} space={view.kind === "space"} />
        ) : (
          <FluidList tone="pane" glide>
          <SwipeBackdrop ref={backdropRef} shown={swipeShown} />
          {threads.map((thread, index) => (
            <ThreadRow
              key={thread.id}
              index={index}
              thread={thread}
              account={props.accounts.find((a) => a.id === thread.accountId)}
              showAccount={!singleAccount(props.accountId, props.accounts)}
              selected={thread.id === selectedId}
              checked={props.checked.has(thread.id)}
              joinAbove={index > 0 && props.checked.has(thread.id) && props.checked.has(threads[index - 1].id)}
              joinBelow={index < threads.length - 1 && props.checked.has(thread.id) && props.checked.has(threads[index + 1].id)}
              selecting={props.checked.size > 0}
              screener={isScreener}
              actions={rowActions}
              labelOf={props.labelOf}
              hideLabel={view.kind === "label" ? view.labelId : null}
              spaces={props.spaces}
              hideSpace={view.kind === "space" ? view.spaceId : null}
              vips={props.vips}
              compact={compact}
              hover={props.hover}
            />
          ))}
          </FluidList>
        )}
        {query && !props.loading ? (
          <>{props.onLoadMore ? <button disabled={props.paging} onClick={props.onLoadMore} className="m-3 rounded-full border border-pane-border px-4 py-2 text-sm text-accent">{props.paging ? "Loading..." : "Load more results"}</button> : null}<SearchFooter empty={threads.length === 0} syncing={!!props.firstSync} remote={remote} providers={props.searchProviders} where={props.searchWhere} onSearchRemote={props.onSearchRemote} /></>
        ) : null}
      </div>
      </div>
    </section>
  );
}));

const SWIPE_TONES: Record<SwipeTone, string> = {
  success: "data-[armed]:bg-success",
  warning: "data-[armed]:bg-warning",
  danger: "data-[armed]:bg-danger",
  accent: "data-[armed]:bg-accent",
};

/**
 * Behind the row being swiped (placed by useListGestures): the action's icon and word at the edge the row
 * leaves, faint until the swipe will go through, then filled in the action's colour.
 */
const SwipeBackdrop = forwardRef<HTMLDivElement, { shown: ReturnType<typeof useListGestures>["shown"] }>(function SwipeBackdrop({ shown }, ref) {
  const action = shown?.action;
  return (
    <div
      ref={ref}
      aria-hidden
      className={cn(
        "group/swipe pointer-events-none absolute hidden overflow-hidden rounded-xl bg-pane-hover text-pane-muted transition-[background-color,color] duration-150 data-[armed]:text-pane",
        action && SWIPE_TONES[action.tone],
      )}
    >
      {action ? (
        <span className={cn("flex h-full items-center gap-2 px-5 text-[13px] font-medium", shown.side === "right" ? "justify-start" : "flex-row-reverse justify-start")}>
          <Icon icon={action.icon} size={18} className="scale-90 transition-transform duration-150 group-data-[armed]/swipe:scale-110" />
          {action.label}
        </span>
      ) : null}
    </div>
  );
});

/** One handler set for every row (each takes the row's thread id), so rows can be memoised. */
type RowActions = {
  select: (id: string) => void;
  check: (id: string, mode: "toggle" | "range") => void;
  archive: (id: string) => void;
  trash: (id: string) => void;
  toggleRead: (id: string) => void;
  star: (id: string) => void;
  snooze: (id: string) => void;
  allow: (id: string) => void;
  block: (id: string) => void;
  pin: (id: string) => void;
  mute: (id: string) => void;
  openLabel: (accountId: string, id: string) => void;
  openSpace: (id: string) => void;
  menu: (id: string, at: { x: number; y: number }) => void;
  dragged: (id: string) => string[];
};

const ThreadRow = memo(function ThreadRow({
  index,
  thread,
  account,
  showAccount,
  selected,
  checked,
  joinAbove,
  joinBelow,
  selecting,
  screener,
  vips,
  actions: rowActions,
  labelOf,
  hideLabel,
  spaces,
  hideSpace,
  compact = false,
  hover,
}: {
  index: number;
  thread: Thread;
  account?: Account;
  showAccount: boolean;
  selected: boolean;
  checked: boolean;
  /** Ticked rows next to each other merge into one shape (square corners where they meet). */
  joinAbove: boolean;
  joinBelow: boolean;
  selecting: boolean;
  screener: boolean;
  actions: RowActions;
  labelOf: LabelLookup;
  /** The label being viewed: not repeated as a chip. */
  hideLabel: string | null;
  spaces: Space[];
  /** The space being viewed: not repeated as a chip. */
  hideSpace: string | null;
  vips: Set<string>;
  /** One line: who, what, and the amount an automation collected (the inbox's Everything else side). */
  compact?: boolean;
  hover: HoverAction[];
}) {
  const id = thread.id;
  // The hover actions mount only under the pointer: most rows never need them.
  // The hover actions mount on first hover, then show and hide with the lit row in CSS (no render per hover).
  const [armed, setArmed] = useState(false);
  const actions = {
    onSelect: () => rowActions.select(id),
    onCheck: (mode: "toggle" | "range") => rowActions.check(id, mode),
    onArchive: () => rowActions.archive(id),
    onTrash: () => rowActions.trash(id),
    onToggleRead: () => rowActions.toggleRead(id),
    onStar: () => rowActions.star(id),
    onSnooze: () => rowActions.snooze(id),
    onAllow: () => rowActions.allow(id),
    onBlock: () => rowActions.block(id),
    onPin: () => rowActions.pin(id),
    onMute: () => rowActions.mute(id),
    onOpenLabel: (labelId: string) => rowActions.openLabel(thread.accountId, labelId),
    labels: (thread.labels ?? []).filter((l) => l !== hideLabel).flatMap((l): MailLabel[] => {
      const label = labelOf(thread.accountId, l);
      return label ? [label] : [];
    }),
  };
  const last = thread.messages[thread.messages.length - 1];
  const spec = accountSpec(account);
  const sender =
    thread.messages.find((m) => m.from.name !== "You" && m.from.email !== account?.email)?.from ?? last.from;
  const hasAttachments = thread.messages.some((m) => m.attachments?.some((a) => !a.inline));
  const invite = threadHasInvite(thread);
  const count = thread.messages.length;
  const inSpaces = (thread.spaces ?? []).filter((s) => s !== hideSpace).flatMap((id) => spaces.find((s) => s.id === id) ?? []);

  return (
    <div
      data-thread={thread.id}
      {...FLUID_ITEM}
      aria-selected={checked}
      draggable={!thread.scheduled}
      onDragStart={(e) => {
        const ids = rowActions.dragged(id);
        e.dataTransfer.setData(THREAD_DRAG, JSON.stringify(ids));
        e.dataTransfer.setData("text/plain", ids.length > 1 ? `${ids.length} conversations` : thread.subject);
        e.dataTransfer.effectAllowed = "copyMove";
        setThreadDragImage(e, { sender: sender.name || sender.email, subject: thread.subject, ids });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        rowActions.menu(id, { x: e.clientX, y: e.clientY });
      }}
      onPointerEnter={armed ? undefined : () => setArmed(true)}
      // Shift-click picks a range, so it mustn't select text.
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.shiftKey) actions.onCheck("range");
        else if (e.ctrlKey || e.metaKey) actions.onCheck("toggle");
        else actions.onSelect();
      }}
      style={{ "--i": index } as React.CSSProperties}
      className={cn(
        // Only rows that can be on screen fade in (a blur on every row of a long list is expensive),
        // and the browser skips style, layout and paint for rows out of view.
        index < 16 && "blur-fade-up",
        "group relative flex cursor-default gap-3 rounded-xl px-3 transition-[background-color,border-radius] duration-150 [content-visibility:auto]",
        compact ? "items-center py-2 [contain-intrinsic-size:auto_44px]" : "py-2.5 [contain-intrinsic-size:auto_76px]",
        // Dividers step aside for the lit row (globals.css), like they do for selected rows.
        "after:absolute after:inset-x-3 after:bottom-0 after:border-b after:border-pane-border/80 last:after:hidden",
        // Hover is the FluidList's gliding highlight; rows only paint their own states.
        checked
          ? cn("bg-accent-soft after:hidden", joinAbove && "rounded-t-none", joinBelow && "rounded-b-none")
          : selected && !selecting
            ? "bg-pane-selected after:hidden"
            : selected
              ? "bg-pane-hover after:hidden"
              : "",
      )}
    >
      <div className={cn("relative", !compact && "pt-0.5")}>
        <Tooltip label={checked ? "Deselect" : "Select"} shortcut="select">
          <button
            role="checkbox"
            aria-checked={checked}
            aria-label={checked ? "Deselect" : "Select"}
            onMouseDown={(e) => {
              if (e.shiftKey) e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              actions.onCheck(e.shiftKey ? "range" : "toggle");
            }}
            className="group/check relative block size-7 rounded-full"
          >
            <span data-sensitive className="block">
              <Avatar
                name={sender.name}
                email={sender.email}
                className={cn("size-7 transition-opacity duration-150", compact && "rounded-[9px]", checked || selecting ? "opacity-0" : "group-hover/check:opacity-0")}
              />
            </span>
            <span
              className={cn(
                "absolute inset-0 grid place-items-center rounded-full border transition-[opacity,background-color,border-color] duration-150",
                checked ? "border-accent bg-accent text-accent-fg" : "border-pane-muted/60 bg-pane hover:border-accent",
                checked || selecting ? "opacity-100" : "opacity-0 group-hover/check:opacity-100",
              )}
            >
              {checked ? <Icon icon={Tick02Icon} size={15} strokeWidth={2.5} /> : null}
            </span>
          </button>
        </Tooltip>
      </div>

      {compact ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div data-sensitive className="min-w-0 flex-1 truncate text-[13px] text-pane-muted">
            <span className={cn("text-pane-fg", thread.unread ? "font-semibold" : "font-medium")}>{sender.name}</span>
            <span> · {thread.subject}</span>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 group-data-[lit]:invisible">
            {thread.amount ? (
              <span data-sensitive className="text-[13px] font-semibold tabular-nums text-pane-fg">
                {formatAmount(thread.amount.value, thread.amount.currency)}
              </span>
            ) : (
              <span className={cn("text-[12px] tabular-nums", thread.unread ? "font-medium text-accent" : "text-pane-muted")}>{formatListDate(lastMessageDate(thread))}</span>
            )}
            <UnreadDot unread={!!thread.unread} />
          </span>
        </div>
      ) : (
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span data-sensitive className={cn("truncate text-[13.5px]", thread.unread ? "font-semibold" : "font-medium")}>
            {sender.name}
          </span>
          {vips.has(sender.email.toLowerCase()) ? (
            <span role="img" aria-label="VIP" className="shrink-0 self-center text-pane-muted">
              <Icon icon={CrownIcon} size={12} />
            </span>
          ) : null}
          {count > 1 ? (
            <span className="rounded-full bg-pane-hover px-1.5 text-[10.5px] font-medium text-pane-muted">{count}</span>
          ) : null}
          {thread.pinned ? <Icon icon={PinIcon} size={12} className="shrink-0 self-center text-accent" /> : null}
          {thread.muted ? <Icon icon={NotificationOff02Icon} size={12} className="shrink-0 self-center text-pane-muted" /> : null}
          <span className="ml-auto flex shrink-0 items-center gap-1.5 self-center group-data-[lit]:invisible">
            <span className={cn("text-[12px] tabular-nums transition-colors duration-200", thread.unread ? "font-medium text-accent" : "text-pane-muted")}>
              {thread.scheduled ? format(new Date(thread.scheduled.sendAt), "EEE HH:mm") : formatListDate(lastMessageDate(thread))}
            </span>
            <UnreadDot unread={!!thread.unread} />
          </span>
        </div>
        <div data-sensitive className={cn("truncate text-[13px]", thread.unread ? "font-medium" : "text-pane-fg/85")}>
          {thread.subject}
        </div>
        <div data-sensitive className="truncate text-[12.5px] text-pane-muted">
          {messagePreview(last)}
        </div>

        {!screener && (hasAttachments || invite || thread.starred || showAccount || thread.reminder || thread.scheduled || thread.note || actions.labels.length || inSpaces.length) ? (
          <div className="mt-1 flex items-center gap-1.5 text-[11.5px] text-pane-muted">
            {thread.reminder ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-px text-[10.5px] font-medium text-warning">
                <Icon icon={AlarmClockIcon} size={11} strokeWidth={2} />
                No reply in {Math.max(1, differenceInCalendarDays(new Date(), new Date(thread.reminder.sentAt)))}d
              </span>
            ) : null}
            {thread.scheduled ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-1.5 py-px text-[10.5px] font-medium text-accent">
                <Icon icon={TimeScheduleIcon} size={11} strokeWidth={2} />
                {thread.scheduled.remindDays ? `Sends, then nudges in ${thread.scheduled.remindDays}d` : "Scheduled"}
              </span>
            ) : null}
            {showAccount && account ? <span className="truncate">{accountName(account)}</span> : null}
            {actions.labels.slice(0, 3).map((label) => (
              <LabelChip key={label.id} label={label} spec={spec} onClick={() => actions.onOpenLabel(label.id)} />
            ))}
            {actions.labels.length > 3 ? <span className="text-[10.5px]">+{actions.labels.length - 3}</span> : null}
            {inSpaces.slice(0, 2).map((space) => (
              <button
                key={space.id}
                title={`In ${spaceLabel(spaces, space.id)}`}
                onClick={(e) => {
                  e.stopPropagation();
                  rowActions.openSpace(space.id);
                }}
                className="inline-flex max-w-[140px] items-center gap-1 rounded-full border border-pane-border px-1.5 py-px text-[10.5px] font-medium text-pane-muted transition-colors hover:border-accent/50 hover:text-pane-fg"
              >
                <SpaceDot space={space} className="size-1.5" />
                <span className="truncate">{space.name}</span>
              </button>
            ))}
            {inSpaces.length > 2 ? <span className="text-[10.5px]">+{inSpaces.length - 2}</span> : null}
            {invite ? <Icon icon={Calendar03Icon} size={12} aria-label="Invite" /> : null}
            {hasAttachments ? <Icon icon={Attachment01Icon} size={12} /> : null}
            {thread.note ? <Icon icon={Note01Icon} size={12} className="text-warning" /> : null}
            {thread.starred ? <Icon icon={StarIcon} size={12} className="fill-warning text-warning" /> : null}
          </div>
        ) : null}

        {screener ? (
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={(e) => {
                e.stopPropagation();
                actions.onAllow();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-full bg-success/15 px-3 text-[12px] font-medium text-success hover:bg-success/25"
            >
              <Icon icon={Tick02Icon} size={13} /> Allow
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                actions.onBlock();
              }}
              className="inline-flex h-7 items-center gap-1 rounded-full border border-pane-border px-3 text-[12px] font-medium text-pane-muted hover:text-pane-fg"
            >
              <Icon icon={UserBlock01Icon} size={13} /> Block
            </button>
          </div>
        ) : null}
      </div>
      )}

      {armed && !screener && !thread.scheduled ? (
        <div className="invisible absolute right-2 top-1.5 group-data-[lit]:visible flex items-center gap-0.5 rounded-full border border-pane-border bg-pane p-0.5 shadow-sm">
          {hover.map((action) => {
            const button = hoverButton(action, thread, actions);
            return button ? (
              <RowAction key={action} label={button.label} shortcut={button.shortcut} onClick={button.run}>
                <Icon icon={button.icon} size={14} className={button.iconClassName} />
              </RowAction>
            ) : null;
          })}
          <Tooltip label="More" shortcut="actions">
            <button
              aria-label="More"
              aria-haspopup="menu"
              onClick={(e) => {
                e.stopPropagation();
                const box = e.currentTarget.getBoundingClientRect();
                rowActions.menu(id, { x: box.left, y: box.bottom + 4 });
              }}
              className="grid size-6 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={MoreHorizontalIcon} size={14} />
            </button>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
});

/** One hover-row button as it stands for this row; null where it doesn't apply (no Snooze in Trash). */
function hoverButton(
  action: HoverAction,
  thread: Thread,
  actions: { onArchive: () => void; onTrash: () => void; onSnooze: () => void; onToggleRead: () => void; onStar: () => void; onPin: () => void; onMute: () => void },
): { label: string; icon: IconData; shortcut: ShortcutAction; run: () => void; iconClassName?: string } | null {
  const trash = thread.mailbox === "trash";
  switch (action) {
    case "archive":
      return { label: trash ? "Move to inbox" : "Archive", icon: BUTTON_ICONS.archive, shortcut: "archive", run: actions.onArchive };
    case "trash":
      return { label: trash ? "Delete permanently…" : "Delete", icon: BUTTON_ICONS.trash, shortcut: "delete", run: actions.onTrash };
    case "snooze":
      return trash ? null : { label: "Snooze until tomorrow", icon: BUTTON_ICONS.snooze, shortcut: "snooze", run: actions.onSnooze };
    case "read":
      return { label: thread.unread ? "Mark as read" : "Mark as unread", icon: thread.unread ? MailOpen01Icon : Mail01Icon, shortcut: "toggleRead", run: actions.onToggleRead };
    case "star":
      return { label: thread.starred ? "Unstar" : "Star", icon: StarIcon, shortcut: "star", run: actions.onStar, iconClassName: cn(thread.starred && "fill-warning text-warning") };
    case "pin":
      return { label: thread.pinned ? "Unpin" : "Pin to the top", icon: PinIcon, shortcut: "pin", run: actions.onPin };
    case "mute":
      return { label: thread.muted ? "Unmute" : "Mute", icon: thread.muted ? Notification02Icon : NotificationOff02Icon, shortcut: "mute", run: actions.onMute };
  }
}

function RowAction({
  label,
  shortcut,
  onClick,
  children,
}: {
  label: string;
  shortcut: ShortcutAction;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className="grid size-6 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
      >
        {children}
      </button>
    </Tooltip>
  );
}

const PROVIDER_LOGOS: Partial<Record<Provider, React.ReactNode>> = {
  gmail: <GoogleLogo size={14} />,
  outlook: <MicrosoftLogo size={13} />,
};

/** Under search results: the local copy's limits, and the way to search all of the mailbox at the provider. */
function SearchFooter({
  empty,
  syncing,
  remote,
  providers,
  where,
  onSearchRemote,
}: {
  empty: boolean;
  /** The first sync is still running: older mail may not be on this device yet. */
  syncing: boolean;
  remote: RemoteSearch | null;
  providers: Provider[];
  where: string;
  onSearchRemote?: () => void;
}) {
  return (
    <div className="blur-fade flex flex-col items-center gap-2 px-6 py-6 text-center">
      {empty ? <p className="text-[13px] font-medium">Nothing in your mail on this device matches</p> : null}
      {syncing ? (
        <p className="flex items-center gap-1.5 text-[12px] text-pane-muted">
          <Spinner size={12} className="text-accent" />
          Your mail is still coming in, so some matches may not be here yet.
        </p>
      ) : null}
      {!onSearchRemote ? (
        empty ? <p className="text-[12px] text-pane-muted">Try fewer words, or take out a filter.</p> : null
      ) : remote?.status === "done" ? (
        <p className="text-[12px] text-pane-muted">
          {remote.found
            ? `${where} found ${remote.found} ${remote.found === 1 ? "conversation" : "conversations"} for this search. They're in the list now.`
            : `${where} has nothing more for this search.`}
        </p>
      ) : (
        <>
          {remote?.status === "error" ? <p className="text-[12px] text-pane-muted">{where} couldn&apos;t be reached. Check your connection and try again.</p> : null}
          <button
            onClick={onSearchRemote}
            disabled={remote?.status === "loading"}
            className="inline-flex h-8 items-center gap-2 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors hover:bg-pane-hover disabled:opacity-60"
          >
            {[...new Set(providers)].map((p) => (
              <span key={p} className="contents">
                {PROVIDER_LOGOS[p]}
              </span>
            ))}
            {remote?.status === "loading" ? `Searching ${where}…` : remote?.status === "error" ? "Try again" : `Search older mail in ${where}`}
          </button>
        </>
      )}
    </div>
  );
}

function EmptyList({ isInbox, screener, space }: { isInbox: boolean; screener?: boolean; space?: boolean }) {
  if (space) {
    return (
      <div className="grid h-full place-items-center p-8 text-center">
        <div className="max-w-[300px]">
          <p className="text-[13px] font-medium">Nothing in here yet</p>
          <p className="mt-1 text-[12px] text-pane-muted">
            Drag conversations onto this space in the sidebar, right-click one, or press Y on it. Pockets show their mail here too.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div>
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
          <Icon icon={Tick02Icon} size={20} />
        </div>
        <p className="text-[13px] font-medium">{isInbox ? "All caught up" : screener ? "No one new" : "Nothing here"}</p>
        <p className="mt-1 text-[12px] text-pane-muted">
          {isInbox
            ? "Nothing left in this tab."
            : screener
              ? "When someone emails you for the first time, you decide if they get in."
              : "No conversations match."}
        </p>
      </div>
    </div>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="blur-fade flex gap-3 px-3 py-3" style={{ "--i": i, "--blur-fade-step": "60ms" } as React.CSSProperties}>
          <div className="size-7 shrink-0 animate-pulse rounded-full bg-pane-hover" />
          <div className="flex-1 space-y-2 pt-0.5">
            <div className="h-3 w-1/3 animate-pulse rounded bg-pane-hover" />
            <div className="h-3 w-4/5 animate-pulse rounded bg-pane-hover" />
            <div className="h-3 w-3/5 animate-pulse rounded bg-pane-hover" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Unread: an accent dot with a soft halo beside the time. It pops in on a spring and fades out once read. */
function UnreadDot({ unread }: { unread: boolean }) {
  return (
    <AnimatePresence initial={false}>
      {unread ? (
        <motion.span
          key="unread"
          initial={{ scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1, transition: spring.slow }}
          exit={{ scale: 0.4, opacity: 0, transition: exitFor.moderate }}
          className="size-2 shrink-0 rounded-full bg-accent shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_18%,transparent)]"
        >
          <span className="sr-only">Unread</span>
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}
