"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Alert02Icon,
  Archive02Icon,
  Delete02Icon,
  BrushCleaningIcon,
  Cancel01Icon,
  LinkSquare02Icon,
  MailRemove01Icon,
  Search01Icon,
  SortByDown01Icon,
  SortByUp01Icon,
  ThumbsUpIcon,
  Tick02Icon,
  UserBlock01Icon,
  WorkflowSquare03Icon,
} from "@hugeicons/core-free-icons";
import {
  CLEANUP_FILTERS,
  CLEANUP_SORTS,
  UNSUBSCRIBE_GRACE_DAYS,
  formatShare,
  inFilter,
  perMonth,
  sortSenders,
  type CleanupFilter,
  type CleanupSort,
  type SenderDetail,
  type SenderSummary,
} from "@/lib/mail/cleanup";
import { gmailFilterFor } from "@/lib/rules/gmail";
import type { Account } from "@/lib/mail/types";
import type { MailBatchRequest } from "@/lib/mail/batch";
import { blurFade, spring } from "@/lib/motion";
import { cn, formatListDate } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip } from "../ui/tooltip";
import { Avatar } from "./avatar";
import { CircleButton } from "./circle-button";
import { FirstSyncState, SyncStrip, useFirstSync } from "./first-sync";
import { AccentTitle } from "../ui/accent-title";
import { formatBytes, plural } from "@/lib/format";

// Cleanup: who fills your mailbox, from the local copy only (lib/mail/cleanup.ts). The user ticks
// senders and picks what happens; Kite never decides who goes. Work runs as a queue, one sender at
// a time, and every archive it makes has Undo.

type Toast = { message: string; onUndo?: () => void };

/** What a queue does to each sender: unsubscribe, or block (which archives too). Archive and Trash go through mail-batch-dialog. */
type Run = "block" | "unsubscribe";

type QueueItem = { email: string; name: string; state: "waiting" | "running" | "done" | "failed" | "skipped"; note?: string; url?: string };

type Queue = { run: Run; items: QueueItem[]; finished: boolean };

type UnsubscribeResult = { method: "one-click" | "email" | "website" | "none"; done: boolean; url?: string };

async function post<T>(body: unknown, url = "/api/senders", method = "POST"): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "That didn't go through. Try again.");
  return data as T;
}

const nameOf = (s: Pick<SenderSummary, "name" | "email">) => s.name || s.email;

