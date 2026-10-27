import type { NotificationPrefs } from "./settings";

// Whether something Kite noticed should interrupt the user: one pure decision shared by the
// app and the sync engine (codes for the desktop shell). Typed events in, a named outcome out.
// New mail is decided by the rules engine (server/rules.ts): its notify verb says now or batch.

export type NotifyEvent =
  /** New mail a rule said to notify about: straight away, or with the next batch. */
  | { kind: "mail"; mode: "now" | "batch" }
  /** A fresh sign-in code or link. */
  | { kind: "code"; muted: boolean }
  /** A scheduled message went out. */
  | { kind: "scheduled" }
  /** A meeting in the user's calendar starts in a moment (the desktop app's Kite bar). */
  | { kind: "meeting" };

/** now: straight away. batch: held for the next batch time. never: stays quiet. */
export type NotifyDecision = "now" | "batch" | "never";

export function shouldNotify(event: NotifyEvent, prefs: NotificationPrefs): NotifyDecision {
  const later: NotifyDecision = prefs.batch && prefs.batchTimes.length ? "batch" : "now";
  switch (event.kind) {
    case "mail":
      return event.mode === "now" ? "now" : later;
    case "code":
      return event.muted || !prefs.codes ? "never" : "now";
    case "scheduled":
      return prefs.scheduled ? later : "never";
    case "meeting":
      // A batch would come after the meeting started.
      return prefs.meetings ? "now" : "never";
  }
}

const minutesOf = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

/** Whether a batch time passed after `since` and at or before `now` (local time; spans midnight). */
export function batchDue(times: string[], since: Date, now: Date): boolean {
  if (now <= since) return false;
  if (now.getTime() - since.getTime() >= 24 * 60 * 60_000) return times.length > 0;
  const from = since.getHours() * 60 + since.getMinutes();
  const to = now.getHours() * 60 + now.getMinutes();
  return times.some((time) => {
    const m = minutesOf(time);
    return from <= to ? m > from && m <= to : m > from || m <= to;
  });
}

/** What a batch holds: mail by sender address, and other updates by title. */
export type BatchItem = { kind: "mail"; from: string } | { kind: "other"; title: string };

/** "6 new emails from 4 people" (plus ", 2 updates"), or null for an empty batch. */
export function batchSummary(items: BatchItem[]): string | null {
  const mail = items.filter((i): i is Extract<BatchItem, { kind: "mail" }> => i.kind === "mail");
  const other = items.length - mail.length;
  const people = new Set(mail.map((m) => m.from.toLowerCase())).size;
  const parts: string[] = [];
  if (mail.length) parts.push(`${mail.length} new email${mail.length === 1 ? "" : "s"} from ${people} ${people === 1 ? "person" : "people"}`);
  if (other) parts.push(`${other} update${other === 1 ? "" : "s"}`);
  return parts.length ? parts.join(", ") : null;
}
