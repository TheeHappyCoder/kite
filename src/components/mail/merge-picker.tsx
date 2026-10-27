"use client";

import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import type { Thread } from "@/lib/mail/types";
import { lastMessageDate } from "@/lib/mail/store";
import { formatListDate } from "@/lib/utils";
import { Avatar } from "./avatar";

import { FluidList } from "../ui/fluid-hover";
/**
 * "Merge with…": pick another conversation from the same account to join into this one.
 * Lists what's loaded; in live mode, typing also searches the local copy of every mailbox.
 */
export function MergePicker({
  thread,
  threads,
  live,
  onClose,
  onMerge,
}: {
  thread: Thread | null;
  threads: Thread[];
  live: boolean;
  onClose: () => void;
  onMerge: (other: Thread) => void;
}) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; threads: Thread[] }>({ query: "", threads: [] });
  const q = query.trim();

  useEffect(() => {
    if (!live || !thread || q.length < 2) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/mail/threads?mailbox=inbox&account=${thread.accountId}&q=${encodeURIComponent(q)}`, { signal: controller.signal })
        .then((res) => res.json())
        .then((data: { threads?: Thread[] }) => setFound({ query: q, threads: data.threads ?? [] }))
        .catch(() => {});
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [live, thread, q]);

  const candidates = useMemo(() => {
    if (!thread) return [];
    const extra = found.query === q ? found.threads : [];
    const seen = new Set<string>([thread.id]);
    return [...threads, ...extra].filter((t) => {
      if (seen.has(t.id) || t.accountId !== thread.accountId || t.scheduled) return false;
      seen.add(t.id);
      return true;
    });
  }, [thread, threads, found, q]);

  return (
    <Command.Dialog
      open={!!thread}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      label="Merge with another conversation"
      overlayClassName="blur-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
      contentClassName="blur-fade-down fixed inset-x-0 top-[18%] z-50 mx-auto w-[560px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-pane-border bg-pane text-pane-fg shadow-2xl"
    >
      <div className="border-b border-pane-border px-4 pb-2 pt-3">
        <p className="text-[12px] text-pane-muted">
          Merge into “<span className="text-pane-fg">{thread?.subject}</span>”. Only in Kite: your mailbox keeps its own conversations.
        </p>
      </div>
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder="Find a conversation by subject or person…"
        className="h-12 w-full border-b border-pane-border bg-transparent px-4 text-[14px] outline-none placeholder:text-pane-muted"
      />
      <Command.List className="scroll-fade max-h-[360px] overflow-y-auto p-2">
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-pane-muted">No other conversations match.</Command.Empty>
        <FluidList tone="pane" follow="[data-selected=true]">
        {candidates.map((t) => {
          const last = t.messages[t.messages.length - 1];
          const sender = t.messages.find((m) => m.from.name !== "You")?.from ?? last.from;
          return (
            <Command.Item
              key={t.id}
              value={`${t.subject} ${sender.name} ${sender.email} ${t.id}`}
              onSelect={() => onMerge(t)}
              className="relative flex h-12 cursor-default items-center gap-3 rounded-lg px-2.5 text-[13px]"
            >
              <Avatar name={sender.name} email={sender.email} className="size-7" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{t.subject}</span>
                <span className="block truncate text-[12px] text-pane-muted">
                  {sender.name} · {t.messages.length} {t.messages.length === 1 ? "message" : "messages"}
                </span>
              </span>
              <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">{formatListDate(lastMessageDate(t))}</span>
            </Command.Item>
          );
        })}
        </FluidList>
      </Command.List>
    </Command.Dialog>
  );
}