/** Cleanup's state: the sender table, the picked and ticked senders, one sender's detail and the running queue. */
export function useCleanup({
  open,
  live,
  accountId,
  reloadKey,
  onToast,
  onBatch,
  working,
}: {
  open: boolean;
  live: boolean;
  accountId: string;
  reloadKey: number;
  onToast: (toast: Toast) => void;
  onBatch: (request: MailBatchRequest, options?: { unsubscribable?: number; quiet?: boolean }) => void;
  /** The bulk change under way (mail-batch-dialog), so its buttons show they're working. */
  working: MailBatchRequest | null;
}) {
  const [own, setOwn] = useState(0);
  const key = `${accountId}:${reloadKey}:${own}`;
  const [data, setData] = useState<{ key: string; senders: SenderSummary[]; at: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<string[]>([]);
  const [detail, setDetail] = useState<{ key: string; data: SenderDetail } | null>(null);
  const [queue, setQueue] = useState<Queue | null>(null);
  const stop = useRef(false);
  const reload = () => setOwn((n) => n + 1);

  useEffect(() => {
    if (!open || !live) return;
    const controller = new AbortController();
    fetch(`/api/senders?account=${encodeURIComponent(accountId)}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((d: { senders?: SenderSummary[] }) => setData({ key, senders: d.senders ?? [], at: Date.now() }))
      .catch(() => {});
    return () => controller.abort();
  }, [open, live, accountId, key]);

  const detailKey = selected ? `${selected}:${key}` : "";
  useEffect(() => {
    if (!open || !live || !selected) return;
    const controller = new AbortController();
    fetch(`/api/senders?sender=${encodeURIComponent(selected)}&account=${encodeURIComponent(accountId)}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((d: SenderDetail | null) => d && setDetail({ key: detailKey, data: d }))
      .catch(() => {});
    return () => controller.abort();
  }, [open, live, selected, accountId, detailKey]);

  const senders = useMemo(() => data?.senders ?? [], [data]);
  const busy = !!queue && !queue.finished;
  const now = data?.at ?? 0;

  // The table as shown: the filter, the sort and the search, kept here so the keyboard moves
  // through the same rows the list draws.
  const [filter, setFilter] = useState<CleanupFilter>("inbox");
  const [sort, setSort] = useState<{ by: CleanupSort; descending: boolean }>({ by: "emails", descending: true });
  const [query, setQuery] = useState("");
  const counts = useMemo(
    () => Object.fromEntries(FILTER_ORDER.map((f) => [f, senders.filter((s) => inFilter(s, f, now)).length])) as Record<CleanupFilter, number>,
    [senders, now],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = senders.filter((s) => inFilter(s, filter, now) && (!q || s.email.includes(q) || s.name?.toLowerCase().includes(q)));
    return sortSenders(shown, sort.by, sort.descending, now);
  }, [senders, filter, query, sort, now]);
  const pickFilter = (f: CleanupFilter) => {
    setFilter(f);
    if (!busy) setChecked([]);
  };

  /** The keyboard (j/k, x, Shift+A, Escape through the shortcuts): moves the picked sender, ticks it, clears. */
  const keys = {
    move: (delta: number) => {
      if (!visible.length) return;
      const at = visible.findIndex((s) => s.email === selected);
      const next = visible[at < 0 ? (delta > 0 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, at + delta))];
      setSelected(next.email);
    },
    toggle: () => {
      if (busy || !selected || !visible.some((s) => s.email === selected)) return;
      setChecked((list) => (list.includes(selected) ? list.filter((e) => e !== selected) : [...list, selected]));
    },
    extend: (delta: number) => {
      if (busy || !visible.length) return;
      const at = visible.findIndex((s) => s.email === selected);
      const next = visible[Math.min(visible.length - 1, Math.max(0, at + delta))];
      setChecked((list) => [...new Set([...list, ...(selected ? [selected] : []), next.email])]);
      setSelected(next.email);
    },
    all: () => !busy && setChecked(visible.map((s) => s.email)),
    clear: () => !busy && setChecked([]),
  };

  const undoArchives = (undo: string[]) =>
    post({ action: "undo", undo })
      .then(() => onToast({ message: "Put back in your inbox" }))
      .catch((error: Error) => onToast({ message: error.message }))
      .finally(reload);

  /** Works through the senders one at a time; Stop finishes the current one and skips the rest. */
  const run = async (kind: Run, emails: string[]) => {
    if (busy) return;
    const list = emails.flatMap((e) => senders.filter((s) => s.email === e));
    if (!list.length) return;
    stop.current = false;
    let items: QueueItem[] = list.map((s) => ({ email: s.email, name: nameOf(s), state: "waiting" }));
    const update = (i: number, patch: Partial<QueueItem>) => {
      items = items.map((item, j) => (j === i ? { ...item, ...patch } : item));
      setQueue({ run: kind, items, finished: false });
    };
    setQueue({ run: kind, items, finished: false });

    const undo: string[] = [];
    let archived = 0;
    let unsubscribed = 0;
    let failed = 0;
    for (let i = 0; i < list.length; i++) {
      if (stop.current) {
        update(i, { state: "skipped", note: "Skipped" });
        continue;
      }
      const sender = list[i];
      update(i, { state: "running" });
      const notes: string[] = [];
      let url: string | undefined;
      try {
        if (kind === "unsubscribe" && sender.canUnsubscribe && !sender.unsubscribedAt) {
          const { result } = await post<{ result: UnsubscribeResult }>({ action: "unsubscribe", email: sender.email, account: accountId });
          if (result.done) {
            unsubscribed++;
            notes.push("Unsubscribed");
          } else if (result.method === "website" && result.url) {
            url = result.url;
            notes.push("Finish on their page");
          } else notes.push("No way to unsubscribe");
        }
        if (kind === "unsubscribe") { update(i, { state: "done", note: notes.join(" · "), url }); continue; }
        const res = await post<{ archived: number; undo?: string }>({ action: "block", email: sender.email, account: accountId });
        if (res.undo) undo.push(res.undo);
        archived += res.archived;
        notes.push("Blocked");
        notes.push(res.archived ? `${res.archived} archived` : "Inbox already clear");
        update(i, { state: "done", note: notes.join(" · "), url });
      } catch (error) {
        failed++;
        update(i, { state: "failed", note: (error as Error).message, url });
      }
    }
    setQueue({ run: kind, items, finished: true });
    reload();

    const parts = [
      kind === "block" ? `${plural(items.filter((i) => i.state === "done").length, "sender")} blocked` : null,
      unsubscribed ? `${unsubscribed} unsubscribed` : null,
      kind === "unsubscribe" ? null : `${archived} archived`,
      failed ? `${failed} didn't go through` : null,
    ].filter(Boolean);
    const onUndo = undo.length ? () => void undoArchives(undo) : undefined;
    if (list.length === 1) {
      // One sender: the button showed the progress, so there's no queue to look at.
      setQueue(null);
      const only = items[0];
      if (only.url) window.open(only.url, "_blank", "noopener,noreferrer");
      const lead =
        only.state === "failed"
          ? only.note ?? "That didn't go through. Try again."
          : only.url
            ? "Finish unsubscribing on the page that just opened"
            : kind === "block"
              ? `${only.name} is blocked`
              : unsubscribed
                ? `Unsubscribed from ${only.name}`
                : kind === "unsubscribe"
                  ? `${only.name} doesn't offer a way to unsubscribe`
                  : null;
      onToast({ message: [lead, only.state === "failed" || kind === "unsubscribe" ? null : `${archived} archived`].filter(Boolean).join(" · "), onUndo });
    } else onToast({ message: parts.join(" · "), onUndo });
  };

  const keep = (emails: string[], kept: boolean) => {
    const names = emails.map((e) => nameOf(senders.find((s) => s.email === e) ?? { name: "", email: e }));
    Promise.all(emails.map((email) => post({ action: kept ? "keep" : "unkeep", email })))
      .then(() => {
        setChecked([]);
        onToast({
          message: kept
            ? `Keeping ${emails.length === 1 ? names[0] : plural(emails.length, "sender")}: Cleanup won't suggest them`
            : `${emails.length === 1 ? names[0] : plural(emails.length, "sender")} back in Cleanup`,
          onUndo: () => void Promise.all(emails.map((email) => post({ action: kept ? "unkeep" : "keep", email }))).finally(reload),
        });
      })
      .catch((error: Error) => onToast({ message: error.message }))
      .finally(reload);
  };

  /** "Archive future mail": a rule the user can see and change in Settings → Rules, never hard-wired. */
  const archiveFuture = (sender: SenderSummary, gmail: boolean) =>
    post<{ rule: { id: string } }>(
      { name: `Archive mail from ${nameOf(sender)}`.slice(0, 60), query: `from:${sender.email}`, actions: [{ verb: "archive" }], gmail },
      "/api/rules",
    )
      .then(({ rule }) => {
        reload();
        onToast({
          message: `New mail from ${nameOf(sender)} will skip your inbox`,
          onUndo: () => void post({}, `/api/rules/${rule.id}`, "DELETE").finally(reload),
        });
      })
      .catch((error: Error) => onToast({ message: error.message }));

  return {
    senders,
    /** When the table was read, for "per month" (never Date.now() during render). */
    now,
    filter,
    pickFilter,
    sort,
    setSort,
    query,
    setQuery,
    counts,
    visible,
    keys,
    loading: data?.key !== key,
    selected,
    setSelected,
    checked,
    setChecked,
    detail: detail?.key === detailKey ? detail.data : null,
    queue,
    busy,
    run,
    /** Opens the Move to Trash sheet; "Unsubscribe too" is offered there when any of them can be. */
    deleteMail: (emails: string[]) =>
      onBatch(
        { account: accountId, action: "trash", senders: emails, inboxOnly: true },
        { unsubscribable: senders.filter((s) => emails.includes(s.email) && s.canUnsubscribe && !s.unsubscribedAt).length },
      ),
    /** Archive needs no sheet: it's undone as easily, so it starts at once with its progress in the corner. */
    archiveMail: (emails: string[]) => onBatch({ account: accountId, action: "archive", senders: emails, inboxOnly: true }, { quiet: true }),
    /** Whether a bulk change of this kind is working on any of these senders. */
    working: (action: MailBatchRequest["action"], emails: string[]) => working?.action === action && !!working.senders?.some((e) => emails.includes(e)),
    stopQueue: () => {
      stop.current = true;
    },
    closeQueue: () => {
      setQueue(null);
      setChecked([]);
    },
    keep,
    archiveFuture,
  };
}

