"use client";

import { useEffect, useMemo, useState } from "react";
import { paragraphs, splitMessage, unwrap } from "@/lib/mail/quotes";
import type { Message, Thread } from "@/lib/mail/types";
import { cn, formatFullDate } from "@/lib/utils";
import { Spinner } from "../ui/spinner";
import { EmailFrame } from "./email-frame";
import { useCleanHtml, useMessagePrivacy } from "./privacy-chip";

/**
 * The conversation being answered, beside a full-page composer: read-only, the newest message open
 * and the rest folded to a line. Read from the local copy, like opening it in the reader.
 */
export function ComposeConversation({
  threadId,
  accountId,
  live,
  demoThreads,
}: {
  /** Kite's id for the conversation (`<account>:<key>`). */
  threadId: string;
  accountId: string;
  live: boolean;
  demoThreads: Thread[];
}) {
  const [loaded, setLoaded] = useState<{ id: string; messages: Message[] | null } | null>(null);

  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    fetch(`/api/mail/threads/${threadId.slice(accountId.length + 1)}?account=${encodeURIComponent(accountId)}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Couldn't open that conversation"))))
      .then((data: { thread: Thread }) => setLoaded({ id: threadId, messages: data.thread.messages }))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setLoaded({ id: threadId, messages: null });
      });
    return () => controller.abort();
  }, [live, threadId, accountId]);

  const fetched = loaded?.id === threadId ? loaded.messages : undefined;
  const messages = live ? fetched : (demoThreads.find((t) => t.id === threadId)?.messages ?? null);
  const shown = messages?.filter((m) => !m.draft);

  if (messages === undefined) {
    return (
      <div className="grid h-full place-items-center text-pane-muted">
        <Spinner />
      </div>
    );
  }
  if (!shown?.length) return <p className="p-4 text-[13px] text-pane-muted">Couldn&apos;t open that conversation.</p>;
  return (
    // No scroll-fade: over a white email it reads as a grey smear, not a fade.
    <div data-sensitive className="flex h-full flex-col gap-1 overflow-y-auto p-2">
      {shown.map((message, i) => (
        <SideMessage key={message.id} message={message} startOpen={i === shown.length - 1} />
      ))}
    </div>
  );
}

function SideMessage({ message, startOpen }: { message: Message; startOpen: boolean }) {
  const [open, setOpen] = useState(startOpen);
  return (
    <article className="shrink-0">
      <button onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full min-w-0 items-baseline gap-2 rounded-lg px-3 py-2 text-left transition-colors duration-150 hover:bg-pane-hover/60 hover:transition-none">
        <span className="shrink-0 text-[13px] font-medium">{message.from.name}</span>
        <span className={cn("min-w-0 flex-1 truncate text-[12px] text-pane-muted", open && "invisible")}>{message.preview ?? message.snippet}</span>
        <span className="shrink-0 text-[11.5px] tabular-nums text-pane-muted">{formatFullDate(message.date)}</span>
      </button>
      {open ? <SideBody message={message} /> : null}
    </article>
  );
}

/** Only what this message adds: its quoted history is the messages above it. */
function SideBody({ message }: { message: Message }) {
  const split = useMemo(() => splitMessage(message), [message]);
  const privacy = useMessagePrivacy(message);
  const html = useCleanHtml(split.html?.fresh ?? "");
  if (split.html) {
    return (
      <div className="pb-1">
        <EmailFrame html={html} loadRemote={privacy.loadRemote} />
      </div>
    );
  }
  return (
    <div className="font-reading flex flex-col gap-3 whitespace-pre-line px-3 pb-3 text-[14px] leading-relaxed text-pane-fg/90">
      {paragraphs(split.text.fresh).map(unwrap).map((paragraph, i) => (
        <p key={i}>{paragraph}</p>
      ))}
    </div>
  );
}
