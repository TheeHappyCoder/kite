import type { BarActivity } from "./bar/spec";

// What the desktop shell (src-tauri) reads from the server: fresh sign-in codes and links, plus its settings.

/** Codes and magic links older than this are ignored: they've usually expired. */
export const FRESH_CODE_MS = 10 * 60_000;

/** A fresh sign-in code or link (server/codes.ts). Carries only what the toast and tray need, never the email. */
export type DesktopCode = {
  id: string;
  /** Who sent it ("GitHub"). */
  service: string;
  code?: string;
  link?: string;
  /** No `code` yet: Kite can't tell which part to copy (first, second, whole); the user picks once per sender. */
  choices?: string[];
  receivedAt: string;
  threadId: string;
};

/** A meeting about to start (server/meetings.ts), for the Kite bar. Only what it shows, never attendees or notes. */
export type DesktopMeeting = {
  /** `${event id}@${start}`: one announcement per occurrence. */
  id: string;
  title: string;
  /** ISO instant. */
  start: string;
  end?: string;
  /** The video call link (https only), opened by the shell on Join. */
  join?: string;
  place?: string;
};

/**
 * New mail a rule said to notify about now (server/sync.ts `mail` event), for the Kite bar: who, what
 * about and the first line of the newest message. Never the body or addresses beyond the sender's.
 */
export type DesktopMail = {
  /** `${threadId}@${newest message id}`. */
  id: string;
  accountId: string;
  threadId: string;
  from: { email: string; name: string };
  subject: string;
  /** The newest message's new text, trimmed (`Message.preview`). */
  preview?: string;
  count: number;
};

/** What the Kite bar shows (src-tauri/src/bar.rs `Item`), tagged by `kind`. */
export type BarItem =
  | ({ kind: "code" } & DesktopCode)
  | ({ kind: "meeting" } & DesktopMeeting)
  | ({ kind: "mail" } & DesktopMail)
  /** Another app's, through the Kite bar API (lib/bar/spec.ts). */
  | ({ kind: "activity" } & BarActivity);

/** GET /api/desktop */
export type DesktopState = {
  codes: DesktopCode[];
  /** Windows notification with Copy / Open: `notifications.desktop && desktop.codeToast`. */
  codeToast: boolean;
  /** The Kite bar at the top of the screen (src-tauri/src/bar.rs): `desktop.codeCard`. */
  codeCard: boolean;
  /** Mail a rule said to notify about now drops down in the Kite bar (instead of a Windows notification): `desktop.mailBar`. */
  mailBar: boolean;
  /** Quiet (`bar.quiet`): everything arrives in the Kite bar resting, as one line. */
  barQuiet: boolean;
  /** Seconds a quick reply from the Kite bar is held so it can be undone (`compose.undoSend`, 0 = off). */
  undoSend: number;
  /** Global shortcut that copies the newest code, or "" for none. */
  codeShortcut: string;
  /** `notifications.showContent`: toasts may show the service and the code. Off: "Sign-in code ready". */
  showContent: boolean;
  /** `privacy.updateChecks`: the timed checks for a new version on GitHub (a manual check always runs). */
  updateChecks: boolean;
};

/** The shell's updater (src-tauri/src/updater.rs `UpdateState`), read with the `update` command. */
export type DesktopUpdateState = {
  phase: "idle" | "available" | "downloading" | "installing" | "error";
  /** This version. */
  current: string;
  version: string | null;
  notes: string | null;
  downloaded: number;
  total: number | null;
  error: string | null;
};

/** `status` (what's known), `check` (look now), `install` (download, install, restart). */
export const desktopUpdate = (action: "status" | "check" | "install") => desktopInvoke("update", { action }) as Promise<DesktopUpdateState>;

type ShellWindow = {
  __KITE_DESKTOP__?: true;
  __TAURI_INTERNALS__?: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
};

/** True inside the Tauri shell (it sets this flag on every page load). */
export function inDesktopApp() {
  return typeof window !== "undefined" && "__KITE_DESKTOP__" in window;
}

/** Calls a shell command allowed by the window's capability (bar or main). */
export function desktopInvoke(command: string, args?: Record<string, unknown>) {
  const internals = (window as ShellWindow).__TAURI_INTERNALS__;
  return internals ? internals.invoke(command, args) : Promise.reject(new Error("Not in the Kite desktop app"));
}
