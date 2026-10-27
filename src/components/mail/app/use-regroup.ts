"use client";

import { useCallback, useRef } from "react";
import type { MailAction } from "@/lib/mail/store";
import { threadKey } from "@/lib/mail/threads";
import type { Regroup, Thread } from "@/lib/mail/types";
import { postJson, type Reload, type SetToast } from "./util";

/**
 * Local split / merge / undo (the provider's threading is untouched). Live mode asks the server
 * and opens the result once the list reloads; demo mode rewrites the list on the page and keeps
 * how to put each change back.
 */
export function useRegroup({
  live,
  threads,
  selectedId,
  selected,
  dispatch,
  setToast,
  reload,
  pendingSelect,
  clearChecked,
}: {
  live: boolean;
  /** Every thread in the store (not just the list). */
  threads: Thread[];
  selectedId: string | null;
  /** The open conversation as shown (overrides applied). */
  selected: Thread | null;
  dispatch: React.Dispatch<MailAction>;
  setToast: SetToast;
  reload: Reload;
  pendingSelect: React.RefObject<{ id: string; query?: string } | null>;
  clearChecked: () => void;
}) {
  /** Demo mode keeps how to put each split or merge back. */
  const demoUndo = useRef(new Map<string, () => void>());

  /** Puts splits or merges back (the toast's Undo, or the reader's Undo/Restore). */
  const undoRegroups = useCallback(
    (ids: string[], select: string) => {
      if (!live) {
        ids.forEach((id) => demoUndo.current.get(id)?.());
        dispatch({ type: "select", id: select });
        return;
      }
      postJson("/api/mail/regroup", { action: "undo", regroups: ids })
        .then(() => {
          pendingSelect.current = { id: select };
          reload();
        })
        .catch((error: Error) => setToast({ message: error.message === "Request failed" ? "That couldn't be put back. Try again." : error.message }));
    },
    [live, dispatch, pendingSelect, reload, setToast],
  );

  /** Detaches a message (and, with `following`, the ones after it) into its own conversation. Gmail is untouched. */
  const splitThread = useCallback(
    (messageId: string, following: boolean) => {
      const source = threads.find((t) => t.id === selectedId);
      if (!source || !selected) return;
      const index = source.messages.findIndex((m) => m.id === messageId);
      const moved = following ? source.messages.slice(index) : source.messages.slice(index, index + 1);
      if (index < 0 || moved.length === source.messages.length) return;
      const message = following && moved.length > 1 ? `Split ${moved.length} messages into a new conversation` : "Split into a new conversation";
      if (!live || !source.remoteId) {
        const id = `${source.id}~${messageId}`;
        const regroup: Regroup = { id: crypto.randomUUID(), kind: "split", sourceId: source.id, sourceSubject: selected.subject, createdAt: new Date().toISOString() };
        const ids = new Set(moved.map((m) => m.id));
        const split: Thread = { ...source, id, messages: moved, unread: moved.some((m) => m.unread), regroup };
        dispatch({
          type: "rewrite",
          update: (threads) => [...threads.map((t) => (t.id === source.id ? { ...t, messages: t.messages.filter((m) => !ids.has(m.id)) } : t)), split],
        });
        demoUndo.current.set(regroup.id, () =>
          dispatch({
            type: "rewrite",
            update: (threads) => {
              const back = threads.find((t) => t.id === id)?.messages ?? moved;
              return threads
                .filter((t) => t.id !== id)
                .map((t) => (t.id === source.id ? { ...t, messages: [...t.messages, ...back].sort((a, b) => a.date.localeCompare(b.date)) } : t));
            },
          }),
        );
        dispatch({ type: "select", id });
        setToast({ message, onUndo: () => undoRegroups([regroup.id], source.id) });
        return;
      }
      postJson<{ regroupIds: string[]; threadId: string }>("/api/mail/regroup", {
        action: "split",
        account: source.accountId,
        thread: threadKey(source),
        message: messageId,
        following,
      })
        .then((res) => {
          pendingSelect.current = { id: res.threadId };
          reload();
          setToast({ message, onUndo: () => undoRegroups(res.regroupIds, source.id) });
        })
        .catch((error: Error) => setToast({ message: error.message === "Request failed" ? "That conversation couldn't be split. Try again." : error.message }));
    },
    [threads, selectedId, selected, live, undoRegroups, dispatch, pendingSelect, reload, setToast],
  );

  /** Joins conversations into the oldest one (same account). Gmail is untouched; their future replies land together. */
  const mergeThreads = useCallback(
    (list: Thread[]) => {
      const threadsToMerge = list.filter((t) => !t.scheduled);
      if (threadsToMerge.length < 2) return;
      if (new Set(threadsToMerge.map((t) => t.accountId)).size > 1) {
        setToast({ message: "Only conversations in the same account can be merged." });
        return;
      }
      const firstDate = (t: Thread) => t.messages[0]?.date ?? "";
      const [target, ...others] = [...threadsToMerge].sort((a, b) => firstDate(a).localeCompare(firstDate(b)));
      const message = `Merged ${threadsToMerge.length} conversations`;
      clearChecked();
      if (!live || !target.remoteId) {
        const raw = (id: string) => threads.find((t) => t.id === id)!;
        const kept = raw(target.id);
        const joined = others.map((o) => raw(o.id));
        const ids = new Map(joined.map((j) => [j.id, new Set(j.messages.map((m) => m.id))]));
        const regroups: Regroup[] = joined.map((j) => ({
          id: crypto.randomUUID(),
          kind: "merge",
          sourceId: j.id,
          sourceSubject: others.find((o) => o.id === j.id)?.subject ?? j.subject,
          createdAt: new Date().toISOString(),
        }));
        dispatch({
          type: "rewrite",
          update: (threads) =>
            threads
              .filter((t) => !ids.has(t.id))
              .map((t) =>
                t.id === kept.id
                  ? {
                      ...t,
                      messages: [...t.messages, ...joined.flatMap((j) => j.messages)].sort((a, b) => a.date.localeCompare(b.date)),
                      unread: t.unread || joined.some((j) => j.unread),
                      starred: t.starred || joined.some((j) => j.starred),
                      regroup: regroups[regroups.length - 1],
                    }
                  : t,
              ),
        });
        regroups.forEach((regroup, i) =>
          demoUndo.current.set(regroup.id, () =>
            dispatch({
              type: "rewrite",
              update: (threads) => {
                const gone = ids.get(joined[i].id)!;
                const current = threads.find((t) => t.id === kept.id);
                const back = { ...joined[i], messages: current?.messages.filter((m) => gone.has(m.id)) ?? joined[i].messages };
                return [
                  ...threads.map((t) =>
                    t.id === kept.id ? { ...t, messages: t.messages.filter((m) => !gone.has(m.id)), regroup: i > 0 ? regroups[i - 1] : kept.regroup } : t,
                  ),
                  back,
                ];
              },
            }),
          ),
        );
        dispatch({ type: "select", id: kept.id });
        setToast({ message, onUndo: () => undoRegroups(regroups.map((r) => r.id), kept.id) });
        return;
      }
      postJson<{ regroupIds: string[]; threadId: string }>("/api/mail/regroup", {
        action: "merge",
        account: target.accountId,
        thread: threadKey(target),
        others: others.map(threadKey),
      })
        .then((res) => {
          pendingSelect.current = { id: res.threadId };
          reload();
          setToast({ message, onUndo: () => undoRegroups(res.regroupIds, target.id) });
        })
        .catch((error: Error) => setToast({ message: error.message === "Request failed" ? "Those conversations couldn't be merged. Try again." : error.message }));
    },
    [live, threads, undoRegroups, clearChecked, dispatch, pendingSelect, reload, setToast],
  );

  return { undoRegroups, splitThread, mergeThreads };
}
