"use client";

import { useEffect, useState } from "react";
import { desktopUpdate, type DesktopUpdateState } from "@/lib/desktop";
import { Spinner } from "../ui/spinner";
import { Group, Row } from "./settings-ui";

const VERSION = process.env.KITE_VERSION ?? "";
const DEV = process.env.NODE_ENV !== "production";
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * Settings → About: which Kite this is, and in the desktop app a way to look for a new version now
 * (the shell also looks by itself, src-tauri/src/updater.rs) and install it.
 */
export function AboutSection({ desktop }: { desktop: boolean }) {
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  const [checking, setChecking] = useState(false);
  const [checked, setChecked] = useState(false);
  const busy = state?.phase === "downloading" || state?.phase === "installing";

  // What the shell knows already; while an update comes in, its progress.
  useEffect(() => {
    if (!desktop) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      const next = await desktopUpdate("status").catch(() => null);
      if (!live) return;
      if (next) setState(next);
      if (next?.phase === "downloading" || next?.phase === "installing") timer = setTimeout(read, 400);
    };
    void read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [desktop, busy]);

  const check = async () => {
    setChecking(true);
    const next = await desktopUpdate("check").catch(() => null);
    setChecking(false);
    setChecked(true);
    if (next) setState(next);
  };
  const install = async () => {
    const next = await desktopUpdate("install").catch(() => null);
    if (next) setState({ ...next, phase: "downloading" });
  };

  const version = state?.current || VERSION;
  const percent = state?.total ? Math.min(100, Math.round((state.downloaded / state.total) * 100)) : null;
  const detail = !desktop
    ? "Updates come with the desktop app."
    : DEV
      ? "A development build: installed copies look for updates by themselves."
      : checking
        ? "Looking for a new version…"
        : state?.phase === "installing"
          ? "Installing. Kite reopens when it's done."
          : state?.phase === "downloading"
            ? `Downloading Kite ${state.version ?? ""}: ${mb(state.downloaded)}${state.total ? ` of ${mb(state.total)} · ${percent}%` : ""}`
            : state?.error
              ? state.error
              : state?.phase === "available"
                ? `Kite ${state.version} is ready to install. Your mail and settings stay as they are.`
                : checked
                  ? "You're up to date."
                  : "Kite looks for a new version when it starts and every six hours.";

  return (
    <>
      {/* `id`: where settings search for "update" or "version" lands. */}
      <Group id="Kite">
        <Row
          label={`Kite ${version}`}
          detail={detail}
          control={
            !desktop || DEV ? null : state?.phase === "available" ? (
              <button
                onClick={() => void install()}
                className="flex h-8 shrink-0 items-center rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane touch:h-11"
              >
                Update &amp; restart
              </button>
            ) : busy ? (
              <Spinner size={16} className="text-pane-muted" />
            ) : (
              <button
                onClick={() => void check()}
                disabled={checking}
                className="flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] transition-[background-color] duration-150 hover:bg-pane-hover disabled:opacity-60 touch:h-11"
              >
                {checking ? <Spinner size={13} /> : null}
                {state?.error ? "Try again" : "Check for updates"}
              </button>
            )
          }
        >
          {state?.phase === "available" && state.notes?.trim() ? (
            <div className="blur-fade max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-pane-2 px-3 py-2.5 text-[12.5px] leading-relaxed scroll-fade">{state.notes.trim()}</div>
          ) : null}
        </Row>
      </Group>
      <p className="px-1 text-[12px] leading-snug text-pane-muted">
        Kite keeps your mail on this computer. Updates are signed, so only a build Kite made installs, and your accounts, mail and settings carry over.
      </p>
    </>
  );
}