export type CleanupState = ReturnType<typeof useCleanup>;

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

const FILTER_ORDER: CleanupFilter[] = ["inbox", "never", "volume", "newsletters", "still", "all", "kept"];
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
                  className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
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
function SenderBadges({ sender, one = false }: { sender: SenderSummary; one?: boolean }) {
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

// ---------------------------------------------------------------------------
// The right pane: the running queue, the ticked senders, or one sender
// ---------------------------------------------------------------------------

export function CleanupPane({ cleanup, live, accounts, onOpenRules }: { cleanup: CleanupState; live: boolean; accounts: Account[]; onOpenRules: () => void }) {
  const { queue, checked, senders } = cleanup;
  if (queue && queue.items.length > 1) return <QueuePanel cleanup={cleanup} queue={queue} />;
  const ticked = checked.flatMap((e) => senders.filter((s) => s.email === e));
  if (ticked.length) return <BulkPanel key={ticked.length > 1 ? "many" : ticked[0].email} cleanup={cleanup} senders={ticked} />;
  const sender = live ? senders.find((s) => s.email === cleanup.selected) ?? null : null;
  return <CleanupDetail key={sender?.email ?? "none"} cleanup={cleanup} sender={sender} accounts={accounts} onOpenRules={onOpenRules} />;
}

function CleanupDetail({
  cleanup,
  sender,
  accounts,
  onOpenRules,
}: {
  cleanup: CleanupState;
  sender: SenderSummary | null;
  accounts: Account[];
  onOpenRules: () => void;
}) {
  // Rendered with key={sender.email}, so these reset per sender.
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [gmail, setGmail] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!sender) {
    return (
      <section className="grid h-full place-items-center bg-pane text-pane-muted">
        <div className="blur-fade max-w-xs px-6 text-center">
          <Icon icon={BrushCleaningIcon} size={28} className="mx-auto mb-3 opacity-50" />
          <p className="text-[13px]">Pick a sender to see how much they send and clear them out. Tick several to clean up in one go.</p>
        </div>
      </section>
    );
  }

  const { detail, queue, now } = cleanup;
  const running = queue && !queue.finished ? queue.run : null;
  const name = nameOf(sender);
  const stillSending = sender.sinceUnsubscribe > 0 && sender.status !== "blocked";
  const gmailAccounts = accounts.filter((a) => a.provider === "gmail" && sender.accountIds.includes(a.id));
  const gmailCheck = gmailFilterFor({ query: `from:${sender.email}`, conditions: [], actions: [{ verb: "archive" }], stop: false });
  const gmailOk = gmailCheck.ok;
  const stats = [
    { label: "Emails", value: sender.emails },
    { label: "In your inbox", value: sender.inInbox },
    { label: "Per month", value: perMonth(sender, now).toFixed(1) },
    { label: "Unread", value: formatShare(sender.unread, sender.emails) },
    { label: "Archived unread", value: formatShare(sender.archivedUnread, sender.emails) },
    { label: "Last read", value: sender.lastRead ? formatListDate(sender.lastRead) : "Never" },
  ];
  const unsubscribe = sender.canUnsubscribe && !sender.unsubscribedAt;

  const confirmPanel = (key: string, text: React.ReactNode, action: string, onConfirm: () => void, onCancel: () => void, extra?: React.ReactNode, saving = false) => (
    <motion.div key={key} {...blurFade({ y: 4 })} className="mt-3 rounded-2xl border border-pane-border bg-pane-2 p-3.5 text-[12.5px]">
      <p className="text-pane-fg/85">{text}</p>
      {extra}
      <div className="mt-3 flex gap-2">
        <button
          disabled={saving}
          onClick={onConfirm}
          className="flex h-8 items-center gap-2 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {saving ? <Spinner size={13} /> : null}
          {action}
        </button>
        <button onClick={onCancel} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted transition-colors duration-150 hover:text-pane-fg">
          Cancel
        </button>
      </div>
    </motion.div>
  );

  return (
    <section className="flex h-full flex-col overflow-y-auto bg-pane text-pane-fg scroll-fade">
      <div key={sender.email} className="@container blur-fade-up mx-auto w-full max-w-[600px] px-5 pb-10 pt-6 sm:px-8">
        <header className="flex items-start gap-3.5">
          <span data-sensitive className="shrink-0">
            <Avatar name={name} email={sender.email} className="size-12 text-[15px]" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5" data-sensitive>
            <h2 className="flex min-w-0 items-center gap-2 text-[19px] font-semibold leading-tight tracking-tight">
              <span className="min-w-0 truncate">{name}</span>
              <SenderBadges sender={sender} />
            </h2>
            <p className="mt-0.5 truncate text-[12.5px] text-pane-muted">
              {sender.email !== name ? `${sender.email} · ` : ""}since {formatListDate(sender.firstDate)}
              {sender.fileBytes ? ` · ${formatBytes(sender.fileBytes)} of files` : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <CircleButton
              icon={ThumbsUpIcon}
              label={sender.keptAt ? "Kept: show in Cleanup again" : "Keep: stop suggesting them"}
              active={!!sender.keptAt}
              onClick={() => {
                if (!running) cleanup.keep([sender.email], !sender.keptAt);
              }}
            />
          </div>
        </header>

        <div className="mt-5">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-pane-border shadow-[0_0_0_1px_var(--pane-border)] @[22rem]:grid-cols-3">
            {stats.map((stat) => (
              <div key={stat.label} className="flex min-w-0 flex-col-reverse bg-pane-2 px-3.5 py-2.5">
                <dt className="truncate text-[11.5px] text-pane-muted">{stat.label}</dt>
                <dd className="truncate text-[17px] font-semibold tabular-nums tracking-tight">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <ActionGroup title="Their emails">
          <div className="grid grid-cols-1 gap-2 @[26rem]:grid-cols-2">
            <ActionTile
              icon={Archive02Icon}
              title={sender.inInbox ? `Archive ${plural(sender.inInbox, "email")}` : "Inbox is clear"}
              detail={sender.inInbox ? "Out of your inbox, kept in All mail" : "Nothing of theirs is in your inbox"}
              busy={cleanup.working("archive", [sender.email])}
              disabled={!sender.inInbox || !!running}
              onClick={() => cleanup.archiveMail([sender.email])}
            />
            <ActionTile
              icon={Delete02Icon}
              title="Move to Trash"
              detail="Pick inbox or everything next; restore any time"
              busy={cleanup.working("trash", [sender.email])}
              disabled={!!running}
              onClick={() => cleanup.deleteMail([sender.email])}
            />
          </div>
        </ActionGroup>

        <ActionGroup title="From now on">
          <ul className="overflow-hidden rounded-2xl border border-pane-border">
            {sender.canUnsubscribe || sender.unsubscribedAt ? (
              <ChoiceRow
                icon={MailRemove01Icon}
                title="Unsubscribe"
                detail={sender.unsubscribedAt ? `You unsubscribed on ${formatListDate(sender.unsubscribedAt)}` : "Ask them to stop sending"}
              >
                {unsubscribe ? (
                  <RowButton busy={running === "unsubscribe"} disabled={!!running} onClick={() => void cleanup.run("unsubscribe", [sender.email])}>
                    Unsubscribe
                  </RowButton>
                ) : (
                  <Done>Done</Done>
                )}
              </ChoiceRow>
            ) : null}
            <ChoiceRow
              icon={WorkflowSquare03Icon}
              title="Skip the inbox"
              detail={
                detail?.archiveRule
                  ? `Automation “${detail.archiveRule.name}”${detail.archiveRule.enabled ? "" : " (paused)"}`
                  : "New mail from them goes straight to All mail"
              }
            >
              {detail?.archiveRule ? (
                <RowButton onClick={onOpenRules}>Edit</RowButton>
              ) : (
                <RowButton disabled={ruleOpen} onClick={() => setRuleOpen(true)}>
                  Set up
                </RowButton>
              )}
            </ChoiceRow>
            <ChoiceRow icon={UserBlock01Icon} title="Block" detail="Everything they send is archived, now and as it arrives">
              {sender.status === "blocked" ? (
                <Done>Blocked</Done>
              ) : (
                <RowButton busy={running === "block"} disabled={!!running || confirmBlock} onClick={() => setConfirmBlock(true)}>
                  Block
                </RowButton>
              )}
            </ChoiceRow>
          </ul>

          <AnimatePresence mode="popLayout" initial={false}>
            {confirmBlock
              ? confirmPanel(
                  "block",
                  <>Block {name}? Everything they&apos;ve sent leaves your inbox, and future mail is archived as it arrives.</>,
                  "Block sender",
                  () => {
                    setConfirmBlock(false);
                    void cleanup.run("block", [sender.email]);
                  },
                  () => setConfirmBlock(false),
                )
              : ruleOpen && !detail?.archiveRule
                ? confirmPanel(
                    "rule",
                    <>New mail from {name} skips your inbox. Kite adds an automation you can change or remove in Automations.</>,
                    "Add automation",
                    () => {
                      setSaving(true);
                      void cleanup.archiveFuture(sender, gmail && gmailOk && gmailAccounts.length > 0).finally(() => {
                        setSaving(false);
                        setRuleOpen(false);
                      });
                    },
                    () => setRuleOpen(false),
                    gmailAccounts.length ? (
                      <div className="mt-3 flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">Also run in Gmail</span>
                          <span className="block text-pane-muted">{gmailCheck.ok ? "A Gmail filter archives their mail even while Kite is closed." : gmailCheck.reason}</span>
                        </span>
                        <Switch value={gmail && gmailOk} onChange={setGmail} disabled={!gmailOk} label="Also run in Gmail" size="sm" />
                      </div>
                    ) : null,
                    saving,
                  )
                : null}
          </AnimatePresence>

          {stillSending ? (
            <div className="mt-3 flex items-start gap-2.5 rounded-2xl bg-warning/10 px-3.5 py-3 text-[12.5px]">
              <Icon icon={Alert02Icon} size={15} className="mt-px shrink-0 text-warning" />
              <p className="min-w-0 flex-1 text-pane-fg/85">
                <span className="font-medium text-pane-fg">Still sending.</span> {plural(sender.sinceUnsubscribe, "email")} arrived more than {UNSUBSCRIBE_GRACE_DAYS} days
                after you unsubscribed. Blocking them stops it.
              </p>
            </div>
          ) : null}
        </ActionGroup>
        {detail?.recent.length ? (
          <section className="mt-7" data-sensitive>
            <h3 className="pb-1.5 text-[11px] font-medium uppercase tracking-wider text-pane-muted">Recent</h3>
            <FluidList tone="pane" role="list" className="-mx-2">
              {detail.recent.map((m, i) => (
                <li
                  key={i}
                  {...FLUID_ITEM}
                  style={{ "--i": i } as React.CSSProperties}
                  className="blur-fade-up relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-[background-color] duration-150"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", m.unread ? "bg-accent" : "bg-transparent")} />
                  <span className={cn("min-w-0 flex-1 truncate", m.unread ? "font-medium" : "text-pane-fg/75")}>{m.subject}</span>
                  {m.inInbox ? <span className="shrink-0 text-[11px] text-pane-muted">Inbox</span> : null}
                  <span className="w-14 shrink-0 text-right text-[11.5px] tabular-nums text-pane-muted">{formatListDate(m.date)}</span>
                </li>
              ))}
            </FluidList>
          </section>
        ) : null}
      </div>
    </section>
  );
}

/** A heading over one kind of choice: what's here now, or what happens from now on. */
function ActionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="pb-2 text-[11px] font-medium uppercase tracking-wider text-pane-muted">{title}</h3>
      {children}
    </section>
  );
}

/** A big choice for mail that's already here: icon, what it does, and one line on what that means. */
function ActionTile({ icon, title, detail, busy, disabled, onClick }: { icon: IconData; title: string; detail: string; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-2xl border border-pane-border p-3 text-left transition-[opacity,transform,background-color] duration-150 hover:bg-pane-hover active:scale-[0.98] disabled:pointer-events-none touch:p-3.5",
        disabled && !busy && "opacity-50",
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-pane-2">{busy ? <Spinner size={16} /> : <Icon icon={icon} size={18} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium leading-snug">{title}</span>
        <span className="block text-[12px] leading-snug text-pane-muted">{detail}</span>
      </span>
    </button>
  );
}

/** One row of "From now on": what it is on the left, its button on the right. */
function ChoiceRow({ icon, title, detail, children }: { icon: IconData; title: string; detail: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3.5 py-3 [&+&]:border-t [&+&]:border-pane-border">
      <Icon icon={icon} size={18} className="shrink-0 text-pane-muted" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium leading-snug">{title}</span>
        <span className="block text-[12px] leading-snug text-pane-muted">{detail}</span>
      </span>
      {children}
    </li>
  );
}

function RowButton({ children, busy, disabled, onClick }: { children: React.ReactNode; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-[opacity,transform,background-color] duration-150 hover:bg-pane-hover active:scale-[0.97] disabled:pointer-events-none touch:h-10",
        disabled && !busy && "opacity-50",
      )}
    >
      {busy ? <Spinner size={13} /> : null}
      {children}
    </button>
  );
}

