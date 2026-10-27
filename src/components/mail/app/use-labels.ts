"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_LABELS } from "@/lib/mail/demo-data";
import { accountSpec, applyLabelChange, serviceName, type LabelKind, type MailLabel } from "@/lib/mail/providers";
import { ALL_ACCOUNTS, inScope, type AccountScope } from "@/lib/mail/scope";
import type { MailAction } from "@/lib/mail/store";
import { threadKey } from "@/lib/mail/threads";
import type { Account, Thread } from "@/lib/mail/types";
import { labelKey, type LabelLookup } from "../labels";
import { postJson, type Reload, type SetToast } from "./util";

/**
 * The user's labels/folders: read from the local copy (the sync engine refreshes them from each
 * provider; demo mode counts its sample labels on the page), the label picker, and label changes
 * on conversations with Undo.
 */
export function useLabels({
  live,
  threads,
  accounts,
  accountId,
  reloadKey,
  reload,
  dispatch,
  setToast,
}: {
  live: boolean;
  threads: Thread[];
  accounts: Account[];
  accountId: AccountScope;
  reloadKey: number;
  reload: Reload;
  dispatch: React.Dispatch<MailAction>;
  setToast: SetToast;
}) {
  const [liveLabels, setLiveLabels] = useState<MailLabel[]>([]);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    fetch("/api/labels", { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { labels?: MailLabel[] }) => setLiveLabels(data.labels ?? []))
      .catch(() => {});
    return () => controller.abort();
  }, [live, reloadKey]);
  const allLabels = useMemo<MailLabel[]>(
    () =>
      live
        ? liveLabels
        : DEMO_LABELS.map((l) => {
            const carrying = threads.filter((t) => t.accountId === l.accountId && t.labels?.includes(l.id));
            return { ...l, total: carrying.length, unread: carrying.filter((t) => t.unread).length };
          }),
    [live, liveLabels, threads],
  );
  const labelIndex = useMemo(() => new Map(allLabels.map((l) => [labelKey(l.accountId, l.id), l])), [allLabels]);
  const labelOf = useCallback<LabelLookup>((accountId, id) => labelIndex.get(labelKey(accountId, id)), [labelIndex]);
  /** Labels made from the picker, known before the list re-renders (applying one right after making it needs its kind). */
  const created = useRef(new Map<string, MailLabel>());

  /** Makes a label/folder in the account's provider (the picker's "Make …"); it joins the list at once. */
  const createLabel = useCallback(async (accountId: string, input: { name: string; kind: LabelKind }) => {
    const res = await postJson<{ label: Omit<MailLabel, "accountId" | "total" | "unread"> }>("/api/labels", { account: accountId, ...input });
    const label: MailLabel = { ...res.label, accountId, total: 0, unread: 0 };
    created.current.set(labelKey(accountId, label.id), label);
    setLiveLabels((list) => [...list.filter((l) => !(l.accountId === accountId && l.id === label.id)), label]);
    return label;
  }, []);
  const sidebarLabels = useMemo(
    () => (accountId === ALL_ACCOUNTS ? allLabels : allLabels.filter((l) => inScope(accountId, l.accountId))),
    [allLabels, accountId],
  );

  /** The label picker: which conversations it's for (ids, so it shows their labels as they change). */
  const [labelPick, setLabelPick] = useState<string[] | null>(null);
  const pickerThreads = useMemo(() => (labelPick ? threads.filter((t) => labelPick.includes(t.id)) : null), [labelPick, threads]);
  const openLabels = useCallback(
    (list: Thread[]) => {
      const targets = list.filter((t) => !t.scheduled);
      if (!targets.length) return;
      if (new Set(targets.map((t) => t.accountId)).size > 1) {
        setToast({ message: "Labels belong to one account. Select conversations from a single account." });
        return;
      }
      setLabelPick(targets.map((t) => t.id));
    },
    [setToast],
  );
  const closeLabels = useCallback(() => setLabelPick(null), []);

  const undoLabels = useRef<(list: Thread[], change: { add: string[]; remove: string[] }) => void>(() => {});
  /**
   * Adds or removes the user's own labels: tags stay with the conversation, a folder moves it
   * there (out of the Inbox). Applied on screen at once, then in the provider, with Undo for the
   * conversations it changed: a tag's inverse is exact, a move goes back message by message on
   * the server (each to where it was).
   */
  const changeLabels = useCallback(
    (list: Thread[], change: { add: string[]; remove: string[] }, undoable = true) => {
      const changed = list.filter(
        (t) => change.add.some((id) => !t.labels?.includes(id)) || change.remove.some((id) => t.labels?.includes(id)),
      );
      if (!changed.length) return;
      const accountId = changed[0].accountId;
      const known = (id: string) => labelOf(accountId, id) ?? created.current.get(labelKey(accountId, id));
      const isFolder = (id: string) => known(id)?.kind === "folder";
      const moving = change.add.some(isFolder);
      const after = (t: Thread): Thread => {
        const next = [...applyLabelChange(t.labels ?? [], change, isFolder)];
        return { ...t, labels: next.length ? next : undefined, mailbox: moving && t.mailbox === "inbox" ? "archive" : t.mailbox };
      };
      for (const t of changed) {
        const next = after(t);
        dispatch({ type: "patch", id: t.id, patch: { labels: next.labels, mailbox: next.mailbox } });
      }
      const revert = () => {
        for (const t of changed) dispatch({ type: "patch", id: t.id, patch: { labels: t.labels, mailbox: t.mailbox } });
      };
      let moved: Promise<string | undefined> = Promise.resolve(undefined);
      if (live) {
        moved = postJson<{ done: number; failed: number; undo?: string }>("/api/mail/threads", {
          labels: change,
          threads: changed.map((t) => ({ account: t.accountId, id: threadKey(t) })),
        })
          .then((res) => {
            if (res.failed) {
              setToast({ message: `${serviceName(accounts.find((a) => a.id === accountId))} didn't accept ${res.failed} of those changes. Refreshing.` });
              reload();
            }
            return res.undo;
          })
          .catch((error: Error) => {
            revert();
            setToast({ message: error.message === "Request failed" ? "That label change didn't go through. Try again." : error.message });
            return undefined;
          });
      }
      if (!undoable) return;
      const label = known(change.add[0] ?? change.remove[0]);
      const name = label?.name ?? "label";
      const what = changed.length === 1 ? "" : ` ${changed.length} conversations`;
      const tagged = accountSpec(accounts.find((a) => a.id === accountId)).organise.tag?.noun === "label" ? "Labelled" : "Added";
      setToast({
        message: moving ? `Moved${what} to “${name}”` : change.add.length ? `${tagged}${what} “${name}”` : `Removed “${name}”${what ? ` from${what}` : ""}`,
        onUndo: moving
          ? () => {
              revert();
              moved.then((undo) => {
                if (!undo) return;
                postJson("/api/mail/threads", { undoMove: undo }).catch((error: Error) => {
                  setToast({ message: error.message === "Request failed" ? "That move couldn't be undone. Refreshing." : error.message });
                  reload();
                });
              });
            }
          : // The picker changes one tag at a time and `changed` holds only conversations it changed, so the inverse is exact.
            () => undoLabels.current(changed.map(after), { add: change.remove, remove: change.add }),
      });
    },
    [live, accounts, labelOf, dispatch, reload, setToast],
  );

  useEffect(() => {
    undoLabels.current = (list, change) => changeLabels(list, change, false);
  }, [changeLabels]);

  /** Shows one account's label/folder. */
  const openLabel = useCallback(
    (accountId: string, labelId: string) => {
      dispatch({ type: "query", query: "" });
      dispatch({ type: "view", view: { kind: "label", accountId, labelId } });
    },
    [dispatch],
  );

  return { allLabels, labelOf, sidebarLabels, pickerThreads, labelPick, openLabels, closeLabels, changeLabels, openLabel, createLabel };
}
