"use client";

import { fetchJson } from "@/lib/fetch-json";
import { useEffect, useMemo, useRef, useState } from "react";
import { inFilter, sortSenders, type CleanupFilter, type CleanupSort, type SenderDetail, type SenderSummary } from "@/lib/mail/cleanup";
import type { MailBatchRequest } from "@/lib/mail/batch";
import { plural } from "@/lib/format";

// Cleanup: who fills your mailbox, from the local copy only (lib/mail/cleanup.ts). The user ticks
// senders and picks what happens; Kite never decides who goes. Work runs as a queue, one sender at
// a time, and every archive it makes has Undo.

type Toast = { message: string; onUndo?: () => void };

/** What a queue does to each sender: unsubscribe, or block (which archives too). Archive and Trash go through mail-batch-dialog. */
export type Run = "block" | "unsubscribe";

type QueueItem = { email: string; name: string; state: "waiting" | "running" | "done" | "failed" | "skipped"; note?: string; url?: string };

export type Queue = { run: Run; items: QueueItem[]; finished: boolean };

type UnsubscribeResult = { method: "one-click" | "email" | "website" | "none"; done: boolean; url?: string };

const post = <T,>(body: unknown, url = "/api/senders", method = "POST") => fetchJson<T>(url, method, body);

export const nameOf = (s: Pick<SenderSummary, "name" | "email">) => s.name || s.email;

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

export const FILTER_ORDER: CleanupFilter[] = ["inbox", "never", "volume", "newsletters", "still", "all", "kept"];
