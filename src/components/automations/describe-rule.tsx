"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { format } from "date-fns";
import { AiMagicIcon } from "@hugeicons/core-free-icons";
import type { AiDraftsView } from "@/lib/ai-tasks";
import { blurFade } from "@/lib/motion";
import { type RuleDraft } from "@/lib/rules/spec";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Switch } from "../ui/switch";
import { Thinking } from "../ui/thinking";
import { request } from "./builder-ui";

const DESCRIBE_STEPS = ["Reading what you want", "Writing the automation", "Checking it"];

/** "Describe an automation": one sentence in, an automation out, opened in the builder for you to check and save. Sends no mail. */
export function DescribeRule({ onDraft, onError }: { onDraft: (draft: RuleDraft) => void; onError: (message: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (text.trim().length < 3 || busy) return;
    setBusy(true);
    try {
      const res = await request<{ draft: RuleDraft }>("/api/rules/design", "POST", { description: text });
      setText("");
      onDraft(res.draft);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Couldn't draft that automation");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex h-8 min-w-0 flex-1 basis-64 items-center gap-1.5 rounded-full border border-pane-border pl-3 pr-1 focus-within:border-accent/60">
      {busy ? (
        <Thinking steps={DESCRIBE_STEPS} className="min-w-0 flex-1 text-[12.5px] text-pane-fg" />
      ) : (
        <>
          <Icon icon={AiMagicIcon} size={14} className="shrink-0 text-accent" />
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void submit()}
            maxLength={500}
            placeholder="Describe one: “label receipts from Takealot and archive them”"
            aria-label="Describe an automation for your AI to draft"
            className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-pane-muted"
          />
          {text.trim().length >= 3 ? (
            <button onClick={() => void submit()} className="blur-fade h-6 shrink-0 rounded-full bg-accent px-2.5 text-[11.5px] font-medium text-accent-fg">
              Draft
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

const JOB_WORDS = { queued: "waiting", done: "drafted", failed: "failed", skipped: "skipped", cancelled: "called off" } as const;

/** Rules' "Draft with AI": the one switch for all of it, Resume after errors, and the latest jobs. What it uses is on the AI page. */
export function AiDrafts({ onToast, onOpenUsage }: { onToast: (message: string) => void; onOpenUsage: () => void }) {
  const [view, setView] = useState<AiDraftsView | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ai/drafts", { signal: controller.signal })
      .then((r) => r.json() as Promise<AiDraftsView>)
      .then(setView)
      .catch(() => {});
    return () => controller.abort();
  }, []);
  if (!view) return null;

  const save = async (body: { on?: boolean; resume?: boolean }) => {
    try {
      setView(await request<AiDraftsView>("/api/ai/drafts", "POST", body));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That didn't save. Try again.");
    }
  };

  return (
    <div className="blur-fade-up flex flex-col gap-3 rounded-xl border border-pane-border p-4">
      <label className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-start gap-2.5">
          <Icon icon={AiMagicIcon} size={16} className="mt-0.5 shrink-0 text-accent" />
          <span className="min-w-0">
            <span className="block text-[13px] font-medium">Draft with AI</span>
            <span className="block text-[11.5px] text-pane-muted">
              {view.configured
                ? `Automations with “Allow AI” send the new email’s text to ${view.model ?? "your AI"} and leave a draft in the quick reply. Nothing is sent by itself.`
                : "Connect an AI (sidebar → AI) for these automations to draft replies."}
            </span>
          </span>
        </span>
        <Switch value={view.on} label={view.on ? "Pause all AI drafts" : "Switch AI drafts on"} onChange={(on) => void save({ on })} />
      </label>

      <AnimatePresence initial={false}>
        {view.pausedReason ? (
          <motion.div key="paused" {...blurFade({ y: -4 })} className="flex flex-wrap items-center gap-2 rounded-lg bg-warning/10 px-3 py-2 text-[12px]">
            <span className="min-w-0 flex-1">Paused after three errors in a row: {view.pausedReason}</span>
            <button onClick={() => void save({ resume: true })} className="h-7 rounded-full bg-pane-fg px-3 text-[12px] font-medium text-pane">
              Resume
            </button>
          </motion.div>
        ) : view.retryAt ? (
          <motion.p key="retry" {...blurFade({ y: -4 })} className="rounded-lg bg-pane-2 px-3 py-2 text-[12px] text-pane-muted">
            The last request failed. Trying again after {format(new Date(view.retryAt), "HH:mm")}.
          </motion.p>
        ) : null}
      </AnimatePresence>

      <p className="text-[11.5px] text-pane-muted">
        Automation drafts count against your AI limits in{" "}
        <button onClick={onOpenUsage} className="font-medium text-pane-fg underline decoration-pane-border underline-offset-2 hover:decoration-current">
          Settings → AI
        </button>
        . Requests are spaced out; errors wait and retry, and three in a row pause everything.
        {view.waiting ? ` ${view.waiting} waiting.` : ""}
      </p>

      {view.recent.length ? (
        <ul className="flex flex-col gap-1 border-t border-pane-border pt-2.5">
          {view.recent.map((job) => (
            <li key={job.id} className="flex min-w-0 items-center gap-2 text-[12px]">
              <span className="shrink-0 tabular-nums text-pane-muted">{format(new Date(job.at), "d MMM HH:mm")}</span>
              <span data-sensitive className="min-w-0 flex-1 truncate">
                {job.subject} <span className="text-pane-muted">· {job.ruleName}</span>
              </span>
              <span className={cn("shrink-0", job.status === "failed" ? "text-warning" : "text-pane-muted")}>
                {JOB_WORDS[job.status]}
                {job.reason && job.status !== "done" ? `: ${job.reason}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
