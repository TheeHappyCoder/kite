"use client";

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { AiUsageSummary } from "@/lib/ai-pricing";
import type { Account } from "@/lib/mail/types";
import { batchDue, batchSummary, shouldNotify, type BatchItem, type NotifyDecision, type NotifyEvent } from "@/lib/notify-rules";
import type { PreparedReply } from "@/lib/rules/prepared";
import type { Preferences } from "@/lib/settings";
import { inDesktopApp, type DesktopCode } from "@/lib/desktop";
import { notify, postJson, type SetToast } from "./util";

/** New mail from the sync engine (server/sync.ts `mail` event). */
type MailEvent = { threadId: string; from: { email: string; name: string }; subject: string; count: number; notify: "now" | "batch" };

export type Deliver = (decision: NotifyDecision, title: string, body: string, item: BatchItem, plain?: [string, string]) => void;

/**
 * The notification rules (lib/notify-rules.ts) with the current preferences, and delivery:
 * non-VIP notifications held while Kite is in the background come as one summary at the next batch time.
 */
export function useNotifications(preferencesRef: React.RefObject<Preferences>) {
  const decide = useCallback((event: NotifyEvent) => shouldNotify(event, preferencesRef.current.notifications), [preferencesRef]);
  const batchRef = useRef<BatchItem[]>([]);
  const deliver = useCallback<Deliver>(
    (decision, title, body, item, plain) => {
      if (decision === "now") notify(title, body, preferencesRef.current, plain);
      else if (decision === "batch" && document.visibilityState !== "visible") batchRef.current.push(item);
    },
    [preferencesRef],
  );
  useEffect(() => {
    let since = new Date();
    // Back in Kite: what was held is on screen now.
    const seen = () => {
      if (document.visibilityState === "visible") batchRef.current = [];
    };
    document.addEventListener("visibilitychange", seen);
    const timer = setInterval(() => {
      const now = new Date();
      const due = batchDue(preferencesRef.current.notifications.batchTimes, since, now);
      since = now;
      if (!due) return;
      const summary = batchSummary(batchRef.current);
      batchRef.current = [];
      if (summary) notify("Kite", summary, preferencesRef.current);
    }, 30_000);
    return () => {
      document.removeEventListener("visibilitychange", seen);
      clearInterval(timer);
    };
  }, [preferencesRef]);
  return { decide, deliver };
}

export type LiveHandlers = {
  decide: (event: NotifyEvent) => NotifyDecision;
  deliver: Deliver;
  setToast: SetToast;
  /** Mail, labels or rules changed: read the list again (debounced for `changed`). */
  reload: () => void;
  calendarChanged: () => void;
  aiUsage: (usage: AiUsageSummary) => void;
  accounts: (accounts: Account[]) => void;
  /** A fresh sign-in code or link (Codes). */
  code: (code: DesktopCode) => void;
  /** The desktop app's Kite bar shows mail to notify about now (`desktop.mailBar`), so no notification here. */
  mailBar: boolean;
  /** A rule's AI draft for a conversation (null: gone). */
  prepared: (threadId: string, reply: PreparedReply | null) => void;
};

/**
 * Live mode: asks the server to check for new mail every few seconds while Kite is on screen
 * (POST /api/sync/watch), and follows the sync engine's events (SSE /api/events).
 */
export function useLiveEvents(live: boolean, handlers: LiveHandlers) {
  // One connection for the whole session: the handlers are read when an event arrives.
  const on = useRef(handlers);
  useLayoutEffect(() => {
    on.current = handlers;
  });

  useEffect(() => {
    if (!live) return;
    const watch = () => {
      if (document.visibilityState === "visible") void postJson("/api/sync/watch", {}).catch(() => {});
    };
    watch();
    const timer = setInterval(watch, 60_000);
    document.addEventListener("visibilitychange", watch);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", watch);
    };
  }, [live]);

  useEffect(() => {
    if (!live) return;
    const source = new EventSource("/api/events");
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = (message) => {
      const { decide, deliver, setToast } = on.current;
      const event = JSON.parse(message.data) as { type: string; message?: string };
      if (event.type === "changed" || event.type === "progress") {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => on.current.reload(), 250);
      }
      if (event.type === "sent" && (event as { held?: boolean }).held) {
        // Undo send: the held message went. Only the toast changes, no notification.
        const id = (event as { scheduledId?: string }).scheduledId;
        setToast((current) => (current?.held && current.held.id === id ? { message: current.held.sent } : current));
      } else if (event.type === "sent") {
        const decision = decide({ kind: "scheduled" });
        if (decision !== "never") {
          setToast({ message: "Scheduled message sent" });
          deliver(decision, "Kite", "Scheduled message sent", { kind: "other", title: "Scheduled message sent" });
        }
      }
      if (event.type === "mail") {
        const mail = event as unknown as MailEvent;
        // The desktop app shows mail to notify about now in its Kite bar (src-tauri/src/bar.rs) instead.
        const bared = mail.notify === "now" && inDesktopApp() && on.current.mailBar;
        const decision = bared ? "never" : decide({ kind: "mail", mode: mail.notify });
        const title = mail.count > 1 ? `${mail.from.name || mail.from.email} (${mail.count})` : mail.from.name || mail.from.email;
        deliver(decision, title, mail.subject, { kind: "mail", from: mail.from.email }, ["New mail", mail.count > 1 ? `${mail.count} new messages` : "1 new message"]);
      }
      if (event.type === "ai") on.current.aiUsage((event as unknown as { usage: AiUsageSummary }).usage);
      if (event.type === "calendar") on.current.calendarChanged();
      if (event.type === "labels") on.current.reload();
      if (event.type === "accounts") {
        fetch("/api/accounts")
          .then((res) => res.json())
          .then((data: { accounts: Account[] }) => {
            if (data.accounts.length) on.current.accounts(data.accounts);
          })
          .catch(() => {});
      }
      if (event.type === "code") on.current.code(event as unknown as DesktopCode);
      if (event.type === "error" && event.message && event.message !== "reconnect") setToast({ message: event.message });
      if (event.type === "prepared") {
        // A rule's AI draft landed: refresh it for a conversation already opened (others get it when opened).
        const { threadId, accountId } = event as unknown as { threadId: string; accountId: string };
        fetch(`/api/mail/threads/${threadId.slice(accountId.length + 1)}/prepared?account=${encodeURIComponent(accountId)}`)
          .then((res) => res.json())
          .then((data: { prepared?: PreparedReply | null }) => on.current.prepared(threadId, data.prepared ?? null))
          .catch(() => {});
      }
    };
    return () => {
      if (timer) clearTimeout(timer);
      source.close();
    };
  }, [live]);
}
