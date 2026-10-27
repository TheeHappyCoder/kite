"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { patchOverride, withoutOverride, type OverridePatch, type ThreadOverride } from "@/lib/mail/overrides";
import { shownThread, type MailAction, type MailState } from "@/lib/mail/store";
import { threadKey } from "@/lib/mail/threads";
import type { Account, Thread } from "@/lib/mail/types";
import type { BulkAction } from "../bulk-panel";
import { postJson, tomorrowMorning, type Reload, type SetToast, type ThreadOp, type Toast } from "./util";

export type Checked = { key: string; ids: string[]; anchor: string | null };
const NO_CHECKED: Checked = { key: "", ids: [], anchor: null };

/**
 * What the user does to conversations: open, archive, delete, spam, snooze, star, read, the
 * Screener's allow / block, bulk select, local pin / mute / rename / note, and Undo. Changes show
 * at once, then go to the provider (live accounts).
 */
export function useThreadActions({
  live,
  state,
  dispatch,
  threads,
  listKey,
  listVisible,
  accounts,
  serviceOf,
  setToast,
  reload,
}: {
  live: boolean;
  state: MailState;
  dispatch: React.Dispatch<MailAction>;
  /** The list as shown. */
  threads: Thread[];
  listKey: string;
  listVisible: boolean;
  accounts: Account[];
  serviceOf: (accountIds: string[]) => string;
  setToast: SetToast;
  reload: Reload;
}) {
  // Bulk select: ticked threads belong to one list and drop out when they leave it.
  const [checked, setChecked] = useState<Checked>(NO_CHECKED);
  const checkedSet = useMemo(() => {
    if (checked.key !== listKey || !listVisible) return new Set<string>();
    const visible = new Set(threads.map((t) => t.id));
    return new Set(checked.ids.filter((id) => visible.has(id)));
  }, [checked, listKey, listVisible, threads]);
  const checkedThreads = useMemo(() => threads.filter((t) => checkedSet.has(t.id)), [threads, checkedSet]);
  const selecting = checkedSet.size > 0;
  const clearChecked = useCallback(() => setChecked(NO_CHECKED), []);

  const overridesRef = useRef(state.overrides);
  useEffect(() => {
    overridesRef.current = state.overrides;
  }, [state.overrides]);
  /** Changes a thread's local state (never the provider): applied at once, then saved. */
  const setOverride = useCallback(
    (id: string, patch: OverridePatch, failure = "Kite couldn't save that change. Try again.") => {
      const before = overridesRef.current[id];
      dispatch({ type: "override", id, override: patchOverride(before, patch) });
      return postJson<{ override: ThreadOverride | null }>("/api/thread-overrides", { threadId: id, ...patch })
        .then((res) => dispatch({ type: "override", id, override: res.override }))
        .catch(() => {
          dispatch({ type: "override", id, override: before ?? null });
          setToast({ message: failure });
        });
    },
    [dispatch, setToast],
  );

  const remote = useCallback(
    (thread: Thread, op: ThreadOp, until?: string) => {
      if (!live || !thread.remoteId) return;
      postJson(`/api/mail/threads/${threadKey(thread)}`, { account: thread.accountId, op, until }).catch(() => {
        setToast({ message: `${serviceOf([thread.accountId])} didn't accept that change. Refreshing.` });
        reload();
      });
    },
    [live, serviceOf, setToast, reload],
  );

  /** One operation on many threads in a single request (bulk select and its undo). */
  const remoteMany = useCallback(
    (list: Thread[], op: ThreadOp, until?: string) => {
      const items = live ? list.filter((t) => t.remoteId).map((t) => ({ account: t.accountId, id: threadKey(t) })) : [];
      if (!items.length) return;
      postJson<{ done: number; failed: number }>("/api/mail/threads", { op, until, threads: items })
        .then((res) => {
          if (!res.failed) return;
          setToast({ message: `${serviceOf(list.map((t) => t.accountId))} didn't accept ${res.failed} of those changes. Refreshing.` });
          reload();
        })
        .catch(() => {
          setToast({ message: `${serviceOf(list.map((t) => t.accountId))} didn't accept that change. Refreshing.` });
          reload();
        });
    },
    [live, serviceOf, setToast, reload],
  );

  const selectThread = useCallback(
    (id: string | null) => {
      const thread = id ? state.threads.find((t) => t.id === id) : null;
      if (thread?.unread) remote(thread, "read");
      dispatch({ type: "select", id });
    },
    [state.threads, remote, dispatch],
  );

  /** Takes a thread out of the current view (the selection moves to its neighbour); returns it as it was, or null. */
  const takeOut = useCallback(
    (id: string | undefined, patch: Partial<Thread>, ops?: [ThreadOp, ThreadOp], until?: string) => {
      if (!id) return null;
      const thread = state.threads.find((t) => t.id === id);
      if (!thread || thread.scheduled) return null;
      const index = threads.findIndex((t) => t.id === id);
      const neighbour = threads[index + 1] ?? threads[index - 1];
      dispatch({ type: "patch", id, patch });
      if (state.selectedId === id) selectThread(neighbour?.id ?? null);
      if (ops) remote(thread, ops[0], until);
      return thread;
    },
    [state.threads, state.selectedId, threads, remote, selectThread, dispatch],
  );

  /** Moves a thread out of the current view, keeping the selection on its neighbour, with Undo. */
  const moveThread = useCallback(
    (id: string | undefined, patch: Partial<Thread>, message: string, ops?: [ThreadOp, ThreadOp], until?: string) => {
      const thread = takeOut(id, patch, ops, until);
      if (thread) setToast({ message, undo: [thread], undoOp: ops?.[1] });
    },
    [takeOut, setToast],
  );

  /**
   * Archives a conversation without a toast of its own (Send and archive says so in the send's
   * toast). Returns what puts it back, or null when there was nothing to archive.
   */
  const archiveQuietly = useCallback(
    (id: string) => {
      const thread = takeOut(id, { mailbox: "archive", reminder: undefined }, ["archive", "unarchive"]);
      if (!thread) return null;
      return () => {
        dispatch({ type: "patch", id: thread.id, patch: withoutOverride(thread) });
        remoteMany([thread], "unarchive");
      };
    },
    [takeOut, dispatch, remoteMany],
  );

  const senderAction = useCallback(
    (id: string, action: "allow" | "block") => {
      const thread = state.threads.find((t) => t.id === id);
      const account = accounts.find((a) => a.id === thread?.accountId);
      const sender = thread?.messages.find((m) => m.from.email !== account?.email && m.from.name !== "You")?.from;
      if (!thread || !sender) return;
      const index = threads.findIndex((t) => t.id === id);
      const neighbour = threads[index + 1] ?? threads[index - 1];
      dispatch({ type: "patch", id, patch: { mailbox: action === "allow" ? "inbox" : "archive" } });
      if (state.selectedId === id) selectThread(neighbour?.id ?? null);
      if (!live) {
        setToast({ message: action === "allow" ? `${sender.name} can now reach your inbox` : `${sender.name} is blocked` });
        return;
      }
      postJson<{ archived?: number }>("/api/senders", { email: sender.email, action })
        .then((res) =>
          setToast({
            message: action === "allow" ? `${sender.name} can now reach your inbox` : `${sender.name} is blocked${res.archived ? `, ${res.archived} archived` : ""}`,
          }),
        )
        .catch(() => setToast({ message: "That didn't go through. Try again." }));
    },
    [state.threads, state.selectedId, threads, accounts, live, selectThread, dispatch, setToast],
  );

  const actions = useMemo(
    () => ({
      archive: (id = state.selectedId ?? undefined) => moveThread(id, { mailbox: "archive", reminder: undefined }, "Archived", ["archive", "unarchive"]),
      remove: (id = state.selectedId ?? undefined) => moveThread(id, { mailbox: "archive" }, "Moved to trash", ["trash", "untrash"]),
      spam: (id = state.selectedId ?? undefined) => moveThread(id, { mailbox: "archive" }, "Reported as spam", ["spam", "unspam"]),
      snooze: (id = state.selectedId ?? undefined) => {
        const until = tomorrowMorning();
        moveThread(id, { mailbox: "snoozed", snoozedUntil: until }, "Snoozed until tomorrow 08:00", ["snooze", "unsnooze"], until);
      },
      allow: (id: string) => senderAction(id, "allow"),
      block: (id: string) => senderAction(id, "block"),
      star: (id = state.selectedId ?? undefined) => {
        const thread = state.threads.find((t) => t.id === id);
        if (!thread || thread.scheduled) return;
        dispatch({ type: "patch", id: thread.id, patch: { starred: !thread.starred } });
        remote(thread, thread.starred ? "unstar" : "star");
      },
      toggleRead: (id = state.selectedId ?? undefined) => {
        const thread = state.threads.find((t) => t.id === id);
        if (!thread || thread.scheduled) return;
        dispatch({ type: "patch", id: thread.id, patch: { unread: !thread.unread } });
        remote(thread, thread.unread ? "read" : "unread");
      },
    }),
    [moveThread, senderAction, state.selectedId, state.threads, remote, dispatch],
  );

  /** Ticks a thread, or (shift) every thread between the anchor and it. */
  const check = useCallback(
    (id: string, mode: "toggle" | "range") => {
      setChecked((current) => {
        const ids = current.key === listKey ? current.ids : [];
        const anchor = (current.key === listKey ? current.anchor : null) ?? state.selectedId;
        const from = threads.findIndex((t) => t.id === anchor);
        const to = threads.findIndex((t) => t.id === id);
        if (mode === "range" && from >= 0 && to >= 0) {
          const range = threads.slice(Math.min(from, to), Math.max(from, to) + 1).map((t) => t.id);
          return { key: listKey, ids: [...new Set([...ids, ...range])], anchor };
        }
        return { key: listKey, ids: ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id], anchor: id };
      });
    },
    [listKey, threads, state.selectedId],
  );

  /** Leaves bulk select; the thread under the cursor opens (and is marked read) as usual. */
  const clearSelection = useCallback(() => {
    setChecked(NO_CHECKED);
    if (state.selectedId) selectThread(state.selectedId);
  }, [state.selectedId, selectThread]);

  /** Bulk actions on the ticked threads; `label` and `merge` go to the picker and the merge (given here). */
  const bulkWith = useCallback(
    (action: BulkAction, others: { label: (list: Thread[]) => void; merge: (list: Thread[]) => void }) => {
      const targets = checkedThreads.filter((t) => !t.scheduled);
      if (!targets.length) return;
      const count = (n: number) => `${n} ${n === 1 ? "conversation" : "conversations"}`;
      if (action === "label") {
        others.label(targets);
        return;
      }
      if (action === "merge") {
        others.merge(targets);
        return;
      }

      if (action === "star" || action === "read") {
        // Star all unless all are starred; mark all read unless none are unread. Only changed threads are undone.
        const on = action === "star" ? !targets.every((t) => t.starred) : targets.some((t) => t.unread);
        const changed = targets.filter((t) => (action === "star" ? t.starred !== on : t.unread === on));
        const ops: [ThreadOp, ThreadOp] = action === "star" ? (on ? ["star", "unstar"] : ["unstar", "star"]) : on ? ["read", "unread"] : ["unread", "read"];
        const patch: Partial<Thread> = action === "star" ? { starred: on } : { unread: !on };
        changed.forEach((t) => dispatch({ type: "patch", id: t.id, patch }));
        remoteMany(changed, ops[0]);
        const verb = action === "star" ? (on ? "Starred" : "Unstarred") : on ? "Marked read:" : "Marked unread:";
        setToast({ message: `${verb} ${count(changed.length)}`, undo: changed, undoOp: ops[1] });
        return;
      }

      const until = action === "snooze" ? tomorrowMorning() : undefined;
      const moves: Record<typeof action, { patch: Partial<Thread>; ops: [ThreadOp, ThreadOp]; message: string }> = {
        archive: { patch: { mailbox: "archive", reminder: undefined }, ops: ["archive", "unarchive"], message: `Archived ${count(targets.length)}` },
        delete: { patch: { mailbox: "archive" }, ops: ["trash", "untrash"], message: `Moved ${count(targets.length)} to trash` },
        spam: { patch: { mailbox: "archive" }, ops: ["spam", "unspam"], message: `Reported ${count(targets.length)} as spam` },
        snooze: { patch: { mailbox: "snoozed", snoozedUntil: until }, ops: ["snooze", "unsnooze"], message: `Snoozed ${count(targets.length)} until tomorrow 08:00` },
      };
      const move = moves[action];
      const ids = new Set(targets.map((t) => t.id));
      const last = Math.max(...targets.map((t) => threads.indexOf(t)));
      const neighbour = threads.slice(last + 1).find((t) => !ids.has(t.id)) ?? threads.slice(0, last).reverse().find((t) => !ids.has(t.id));
      targets.forEach((t) => dispatch({ type: "patch", id: t.id, patch: move.patch }));
      setChecked(NO_CHECKED);
      const cursor = state.selectedId && !ids.has(state.selectedId) ? state.selectedId : (neighbour?.id ?? null);
      selectThread(cursor);
      remoteMany(targets, move.ops[0], until);
      setToast({ message: move.message, undo: targets, undoOp: move.ops[1] });
    },
    [checkedThreads, threads, state.selectedId, remoteMany, selectThread, dispatch, setToast],
  );

  /** The toast's Undo (and `z`). */
  const undoToast = (toast: Toast | null) => {
    if (toast?.onUndo) toast.onUndo();
    toast?.undo?.forEach((thread) => dispatch({ type: "patch", id: thread.id, patch: withoutOverride(thread) }));
    if (toast?.undo && toast.undoOp) remoteMany(toast.undo, toast.undoOp);
    if (toast?.undo?.[0]) dispatch({ type: "select", id: toast.undo[0].id });
    setToast(null);
  };

  /** Pin, mute or rename one conversation (local only), with Undo. */
  const overrideWithUndo = useCallback(
    (id: string, patch: OverridePatch, undo: OverridePatch, message: string) => {
      void setOverride(id, patch);
      setToast({ message, onUndo: () => void setOverride(id, undo) });
    },
    [setOverride, setToast],
  );
  const shownById = useCallback((id?: string | null) => (id ? shownThread(state, id) : null), [state]);
  const togglePin = useCallback(
    (id = state.selectedId) => {
      const thread = shownById(id);
      if (!thread || thread.scheduled) return;
      const pinned = !thread.pinned;
      overrideWithUndo(thread.id, { pinned }, { pinned: !pinned }, pinned ? "Pinned to the top" : "Unpinned");
    },
    [state.selectedId, shownById, overrideWithUndo],
  );
  const toggleMute = useCallback(
    (id = state.selectedId) => {
      const thread = shownById(id);
      if (!thread || thread.scheduled) return;
      const muted = !thread.muted;
      overrideWithUndo(thread.id, { muted }, { muted: !muted }, muted ? "Muted. New replies skip your inbox" : "Unmuted");
    },
    [state.selectedId, shownById, overrideWithUndo],
  );

  return {
    checked,
    setChecked,
    checkedSet,
    checkedThreads,
    selecting,
    clearChecked,
    setOverride,
    remoteMany,
    selectThread,
    moveThread,
    archiveQuietly,
    senderAction,
    actions,
    check,
    clearSelection,
    bulkWith,
    undoToast,
    overrideWithUndo,
    togglePin,
    toggleMute,
  };
}
