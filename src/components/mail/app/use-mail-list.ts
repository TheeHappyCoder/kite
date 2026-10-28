"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { MailAction, MailState } from "@/lib/mail/store";
import type { Mailbox, Thread } from "@/lib/mail/types";
import { sideOf } from "@/lib/mail/sides";
import { mailChanges } from "@/lib/mail/pending-changes";
import { postJson } from "./util";
import type { TodayTarget } from "../../home/day";
import type { RemoteSearch } from "../message-list";
import { useDebounced, withRemoteResults, type ListResponse, type Reload, type SetToast, type SyncInfo } from "./util";

/**
 * Live mode's list: the current mailbox, label or search read from the local store (debounced
 * while typing), the sync status and counts that come with it, "Search older mail" at the
 * provider, and conversations to open once the list that holds them arrives.
 */
export function useMailList({
  live,
  state,
  dispatch,
  reloadKey,
  reload,
  setToast,
}: {
  live: boolean;
  state: MailState;
  dispatch: React.Dispatch<MailAction>;
  reloadKey: number;
  reload: Reload;
  setToast: SetToast;
}) {
  const [page, setPage] = useState<{ key: string; next: number | null }>({ key: "", next: null });
  const [paging, setPaging] = useState(false);
  const activeKey = useRef("");
  const [doneKey, setDoneKey] = useState("");
  const [sync, setSync] = useState<SyncInfo>({});
  const [serverCounts, setServerCounts] = useState<Partial<Record<Mailbox, number>>>({});
  const query = useDebounced(state.query, 150);
  const [remoteSearch, setRemoteSearch] = useState<RemoteSearch | null>(null);
  /** Threads the provider found for a search, kept so list reloads don't drop them. */
  const remoteFound = useRef<{ query: string; threads: Thread[] }>({ query: "", threads: [] });

  /** What the list loads: a mailbox, or one account's label/folder. */
  const listSource =
    state.view.kind === "mailbox"
      ? `mailbox=${state.view.mailbox}&account=${state.accountId}`
      : // Home sorts the inbox: its conversations open in place.
        state.view.kind === "home"
        ? `mailbox=inbox&account=${state.accountId}`
      : state.view.kind === "label"
        ? `mailbox=label&label=${encodeURIComponent(state.view.labelId)}&account=${state.view.accountId}`
      : state.view.kind === "space"
        ? `mailbox=space&space=${encodeURIComponent(state.view.spaceId)}&account=${state.accountId}`
        : null;
  const viewKey = `${listSource}:${state.accountId}:${query}`;
  const requestKey = `${viewKey}:${reloadKey}`;
  const trash = state.view.kind === "mailbox" && state.view.mailbox === "trash";
  useEffect(() => {
    if (!live || !trash) return;
    void postJson("/api/mail/batch", { kind: "refresh", account: state.accountId })
      .then(reload)
      .catch(() => setToast({ message: "Couldn't refresh Trash. Showing the local copy; try Refresh." }));
  }, [live, trash, state.accountId, reload, setToast]);
  // The search box is debounced: a query not yet sent counts as loading too.
  const loading = live && listSource != null && (!doneKey.startsWith(`${viewKey}:`) || state.query.trim() !== query.trim());

  /**
   * Opened once the list reloads (a conversation a split or merge just made). With `query`,
   * only a list loaded for that search counts.
   */
  const pendingSelect = useRef<{ id: string; query?: string } | null>(null);

  /**
   * Opens a conversation from Today. It may not be in the current list: live mode loads its
   * mailbox (snoozed, scheduled) or searches for its subject, then selects it when it arrives.
   */
  const openFromToday = useCallback(
    (target: TodayTarget) => {
      if (!live) {
        const thread = state.threads.find((t) => t.id === target.threadId);
        if (!thread) return;
        dispatch({ type: "view", view: { kind: "mailbox", mailbox: thread.mailbox } });
        dispatch({ type: "query", query: "" });
        if (thread.mailbox === "inbox") dispatch({ type: "side", side: sideOf(thread) });
        dispatch({ type: "select", id: thread.id });
        return;
      }
      const query = target.mailbox ? "" : `subject:"${target.subject.replace(/"/g, " ").trim()}"`;
      // The view change drops the old list, so nothing from it is opened while the new one loads.
      dispatch({ type: "view", view: { kind: "mailbox", mailbox: target.mailbox ?? "inbox" } });
      dispatch({ type: "query", query });
      pendingSelect.current = { id: target.threadId, query };
      // Already showing that list: read it again so the pending pick is found.
      reload();
    },
    [live, state.threads, dispatch, reload],
  );

  // Live mode: read the current mailbox (or search results) from the local store.
  useEffect(() => {
    activeKey.current = requestKey;
    if (!live || !listSource) return;
    const controller = new AbortController();
    const current = mailChanges.snapshot();
    const q = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : "";
    fetch(`/api/mail/threads?${listSource}${q}`, { signal: controller.signal })
      .then(async (res) => {
        const data = (await res.json()) as ListResponse;
        if (!res.ok || !data.threads) throw new Error(data.error ?? "Couldn't load mail");
        if (controller.signal.aborted || !current()) return;
        setPage({ key: viewKey, next: data.nextOffset ?? null });
        const found = remoteFound.current;
        const searching = query.trim();
        dispatch({ type: "replace", threads: searching && found.query === searching ? withRemoteResults(data.threads, found.threads) : data.threads, listQuery: searching });
        // A pending pick waits for the list it searched for (the search box is debounced).
        const pending = pendingSelect.current;
        if (pending && (pending.query === undefined || pending.query === query.trim())) {
          if (data.threads.some((t) => t.id === pending.id)) dispatch({ type: "select", id: pending.id });
          pendingSelect.current = null;
        }
        if (data.sync) setSync(data.sync);
        if (data.counts) setServerCounts(data.counts);
      })
      .catch((error: Error) => {
        if (error.name !== "AbortError") setToast({ message: error.message });
      })
      .finally(() => {
        if (!controller.signal.aborted) setDoneKey(requestKey);
      });
    return () => controller.abort();
  }, [live, listSource, state.accountId, query, requestKey, viewKey, dispatch, setToast]);

  /** "Search older mail": runs the search at the provider(s) and adds what they find to the list. */
  const searchRemote = useCallback(async () => {
    const q = state.query.trim();
    if (!live || !q) return;
    const current = mailChanges.snapshot();
    setRemoteSearch({ query: q, status: "loading", found: 0 });
    try {
      const res = await fetch(`/api/mail/search?q=${encodeURIComponent(q)}&account=${state.accountId}`);
      const data = (await res.json()) as { threads?: Thread[]; error?: string };
      if (!res.ok || !data.threads) throw new Error(data.error);
      if (!current()) {
        setRemoteSearch(null);
        return;
      }
      const before = new Set(state.threads.map((t) => t.id));
      remoteFound.current = { query: q, threads: data.threads };
      dispatch({ type: "replace", threads: withRemoteResults(state.threads, data.threads) });
      setRemoteSearch({ query: q, status: "done", found: data.threads.filter((t) => !before.has(t.id)).length });
    } catch {
      setRemoteSearch({ query: q, status: "error", found: 0 });
    }
  }, [live, state.query, state.accountId, state.threads, dispatch]);

  const loadMore = async () => {
    if (paging || page.key !== viewKey || page.next == null) return;
    const key = requestKey;
    const current = mailChanges.snapshot();
    setPaging(true);
    try {
      const res = await fetch(`/api/mail/threads?${listSource}&q=${encodeURIComponent(query.trim())}&offset=${page.next}`);
      const data = await res.json() as ListResponse;
      if (!res.ok || !data.threads) throw new Error(data.error ?? "Could not load more results.");
      if (activeKey.current !== key || !current()) return;
      dispatch({ type: "replace", threads: withRemoteResults(state.threads, data.threads), listQuery: query.trim() });
      setPage({ key: viewKey, next: data.nextOffset ?? null });
    } catch (error) { setToast({ message: error instanceof Error ? error.message : "Could not load more results." }); }
    finally { setPaging(false); }
  };
  return { loadMore, paging, hasMore: page.key === viewKey && page.next != null, query, loading, sync, serverCounts, pendingSelect, openFromToday, remoteSearch, searchRemote };
}
