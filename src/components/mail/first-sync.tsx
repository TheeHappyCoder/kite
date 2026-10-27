"use client";

import { createContext, useContext } from "react";
import { motion } from "motion/react";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Spinner } from "../ui/spinner";

// An account's first sync, shown wherever mail would be: the list (an empty state, then a strip
// above it), the reader's empty pane, and the views built from mail (Today, Files, Cleanup...), so
// nothing says "All caught up" or "No files" while mail is still coming in. mail-app provides it.

/** A first sync's progress: conversations stored so far, and how many there are once the lists are read. */
export type FirstSync = { done: number; total: number | null };

/** `inView`: the accounts in view still on their first sync, summed (null when none); `accounts`: each one's own. */
export type FirstSyncs = { inView: FirstSync | null; accounts: Record<string, FirstSync> };

export const FirstSyncContext = createContext<FirstSyncs>({ inView: null, accounts: {} });

/** The accounts in view still on their first sync, or null. */
export const useFirstSync = () => useContext(FirstSyncContext).inView;

/** One account's first sync, or null once it's done. */
export const useAccountSync = (accountId: string) => useContext(FirstSyncContext).accounts[accountId] ?? null;

export const syncCount = ({ done, total }: FirstSync) =>
  total ? `${done.toLocaleString()} of ${total.toLocaleString()} conversations` : done ? `${done.toLocaleString()} conversations so far` : "Finding your conversations…";

function SyncBar({ progress, className }: { progress: FirstSync; className?: string }) {
  const share = progress.total ? Math.min(1, progress.done / progress.total) : 0;
  return (
    <div className={cn("h-1 overflow-hidden rounded-full bg-pane-border/60", className)}>
      {progress.total ? (
        <div className="h-full rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${Math.max(4, share * 100)}%` }} />
      ) : (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
      )}
    </div>
  );
}

/** In place of an empty state while the first sync runs: what's happening and how far it is. */
export function FirstSyncState({ progress, note = "Newest first. Mail shows up here as it arrives." }: { progress: FirstSync; note?: string }) {
  return (
    <div className="grid h-full place-items-center p-8 text-center">
      <div className="blur-fade w-full max-w-60">
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-accent-soft text-accent">
          <Spinner size={18} />
        </div>
        <p className="text-[13px] font-medium text-pane-fg">Bringing your mail in</p>
        <p className="mt-1 text-[12px] tabular-nums text-pane-muted">{syncCount(progress)}</p>
        <SyncBar progress={progress} className="mt-3" />
        <p className="mt-3 text-[11.5px] leading-snug text-pane-muted">{note}</p>
      </div>
    </div>
  );
}

/** One line above content that's already there while the first sync is still running. */
export function SyncStrip({ progress, className }: { progress: FirstSync; className?: string }) {
  return (
    <motion.div {...blurFade({ y: -4 })} className={cn("mx-4 mb-1.5 flex items-center gap-2.5 text-[11.5px] text-pane-muted", className)} role="status">
      <Spinner size={12} className="text-accent" />
      <span className="shrink-0 tabular-nums">
        {progress.total ? `Syncing ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}` : "Syncing…"}
      </span>
      <SyncBar progress={progress} className="min-w-0 flex-1" />
    </motion.div>
  );
}
