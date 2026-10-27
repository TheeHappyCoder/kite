"use client";

import { useState } from "react";
import { AiRequestError, askAi, type RewriteHow, type SummaryState, type ThreadSummary } from "@/lib/ai-mail";
import { threadKey } from "@/lib/mail/threads";
import type { Thread } from "@/lib/mail/types";
import type { SetToast } from "./util";

/**
 * On-click AI on mail: Summarise (kept for this session, by Kite thread id), Draft with AI and
 * Rewrite. Each runs only when asked, needs your own mail (demo mail never leaves the browser)
 * and a connected AI; without one, AI settings open.
 */
export function useAiMail({ live, aiConfigured, setToast, openAi }: { live: boolean; aiConfigured: boolean; setToast: SetToast; openAi: () => void }) {
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});

  const aiReady = () => {
    if (!live) {
      setToast({ message: "AI works on your own mail. Connect an account first." });
      return false;
    }
    if (!aiConfigured) {
      openAi();
      return false;
    }
    return true;
  };

  /** Explains a failed AI request; one with no AI set up opens AI settings instead. */
  const aiFailed = (error: unknown) => {
    if (error instanceof AiRequestError && error.connect) openAi();
    else setToast({ message: error instanceof Error ? error.message : "The AI didn't answer. Try again." });
  };

  const forgetSummary = (threadId: string) =>
    setSummaries((current) => Object.fromEntries(Object.entries(current).filter(([id]) => id !== threadId)));

  /** Summarise: this conversation's text goes to your AI, only now. */
  const summarise = (thread: Thread) => {
    if (!aiReady()) return;
    const lastId = thread.messages.at(-1)?.id;
    setSummaries((current) => ({ ...current, [thread.id]: { status: "loading", lastId } }));
    askAi<{ summary: ThreadSummary }>({ kind: "summarise", account: thread.accountId, thread: threadKey(thread) })
      .then((res) => setSummaries((current) => ({ ...current, [thread.id]: { status: "done", lastId, summary: res.summary } })))
      .catch((error: unknown) => {
        if (error instanceof AiRequestError && error.connect) {
          forgetSummary(thread.id);
          openAi();
        } else {
          setSummaries((current) => ({ ...current, [thread.id]: { status: "error", lastId, message: error instanceof Error ? error.message : "The AI didn't answer." } }));
        }
      });
  };

  /** Draft with AI: a reply to this conversation (your notes steer it). Null when it didn't work (already explained). */
  const draftWithAi = async (thread: { accountId: string; key: string }, notes: string) => {
    if (!aiReady()) return null;
    try {
      return (await askAi<{ body: string }>({ kind: "draft", account: thread.accountId, thread: thread.key, notes })).body;
    } catch (error) {
      aiFailed(error);
      return null;
    }
  };

  /** Rewrite: only the text you picked goes to your AI, with a style or your own instruction. */
  const rewriteWithAi = async (text: string, how: RewriteHow) => {
    if (!aiReady()) return null;
    try {
      const ask = typeof how === "string" ? { style: how } : { style: null, instruction: how.instruction };
      return (await askAi<{ text: string }>({ kind: "rewrite", text, ...ask })).text;
    } catch (error) {
      aiFailed(error);
      return null;
    }
  };

  return { summaries, summarise, forgetSummary, draftWithAi, rewriteWithAi };
}