/** A choice already made, where its button would be. */
function Done({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1 px-1 text-[12.5px] font-medium text-success">
      <Icon icon={Tick02Icon} size={14} />
      {children}
    </span>
  );
}

/** Several ticked senders: one confirm for anything that can't be taken back, then the queue. */
function BulkPanel({ cleanup, senders }: { cleanup: CleanupState; senders: SenderSummary[] }) {
  const [confirm, setConfirm] = useState<"block" | null>(null);
  const emails = senders.map((s) => s.email);
  const inInbox = senders.reduce((n, s) => n + s.inInbox, 0);
  const total = senders.reduce((n, s) => n + s.emails, 0);
  const canUnsubscribe = senders.filter((s) => s.canUnsubscribe && !s.unsubscribedAt).length;
  const faces = senders.slice(0, 5);
  const shown = senders.slice(0, 6);

  return (
    <section className="grid h-full place-items-center overflow-y-auto bg-pane p-6 text-pane-fg sm:p-8">
      <div className="w-full max-w-sm">
        <div className="blur-fade-up flex justify-center" style={{ "--i": 0 } as React.CSSProperties} data-sensitive>
          {faces.map((s, i) => (
            <span key={s.email} className={cn("flex rounded-full bg-pane ring-4 ring-pane", i > 0 && "-ml-3")}>
              <Avatar name={nameOf(s)} email={s.email} className="size-10" />
            </span>
          ))}
        </div>
        <h2 className="blur-fade-up mt-4 text-center text-[17px] font-semibold tracking-tight" style={{ "--i": 1 } as React.CSSProperties}>
          {plural(senders.length, "sender")} selected
        </h2>
        <p className="blur-fade-up mt-1 text-center text-[12.5px] text-pane-muted" style={{ "--i": 1 } as React.CSSProperties}>
          {plural(total, "email")} · {inInbox} in your inbox · {canUnsubscribe} can unsubscribe
        </p>

        <ul className="blur-fade-up mt-4 overflow-hidden rounded-xl border border-pane-border" style={{ "--i": 2 } as React.CSSProperties} data-sensitive>
          {shown.map((s) => (
            <li key={s.email} className="flex items-baseline gap-2 border-b border-pane-border px-3 py-2 text-[12.5px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate font-medium">{nameOf(s)}</span>
              <span className="shrink-0 tabular-nums text-pane-muted">{s.inInbox} in inbox</span>
            </li>
          ))}
          {senders.length > shown.length ? <li className="px-3 py-2 text-[12px] text-pane-muted">and {senders.length - shown.length} more</li> : null}
        </ul>

        <div className="@container blur-fade-up" style={{ "--i": 3 } as React.CSSProperties}>
          <ActionGroup title="Their emails">
            <div className="grid grid-cols-1 gap-2">
              <ActionTile
                icon={Archive02Icon}
                title={inInbox ? `Archive ${plural(inInbox, "email")}` : "Inbox is clear"}
                detail={inInbox ? "Out of your inbox, kept in All mail" : "Nothing of theirs is in your inbox"}
                busy={cleanup.working("archive", emails)}
                disabled={!inInbox}
                onClick={() => cleanup.archiveMail(emails)}
              />
              <ActionTile
                icon={Delete02Icon}
                title="Move to Trash"
                detail="Pick inbox or everything next; restore any time"
                busy={cleanup.working("trash", emails)}
                onClick={() => cleanup.deleteMail(emails)}
              />
            </div>
          </ActionGroup>

          <ActionGroup title="From now on">
            <ul className="overflow-hidden rounded-2xl border border-pane-border">
              {canUnsubscribe ? (
                <ChoiceRow icon={MailRemove01Icon} title="Unsubscribe" detail={`Ask ${plural(canUnsubscribe, "sender")} to stop`}>
                  <RowButton onClick={() => void cleanup.run("unsubscribe", emails)}>Unsubscribe</RowButton>
                </ChoiceRow>
              ) : null}
              <ChoiceRow icon={UserBlock01Icon} title="Block" detail="Their mail is archived, now and as it arrives">
                <RowButton disabled={!!confirm} onClick={() => setConfirm("block")}>
                  Block
                </RowButton>
              </ChoiceRow>
              <ChoiceRow icon={ThumbsUpIcon} title="Keep" detail="Stop suggesting them in Cleanup">
                <RowButton onClick={() => cleanup.keep(emails, true)}>Keep</RowButton>
              </ChoiceRow>
            </ul>
            <AnimatePresence mode="popLayout" initial={false}>
              {confirm ? (
                <motion.div key={confirm} {...blurFade({ y: 4 })} className="mt-3 rounded-2xl border border-pane-border bg-pane-2 p-3.5 text-[12.5px]">
                  <p className="text-pane-fg/85">
                    Block {plural(senders.length, "sender")}? Their {plural(inInbox, "email")} leave your inbox, and future mail is archived as it arrives.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => {
                        setConfirm(null);
                        void cleanup.run("block", emails);
                      }}
                      className="h-8 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane transition-opacity duration-150 hover:opacity-90"
                    >
                      Block senders
                    </button>
                    <button onClick={() => setConfirm(null)} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted transition-colors duration-150 hover:text-pane-fg">
                      Cancel
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </ActionGroup>
        </div>

        <button
          onClick={() => cleanup.setChecked([])}
          className="blur-fade-up mx-auto mt-4 flex items-center gap-1.5 text-[12px] text-pane-muted hover:text-pane-fg"
          style={{ "--i": 4 } as React.CSSProperties}
        >
          Clear selection
        </button>
      </div>
    </section>
  );
}

const RUN_TITLES: Record<Run, [string, string]> = {
  unsubscribe: ["Unsubscribing", "Unsubscribed"],
  block: ["Blocking", "Blocked"],
};

/** The queue at work: one sender at a time, each with what happened; unsubscribe pages to finish are links. */
function QueuePanel({ cleanup, queue }: { cleanup: CleanupState; queue: Queue }) {
  const settled = queue.items.filter((i) => i.state !== "waiting" && i.state !== "running").length;
  const pages = queue.items.filter((i) => i.url);
  return (
    <section className="flex h-full flex-col overflow-y-auto bg-pane text-pane-fg scroll-fade">
      <div className="mx-auto w-full max-w-[480px] px-6 pb-10 pt-10 sm:px-8">
        <h2 className="text-[17px] font-semibold tracking-tight">
          {queue.finished ? RUN_TITLES[queue.run][1] : RUN_TITLES[queue.run][0]} · {settled} of {queue.items.length}
        </h2>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-pane-2 shadow-[inset_0_0_0_1px_var(--pane-border)]">
          <motion.div className="h-full rounded-full bg-accent" initial={false} animate={{ width: `${(settled / queue.items.length) * 100}%` }} transition={spring.moderate} />
        </div>
        {pages.length && queue.finished ? (
          <p className="mt-4 text-[12.5px] text-pane-muted">
            {plural(pages.length, "sender")} {pages.length === 1 ? "takes" : "take"} unsubscribes only on their own page. Open each to finish; Kite doesn&apos;t visit them for you.
          </p>
        ) : null}
        <ul className="mt-4 overflow-hidden rounded-xl border border-pane-border" data-sensitive>
          {queue.items.map((item) => (
            <li key={item.email} className="flex items-center gap-2.5 border-b border-pane-border px-3 py-2.5 text-[12.5px] last:border-b-0">
              <span className="grid size-4 shrink-0 place-items-center text-pane-muted">
                {item.state === "running" ? (
                  <Spinner size={14} />
                ) : item.state === "done" ? (
                  <Icon icon={Tick02Icon} size={15} className="text-success" />
                ) : item.state === "failed" ? (
                  <Icon icon={Alert02Icon} size={14} className="text-warning" />
                ) : item.state === "skipped" ? (
                  <Icon icon={Cancel01Icon} size={13} />
                ) : (
                  <span className="size-1.5 rounded-full bg-pane-muted/50" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.name}</span>
                {item.note ? <span className="block truncate text-pane-muted">{item.note}</span> : null}
              </span>
              {item.url ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex shrink-0 items-center gap-1 rounded-full border border-pane-border px-2.5 py-1 text-[12px] font-medium hover:bg-pane-hover"
                >
                  Open page
                  <Icon icon={LinkSquare02Icon} size={12} />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          {queue.finished ? (
            <button onClick={cleanup.closeQueue} className="h-9 rounded-full bg-pane-fg px-5 text-[13px] font-medium text-pane hover:opacity-90">
              Done
            </button>
          ) : (
            <button onClick={cleanup.stopQueue} className="h-9 rounded-full border border-pane-border px-5 text-[13px] font-medium hover:bg-pane-hover">
              Stop after this one
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
