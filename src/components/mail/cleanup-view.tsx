"use client";
import { useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import { Search01Icon, SortByDown01Icon, SortByUp01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { CLEANUP_FILTERS, CLEANUP_SORTS, formatShare, perMonth, type CleanupFilter, type CleanupSort, type SenderSummary } from "@/lib/mail/cleanup";
import { spring } from "@/lib/motion";
import { cn, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { Avatar } from "./avatar";
import { FirstSyncState, SyncStrip, useFirstSync } from "./first-sync";
import { AccentTitle } from "../ui/accent-title";
import { formatBytes, plural } from "@/lib/format";
import { type CleanupState, FILTER_ORDER, nameOf } from "./use-cleanup";

// ---------------------------------------------------------------------------
// The sender table
// ---------------------------------------------------------------------------

type Column = { sort: CleanupSort; label: string; tip: string; show: string; render: (s: SenderSummary, now: number) => React.ReactNode };

/** Extra columns appear as the pane widens (container queries), so the table never assumes room. */
const COLUMNS: Column[] = [
  {
    sort: "monthly",
    label: "/ month",
    tip: "Emails a month since their first",
    show: "hidden @sm:block",
    render: (s, now) => {
      const n = perMonth(s, now);
      return n >= 10 ? Math.round(n) : n.toFixed(1);
    },
  },
  { sort: "unread", label: "Unread", tip: "Share you haven't read", show: "hidden @sm:block", render: (s) => formatShare(s.unread, s.emails) },
  {
    sort: "archivedUnread",
    label: "Skipped",
    tip: "Share archived without being read",
    show: "hidden @md:block",
    render: (s) => formatShare(s.archivedUnread, s.emails),
  },
  { sort: "lastRead", label: "Last read", tip: "Newest email of theirs you read", show: "hidden @lg:block", render: (s) => (s.lastRead ? formatListDate(s.lastRead) : "Never") },
  { sort: "size", label: "Files", tip: "Size of the files they sent", show: "hidden @xl:block", render: (s) => (s.fileBytes ? formatBytes(s.fileBytes) : "–") },
];
/** Shown only while they hold someone (or are picked), so the track doesn't fill with zeros. */
const OPTIONAL_FILTERS = new Set<CleanupFilter>(["still", "kept"]);

/** `onOpen`: one pane at a time, the sender pane takes the screen (a sender picked, or "Review" for the ticked ones). */
export function CleanupList({ cleanup, onOpen }: { cleanup: CleanupState; onOpen?: () => void }) {
  const { senders, loading, selected, checked, now, busy, filter, pickFilter, sort, setSort, query, setQuery, counts, visible } = cleanup;
  const firstSync = useFirstSync();
  const anchor = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const checkedSet = useMemo(() => new Set(checked), [checked]);
  const allChecked = visible.length > 0 && visible.every((s) => checkedSet.has(s.email));

  // The keyboard moves the picked sender: keep its row in view.
  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector(`[data-sender="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const check = (email: string, range: boolean) => {
    if (busy) return;
    if (range && anchor.current) {
      const from = visible.findIndex((s) => s.email === anchor.current);
      const to = visible.findIndex((s) => s.email === email);
      if (from >= 0 && to >= 0) {
        const span = visible.slice(Math.min(from, to), Math.max(from, to) + 1).map((s) => s.email);
        cleanup.setChecked([...new Set([...checked, ...span])]);
        return;
      }
    }
    anchor.current = email;
    cleanup.setChecked(checkedSet.has(email) ? checked.filter((e) => e !== email) : [...checked, email]);
  };

  const sortBy = (by: CleanupSort) => setSort((s) => ({ by, descending: s.by === by ? !s.descending : true }));

  return (
    <section className="flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      <header className="flex flex-col gap-3 px-3.5 pt-3">
        <div className="flex items-center gap-2 pl-1">
          <h1 className="flex-1 text-[20px] font-medium tracking-[-0.035em]"><AccentTitle text="Cleanup" /></h1>
          <span className="text-[12px] text-pane-muted">{plural(senders.length, "sender")}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full border border-pane-border px-3.5 text-[13.5px] focus-within:border-accent/60">
            <Icon icon={Search01Icon} size={16} className="shrink-0 text-pane-muted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a sender"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
            />
          </label>
          <Select
            label="Sort by"
            value={sort.by}
            options={(Object.keys(CLEANUP_SORTS) as CleanupSort[]).map((value) => ({ value, label: CLEANUP_SORTS[value].label }))}
            onChange={(by) => setSort((s) => ({ ...s, by }))}
            className="shrink-0"
          />
          <Tooltip label={sort.descending ? "Highest first" : "Lowest first"}>
            <button
              aria-label={sort.descending ? "Highest first" : "Lowest first"}
              onClick={() => setSort((s) => ({ ...s, descending: !s.descending }))}
              className="grid size-10 shrink-0 place-items-center rounded-full border border-pane-border text-pane-fg/80 transition-[background-color,color] duration-150 hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={sort.descending ? SortByDown01Icon : SortByUp01Icon} size={16} />
            </button>
          </Tooltip>
        </div>
        <FluidList
          axis="x"
          tone="pill"
          className="scroll-fade flex w-full items-center gap-0.5 overflow-x-auto rounded-full bg-pane-2 p-[3px] shadow-[inset_0_0_0_1px_var(--pane-border)] [scrollbar-width:none]"
        >
          {FILTER_ORDER.filter((f) => !OPTIONAL_FILTERS.has(f) || f === filter || counts[f] > 0).map((f) => (
            <button
              key={f}
              {...FLUID_ITEM}
              onClick={() => pickFilter(f)}
              className={cn(
                "relative h-[30px] shrink-0 whitespace-nowrap rounded-full px-3 text-[12.5px] transition-[color,background-color,font-weight] duration-150",
                filter === f ? "font-semibold text-pane-fg" : "font-medium text-pane-muted data-[lit]:text-pane-fg",
              )}
            >
              {filter === f ? (
                <motion.span
                  layoutId="cleanup-pill"
                  transition={spring.moderate}
                  className="absolute inset-0 rounded-full bg-pane-raised shadow-pill"
                />
              ) : null}
              <span className="relative">
                {CLEANUP_FILTERS[f].label}
                <span className="ml-1 tabular-nums text-pane-muted">{counts[f] ?? 0}</span>
              </span>
            </button>
          ))}
        </FluidList>
        {firstSync && senders.length ? <SyncStrip progress={firstSync} className="mx-1 mb-0 mt-0.5" /> : null}
      </header>

      <div ref={listRef} className="@container scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1">
        {firstSync && !senders.length ? (
          <FirstSyncState progress={firstSync} note="Senders are counted as your mail comes in." />
        ) : loading && !senders.length ? (
          <p className="flex items-center justify-center gap-2 p-6 text-[13px] text-pane-muted">
            <Spinner size={14} />
            Counting who sends you the most…
          </p>
        ) : !visible.length ? (
          <div className="grid h-full place-items-center p-8 text-center">
            <div>
              <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
                <Icon icon={Tick02Icon} size={20} />
              </div>
              <p className="text-[13px] font-medium">{filter === "kept" ? "Senders you keep show here" : "Nothing to clean up here"}</p>
            </div>
          </div>
        ) : (
          <>
            <div className="sticky top-0 z-10 flex items-center gap-3 bg-pane px-3 pb-1 pt-2 text-[11px] font-medium text-pane-muted">
              <Tooltip label={allChecked ? "Deselect all" : "Select all shown"}>
                <button
                  role="checkbox"
                  aria-checked={allChecked}
                  aria-label={allChecked ? "Deselect all" : "Select all shown"}
                  disabled={busy}
                  onClick={() => cleanup.setChecked(allChecked ? [] : visible.map((s) => s.email))}
                  className={cn(
                    "grid size-[18px] shrink-0 place-items-center rounded-full border transition-[background-color,border-color] duration-150 mx-[5px]",
                    allChecked ? "border-accent bg-accent text-accent-fg" : "border-pane-muted/60 hover:border-accent",
                  )}
                >
                  {allChecked ? <Icon icon={Tick02Icon} size={12} strokeWidth={2.5} /> : null}
                </button>
              </Tooltip>
              <span className="min-w-0 flex-1 truncate">{checked.length ? `${checked.length} selected` : "Sender"}</span>
              {COLUMNS.map((c) => (
                <SortHeader key={c.sort} column={c} sort={sort} onSort={sortBy} />
              ))}
              <SortHeader column={{ sort: "emails", label: "Emails", tip: "Emails from them (in your inbox below)", show: "block", render: () => null }} sort={sort} onSort={sortBy} />
            </div>
            <FluidList tone="pane">
              {visible.map((sender, index) => {
                const isChecked = checkedSet.has(sender.email);
                const prev = visible[index - 1];
                const next = visible[index + 1];
                return (
                  <SenderRow
                    key={sender.email}
                    index={index}
                    sender={sender}
                    now={now}
                    sortBy={sort.by}
                    selected={selected === sender.email}
                    checked={isChecked}
                    selecting={checked.length > 0}
                    joinAbove={isChecked && !!prev && checkedSet.has(prev.email)}
                    joinBelow={isChecked && !!next && checkedSet.has(next.email)}
                    onSelect={() => {
                      cleanup.setSelected(sender.email);
                      onOpen?.();
                    }}
                    onCheck={(range) => check(sender.email, range)}
                  />
                );
              })}
            </FluidList>
          </>
        )}
      </div>
      {onOpen && (checked.length || cleanup.queue) ? (
        <div className="blur-fade-up border-t border-pane-border p-2">
          <button
            onClick={onOpen}
            className="flex h-10 w-full items-center justify-center rounded-full bg-pane-fg text-[13px] font-medium text-pane transition-opacity hover:opacity-90 touch:h-11"
          >
            {cleanup.queue && !cleanup.queue.finished ? "Show progress" : `Review ${plural(checked.length, "sender")}`}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function SortHeader({ column, sort, onSort }: { column: Column; sort: { by: CleanupSort; descending: boolean }; onSort: (by: CleanupSort) => void }) {
  const active = sort.by === column.sort;
  return (
    <Tooltip label={column.tip} className={cn(column.sort === "emails" ? "w-16" : "w-14", "shrink-0", column.show)}>
      <button
        onClick={() => onSort(column.sort)}
        className={cn("flex w-full items-center justify-end gap-0.5 truncate transition-colors duration-150 hover:text-pane-fg", active && "text-pane-fg")}
      >
        {column.label}
        {active ? <Icon icon={sort.descending ? SortByDown01Icon : SortByUp01Icon} size={11} /> : null}
      </button>
    </Tooltip>
  );
}

function SenderRow({
  index,
  sender,
  now,
  sortBy,
  selected,
  checked,
  selecting,
  joinAbove,
  joinBelow,
  onSelect,
  onCheck,
}: {
  index: number;
  sender: SenderSummary;
  now: number;
  /** The sorted column reads in full colour; the rest stay quiet. */
  sortBy: CleanupSort;
  selected: boolean;
  checked: boolean;
  selecting: boolean;
  /** Ticked rows next to each other merge into one shape. */
  joinAbove: boolean;
  joinBelow: boolean;
  onSelect: () => void;
  onCheck: (range: boolean) => void;
}) {
  return (
    <div
      {...FLUID_ITEM}
      data-sender={sender.email}
      role="button"
      tabIndex={0}
      onMouseDown={(e) => {
        if (e.shiftKey) e.preventDefault();
      }}
      onClick={(e) => {
        if (e.shiftKey) onCheck(true);
        else if (e.ctrlKey || e.metaKey) onCheck(false);
        else onSelect();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
      style={{ "--i": index } as React.CSSProperties}
      className={cn(
        index < 16 && "blur-fade-up",
        "group relative flex cursor-default items-center gap-3 rounded-xl px-3 py-2 transition-[background-color,border-radius] duration-150 [contain-intrinsic-size:auto_52px] [content-visibility:auto]",
        checked
          ? cn("bg-accent-soft", joinAbove && "rounded-t-none", joinBelow && "rounded-b-none")
          : selected && !selecting
            ? "bg-pane-selected"
            : selected
              ? "bg-pane-hover"
              : "",
      )}
    >
      <Tooltip label={checked ? "Deselect" : "Select"}>
        <button
          {...FLUID_IGNORE}
          role="checkbox"
          aria-checked={checked}
          aria-label={checked ? "Deselect" : "Select"}
          onMouseDown={(e) => {
            if (e.shiftKey) e.preventDefault();
          }}
          onClick={(e) => {
            e.stopPropagation();
            onCheck(e.shiftKey);
          }}
          className="group/check relative block size-7 shrink-0 rounded-full"
        >
          <span data-sensitive className="block">
            <Avatar
              name={nameOf(sender)}
              email={sender.email}
              className={cn("size-7 transition-opacity duration-150", checked || selecting ? "opacity-0" : "group-hover/check:opacity-0")}
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
      <div className="min-w-0 flex-1" data-sensitive>
        <div className="flex items-center gap-1.5">
          <span className="min-w-[3rem] truncate text-[13.5px] font-medium">{nameOf(sender)}</span>
          <SenderBadges sender={sender} one />
        </div>
        <div className="truncate text-[12px] text-pane-muted">{sender.email}</div>
      </div>
      {COLUMNS.map((c) => (
        <div
          key={c.sort}
          className={cn("w-14 shrink-0 text-right text-[12.5px] tabular-nums", c.sort === sortBy ? "font-medium text-pane-fg" : "text-pane-muted", c.show)}
        >
          {c.render(sender, now)}
        </div>
      ))}
      <div className="w-16 shrink-0 text-right">
        <div className={cn("text-[14px] tabular-nums", sortBy === "emails" || sortBy === "inbox" ? "font-semibold" : "font-medium text-pane-fg/85")}>{sender.emails}</div>
        <div className="truncate text-[10.5px] text-pane-muted">
          {!sender.inInbox ? "inbox clear" : sender.inInbox === sender.emails ? "all in inbox" : `${sender.inInbox} in inbox`}
        </div>
      </div>
    </div>
  );
}

/** The sender's state as small chips; `one` keeps only the most telling (list rows, where the name comes first). */
export function SenderBadges({ sender, one = false }: { sender: SenderSummary; one?: boolean }) {
  const chips = [
    sender.status === "blocked" ? { label: "Blocked", tone: "bg-pane-hover text-pane-muted" } : null,
    sender.sinceUnsubscribe > 0 && sender.status !== "blocked" ? { label: "Still sending", tone: "bg-warning/15 text-warning" } : null,
    sender.unsubscribedAt && !(sender.sinceUnsubscribe > 0 && sender.status !== "blocked") ? { label: "Unsubscribed", tone: "bg-success/15 text-success" } : null,
  ].filter((c) => c !== null);
  return (one ? chips.slice(0, 1) : chips).map((c) => (
    <span key={c.label} className={cn("min-w-0 shrink truncate rounded-full px-1.5 text-[10.5px] font-medium", c.tone)}>
      {c.label}
    </span>
  ));
}
