"use client";

import { useMemo } from "react";
import { inScope } from "@/lib/mail/scope";
import { inView, scopedThreads, type MailState } from "@/lib/mail/store";
import type { Mailbox } from "@/lib/mail/types";
import { sideOf, type InboxSide } from "@/lib/mail/sides";
import type { FirstSync, FirstSyncs } from "../first-sync";
import type { SyncInfo } from "./util";

/**
 * The numbers around the list: sidebar counts, unread per account, inbox tab counts, sync status
 * and first-sync progress. Each comes back as the same object while its numbers are the same, so
 * the memoised sidebar, tabs and list don't re-render on a reload.
 */
/** No accounts (a stable empty list for the memoised sidebar). */
const NO_IDS: string[] = [];

export function useCounts({ live, state, serverCounts, sync }: { live: boolean; state: MailState; serverCounts: Partial<Record<Mailbox, number>>; sync: SyncInfo }) {
  // Live counts come from the server; only demo mail counts the threads (so opening a thread
  // doesn't hand the memoised sidebar new objects).
  const demoThreads = live ? null : state.threads;
  const countsNow = useMemo(() => {
    const scoped = (demoThreads ?? []).filter((t) => inScope(state.accountId, t.accountId));
    const mailbox: Partial<Record<Mailbox, number>> = live
      ? serverCounts
      : {
          inbox: scoped.filter((t) => t.mailbox === "inbox" && t.unread).length,
          screener: scoped.filter((t) => t.mailbox === "screener").length,
          starred: scoped.filter((t) => inView(t, { kind: "mailbox", mailbox: "starred" })).length,
          snoozed: scoped.filter((t) => t.mailbox === "snoozed").length,
          drafts: scoped.filter((t) => t.mailbox === "drafts").length,
        };
    return { mailbox };
  }, [demoThreads, state.accountId, live, serverCounts]);
  // Reloads bring equal numbers in new objects: keep the old ones so the sidebar doesn't re-render.
  const countsKey = JSON.stringify(countsNow);
  const counts = useMemo(() => JSON.parse(countsKey) as typeof countsNow, [countsKey]);

  /** Unread inbox per account, for the account switcher. */
  const accountUnreadNow = useMemo(() => {
    if (live) return Object.fromEntries(Object.entries(sync).map(([id, s]) => [id, s.unread ?? 0]));
    const unread: Record<string, number> = {};
    for (const t of demoThreads ?? []) if (t.mailbox === "inbox" && t.unread) unread[t.accountId] = (unread[t.accountId] ?? 0) + 1;
    return unread;
  }, [live, sync, demoThreads]);
  const accountUnreadKey = JSON.stringify(accountUnreadNow);
  const accountUnread = useMemo(() => JSON.parse(accountUnreadKey) as Record<string, number>, [accountUnreadKey]);

  // Only what the counts read: typing and moving the selection don't redo them.
  const { threads: allThreads, overrides, accountId: scopeAccount, remote: serverScoped } = state;
  // Unread per inbox tab, and which tabs have any mail (only those show: lib/mail/sides.ts).
  const { sideCountsNow, presentNow } = useMemo(() => {
    const inbox = scopedThreads({ threads: allThreads, overrides, accountId: scopeAccount, remote: serverScoped, listQuery: "", query: "", view: { kind: "mailbox", mailbox: "inbox" }, side: "important", selectedId: null, unseen: null, spaces: [] });
    const counts: Record<InboxSide, number> = { important: 0, newsletters: 0, other: 0, notifications: 0 };
    const present = new Set<InboxSide>();
    for (const t of inbox) {
      present.add(sideOf(t));
      if (t.unread) counts[sideOf(t)]++;
    }
    return { sideCountsNow: counts, presentNow: [...present].sort().join(",") };
  }, [allThreads, overrides, scopeAccount, serverScoped]);
  // Same numbers, same object: the tabs (a layoutId pill) re-render only when a count changes.
  const sideCountsKey = JSON.stringify(sideCountsNow);
  const sideCounts = useMemo(() => JSON.parse(sideCountsKey) as Record<InboxSide, number>, [sideCountsKey]);

  const syncLabel = useMemo(() => {
    if (!live) return null;
    const entries = Object.values(sync);
    if (!entries.length) return null;
    if (entries.some((e) => e.reconnect)) return "Reconnect needed";
    const progress = entries.find((e) => e.progress)?.progress;
    if (progress) return `Syncing ${progress.done} of ${progress.total}`;
    if (entries.some((e) => !e.ready)) return "Syncing…";
    return `Up to date · ${entries.reduce((n, e) => n + e.stored, 0)} offline`;
  }, [live, sync]);

  // Accounts that need signing in again, joined so the memoised sidebar re-renders only when it changes.
  const reconnectKey = useMemo(
    () =>
      Object.entries(sync)
        .filter(([, e]) => e.reconnect)
        .map(([id]) => id)
        .join(","),
    [sync],
  );
  const reconnecting = useMemo(() => (reconnectKey ? reconnectKey.split(",") : NO_IDS), [reconnectKey]);

  // An account in view still on its first sync: the list shows how far it is instead of "All caught up".
  // Kept as a string so the memoised list re-renders only when the numbers change.
  const firstSyncKey = useMemo(() => {
    if (!live) return "";
    const entries = Object.entries(sync).filter(([id, e]) => inScope(scopeAccount, id) && !e.ready && !e.reconnect);
    if (!entries.length) return "";
    const known = entries.every(([, e]) => e.progress);
    return JSON.stringify({
      done: entries.reduce((n, [, e]) => n + (e.progress?.done ?? 0), 0),
      total: known ? entries.reduce((n, [, e]) => n + (e.progress?.total ?? 0), 0) : null,
    });
  }, [live, sync, scopeAccount]);
  const firstSync = useMemo(() => (firstSyncKey ? (JSON.parse(firstSyncKey) as FirstSync) : null), [firstSyncKey]);
  // Every account on its first sync, in or out of view, with its own numbers (sidebar faces, Settings → Accounts).
  const syncingKey = live
    ? JSON.stringify(
        Object.fromEntries(
          Object.entries(sync)
            .filter(([, e]) => !e.ready && !e.reconnect)
            .map(([id, e]) => [id, { done: e.progress?.done ?? 0, total: e.progress?.total ?? null }]),
        ),
      )
    : "{}";
  const syncingIds = useMemo(() => Object.keys(JSON.parse(syncingKey)), [syncingKey]);
  const firstSyncs = useMemo<FirstSyncs>(() => ({ inView: firstSync, accounts: JSON.parse(syncingKey) }), [firstSync, syncingKey]);

  return { counts, accountUnread, sideCounts, presentSides: presentNow, syncLabel, firstSync, syncingIds, firstSyncs, reconnecting };
}
