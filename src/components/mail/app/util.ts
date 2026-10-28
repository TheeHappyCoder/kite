"use client";

import { useEffect, useState } from "react";
import { compileText } from "@/lib/design/compile";
import type { Design } from "@/lib/design/spec";
import { bodyToText } from "@/lib/mail/body";
import { isConnectError } from "@/lib/mail/connect";
import { lastMessageDate } from "@/lib/mail/store";
import type { Mailbox, Thread } from "@/lib/mail/types";
import type { Preferences } from "@/lib/settings";
import type { OnboardingStart } from "../../onboarding";

// What the app shell's hooks share: request helpers, small types and page-load readers.

export type ThreadOp =
  | "archive" | "unarchive" | "star" | "unstar" | "read" | "unread"
  | "spam" | "unspam" | "trash" | "untrash" | "snooze" | "unsnooze";

export type Toast = {
  message: string;
  undo?: Thread[];
  undoOp?: ThreadOp;
  onUndo?: () => void;
  /** One more thing to offer beside Undo ("Always"): runs, then the toast goes. */
  action?: { label: string; run: () => void };
  /** Something is under way (a send): a spinner before the message. */
  busy?: boolean;
  /** Undo send: the held message's id, seconds left to undo, and what to say once it goes. */
  held?: { id: string; seconds: number; sent: string };
};

export type SetToast = React.Dispatch<React.SetStateAction<Toast | null>>;
/** Reads the list (and everything keyed on it) again. */
export type Reload = () => void;

export type SyncInfo = Record<
  string,
  { ready: boolean; reconnect: boolean; progress: { done: number; total: number } | null; stored: number; unread?: number }
>;

export type ListResponse = {
  threads?: Thread[];
  nextOffset?: number | null;
  sync?: SyncInfo;
  counts?: Partial<Record<Mailbox, number>>;
  error?: string;
};

export const ONBOARDED_KEY = "kite-onboarded";

// Read once per page load: effects can run twice in development, and the URL is cleaned on first read.
let connectResult: OnboardingStart | null | undefined;

export function readConnectResult(): OnboardingStart | null {
  if (connectResult === undefined) connectResult = parseConnectResult();
  return connectResult;
}

function parseConnectResult(): OnboardingStart | null {
  const params = new URLSearchParams(window.location.search);
  const result = params.get("connect");
  if (!result) return null;
  window.history.replaceState(null, "", window.location.pathname);
  if (result === "ok") return { step: "syncing" };
  const via = params.get("via") === "microsoft" ? "microsoft" : "google";
  if (isConnectError(result)) return { step: "error", reason: result, via };
  return null;
}

let googleResult: string | null | undefined;

const GOOGLE_RESULTS: Record<string, string> = {
  ok: "Google connected. Your photo and calendar arrive in a moment.",
  other_google: "That was a different Google account. Pick the same one as this address.",
  cancelled: "Google wasn't connected.",
  invalid_state: "That sign-in took too long. Try Connect Google again.",
  missing_config: "Google sign-in is unavailable right now. Try again in a few minutes.",
};

/** What came back from a Gmail-over-IMAP account's optional Google sign-in (`/?google=<result>`), as a toast line. */
export function readGoogleResult(): string | null {
  if (googleResult !== undefined) return googleResult;
  const result = new URLSearchParams(window.location.search).get("google");
  if (result) window.history.replaceState(null, "", window.location.pathname);
  googleResult = result ? (GOOGLE_RESULTS[result] ?? "Google didn't finish connecting. Try again.") : null;
  return googleResult;
}

/** Demo mode keeps sent mail on the page: the body and signature as plain text. */
export function demoBody(markup: string, signature: Design | undefined) {
  const text = bodyToText(markup);
  return signature ? `${text.trimEnd()}\n\n-- \n${compileText(signature)}` : text;
}

export function tomorrowMorning() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(8, 0, 0, 0);
  return date.toISOString();
}

export async function postJson<T>(url: string, body: unknown, method = "POST"): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: method === "DELETE" ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Request failed");
  return data as T;
}

export function useDebounced<T>(value: T, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/** Local results plus what the provider found for the same search, newest first. */
export function withRemoteResults(local: Thread[], found: Thread[]) {
  const ids = new Set(local.map((t) => t.id));
  return [...local, ...found.filter((t) => !ids.has(t.id))].sort((a, b) => lastMessageDate(b).localeCompare(lastMessageDate(a)));
}

/**
 * Shows a notification. `plain` is what it says when "Show content in notifications" is off
 * (the default): no sender, subject or code, so nothing private shows on a lock screen.
 */
export function notify(title: string, body: string, preferences: Preferences, plain?: [string, string]) {
  if (!preferences.notifications.desktop) return;
  const [t, b] = !preferences.notifications.showContent && plain ? plain : [title, body];
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted" && document.visibilityState !== "visible") {
      new Notification(t, { body: b, silent: false });
    }
  } catch {}
}

/** Text the user selected: in the page, or inside an email's frame (same origin, so readable). */
export function selectedText() {
  const own = window.getSelection()?.toString().trim();
  if (own) return own;
  for (const frame of document.querySelectorAll("iframe")) {
    try {
      const text = frame.contentWindow?.getSelection()?.toString().trim();
      if (text) return text;
    } catch {
      // A frame from elsewhere: not ours to read.
    }
  }
  return "";
}
