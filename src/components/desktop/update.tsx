"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cancel01Icon, SecurityCheckIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { desktopInvoke, inDesktopApp, type DesktopUpdateState } from "@/lib/desktop";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Dialog } from "../ui/dialog";
import { AccentTitle } from "../ui/accent-title";
import { Spinner } from "../ui/spinner";
import { Icon } from "../icon";
import { UpdateDot } from "./update-dot";
import "./update.css";

type UpdateState = DesktopUpdateState;
type Shown = UpdateState & { phase: Exclude<UpdateState["phase"], "idle"> };
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

/**
 * The rail's update button and its dialog: what's new, then the download, the check, the install and
 * the restart as steps. The shell does the work (src-tauri/src/updater.rs); closing the dialog never
 * stops it. In development, `?update-demo` (or `?update-demo=error`) plays every step with made-up
 * numbers, in the browser or the desktop window.
 */
export function DesktopUpdate({ trigger }: { trigger: (open: () => void, label: string, dot: ReactNode) => ReactNode }) {
  const demo = useUpdateDemo();
  const shell = useShellUpdate(!demo.on);
  const { state, install } = demo.on ? demo : shell;
  const [open, setOpen] = useState(false);
  if (!state || state.phase === "idle") return null;
  const shown = state as Shown;
  const busy = shown.phase === "downloading" || shown.phase === "installing";
  const progress = shown.total ? Math.min(1, shown.downloaded / shown.total) : null;
  const label = shown.phase === "error" ? "Update didn't finish" : busy ? "Updating Kite" : `Kite ${shown.version ?? ""} is ready`.replace("  ", " ");
  return (
    <>
      {trigger(() => setOpen(true), label, <UpdateDot phase={shown.phase} />)}
      <UpdateDialog open={open} onClose={() => setOpen(false)} state={shown} progress={progress} onInstall={install} />
    </>
  );
}

function UpdateDialog({ open, onClose, state, progress, onInstall }: { open: boolean; onClose: () => void; state: Shown; progress: number | null; onInstall: () => Promise<void> }) {
  const [starting, setStarting] = useState(false);
  const busy = starting || state.phase === "downloading" || state.phase === "installing";
  const failed = state.phase === "error" && !starting;
  const view = failed ? "error" : busy ? "progress" : "notes";
  const install = async () => {
    setStarting(true);
    try {
      await onInstall();
    } finally {
      setStarting(false);
    }
  };
  const version = state.version ?? "";
  const title = busy ? `Updating to ${version}` : failed ? "The update didn't finish" : `Kite ${version}`;
  // How high the kite flies: low while it waits, climbing with the download, at the top to install.
  const height = state.phase === "installing" ? 1 : busy ? (progress ?? 0) : failed ? 0.15 : 0.35;
  const percent = progress === null ? null : Math.round(progress * 100);
  return (
    <Dialog open={open} onClose={onClose} title={title} bare className="w-[460px] rounded-3xl border-0 shadow-[0_30px_80px_-24px_rgb(0_0_0/0.5)] ring-1 ring-white/[0.07]">
      {/* A strip of the sky (the app's own, by the time of day), with Kite on its string. */}
      <div className="on-sky bg-sky relative isolate h-44 shrink-0 overflow-hidden text-white">
        <div aria-hidden className="sky-layer" />
        <SkyKite height={height} />
        <div className="relative flex items-center justify-between px-4 pt-4">
          <span className="rounded-full bg-white/15 px-2.5 py-1 text-[11.5px] font-medium tracking-wide">
            {busy ? "Updating" : failed ? "Not finished" : "New version"}
          </span>
          <button onClick={onClose} aria-label="Close" className="grid size-8 place-items-center rounded-full text-white/80 transition-colors duration-150 hover:bg-white/15 hover:text-white touch:size-11">
            <Icon icon={Cancel01Icon} size={16} />
          </button>
        </div>
        <div className="absolute inset-x-5 bottom-5">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={busy ? "busy" : failed ? "failed" : "ready"} {...blurFade({ y: 6, speed: "moderate" })}>
              <h2 className="text-[30px] font-semibold leading-tight tracking-tight drop-shadow-sm">
                <AccentTitle text={title} />
              </h2>
              <p className="mt-0.5 text-[13px] tabular-nums text-white/75">
                {state.phase === "installing"
                  ? "Installing, then Kite opens again"
                  : busy
                    ? percent === null
                      ? "Starting the download…"
                      : `${percent}% · ${mb(state.downloaded)} of ${mb(state.total ?? 0)}`
                    : `You have ${state.current}`}
              </p>
            </motion.div>
          </AnimatePresence>
        </div>
        {/* The horizon fills as the update arrives. */}
        {busy ? (
          <div role="progressbar" aria-label="Update" aria-valuemin={0} aria-valuemax={100} aria-valuenow={state.phase === "installing" ? 100 : (percent ?? undefined)} className="absolute inset-x-0 bottom-0 h-[3px] bg-white/15">
            <div className="kite-update-bar h-full bg-white" style={{ width: `${state.phase === "installing" ? 100 : (percent ?? 0)}%` }} />
          </div>
        ) : null}
      </div>

      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-4">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={view} {...blurFade({ y: 6, speed: "moderate" })}>
            {view === "notes" ? <Notes text={state.notes} /> : view === "progress" ? <Steps state={state} starting={starting} /> : <Failure message={state.error} />}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* The reassurance as one slim line of its own, so the buttons get a row to themselves. */}
      <div className="mx-5 mt-2 flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full bg-pane-hover px-3 py-1.5 text-[12px]">
        <Icon icon={SecurityCheckIcon} size={14} className="shrink-0 text-accent" />
        {view === "progress" ? (
          <span className="truncate">
            <span className="font-medium text-pane-fg">Kite opens again by itself</span>
            <span className="text-pane-muted"> · you can close this</span>
          </span>
        ) : (
          <span className="truncate">
            <span className="font-medium text-pane-fg">Signed by Kite</span>
            <span className="text-pane-muted"> · your mail and settings stay put</span>
          </span>
        )}
      </div>
      <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-3">
        {view === "progress" ? (
          <PillButton onClick={onClose}>Hide</PillButton>
        ) : (
          <>
            <PillButton onClick={onClose}>Later</PillButton>
            <PillButton primary autoFocus onClick={() => void install()}>
              {failed ? "Try again" : "Update and restart"}
            </PillButton>
          </>
        )}
      </footer>
    </Dialog>
  );
}

/**
 * Kite's mark flying on a string over the sky strip. `height` 0–1: where it flies (the download lifts
 * it). It sways a little while the dialog is open; nothing else moves.
 */
function SkyKite({ height }: { height: number }) {
  const W = 460;
  const H = 176;
  const x = 360;
  const y = 112 - height * 78;
  const tail = { x: x, y: y + 26 };
  const string = `M ${tail.x} ${tail.y} Q ${tail.x - 40} ${H - 10} ${tail.x - 120} ${H + 6}`;
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice">
      <path d={string} stroke="white" strokeOpacity={0.55} strokeWidth={1} fill="none" />
      <g style={{ transform: `translate(${x - 18}px, ${y - 22}px)` }}>
        <g className="kite-sway">
          <path d="M18 0 L34 18 L18 44 L2 18 Z" fill="white" fillOpacity={0.28} stroke="white" strokeWidth={1.75} strokeLinejoin="round" />
          <path d="M2 18 H34 M18 0 V44" stroke="white" strokeWidth={1.2} strokeOpacity={0.85} />
          {/* Bows on the tail. */}
          <path d="M18 44 q -5 6 0 10 q 5 4 0 10" stroke="white" strokeOpacity={0.7} strokeWidth={1.2} fill="none" />
        </g>
      </g>
    </svg>
  );
}

/** Release notes as written in the tag: "- " lines become a list, anything else a paragraph. */
function Notes({ text }: { text: string | null }) {
  const lines = (text ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return <p className="text-[13.5px] leading-relaxed text-pane-muted">A fresh version of Kite is ready to install.</p>;
  return (
    <section>
      <h3 className="mb-2.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-pane-muted">What’s new</h3>
      <ul className="flex flex-col gap-2.5">
        {lines.map((line, i) => {
          const item = line.replace(/^[-*•]\s+/, "");
          return (
            <li key={i} className="blur-fade flex gap-2.5 text-[13.5px] leading-relaxed" style={{ "--i": i } as React.CSSProperties}>
              {item !== line ? <span aria-hidden className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-accent" /> : null}
              <span className="min-w-0">{item}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Download, check, install, reopen: done ones ticked, the current one spinning, the rest waiting. */
function Steps({ state, starting }: { state: Shown; starting: boolean }) {
  const at = starting || state.phase === "downloading" ? 0 : 2;
  const steps = [
    { label: "Download", detail: state.total ? `${mb(state.downloaded)} of ${mb(state.total)}` : state.downloaded ? `${mb(state.downloaded)}` : "Starting…" },
    { label: "Check it’s really from Kite", detail: "The signature on the download" },
    { label: "Install", detail: "Replacing the app’s own files, never your data" },
    { label: "Reopen Kite", detail: "Right where you left off" },
  ];
  return (
    <ol className="flex flex-col" aria-live="polite">
      {steps.map((step, i) => {
        const done = i < at;
        const current = i === at;
        return (
          <li key={step.label} className="flex gap-3 py-2">
            <span
              className={cn(
                "mt-px grid size-6 shrink-0 place-items-center rounded-full transition-colors duration-150",
                done ? "bg-accent-soft text-accent" : current ? "text-accent" : "text-pane-muted/50",
              )}
            >
              {done ? <Icon icon={Tick02Icon} size={14} strokeWidth={2.2} /> : current ? <Spinner size={16} /> : <span className="size-1.5 rounded-full bg-current" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className={cn("text-[13.5px]", current ? "font-medium text-pane-fg" : done ? "text-pane-fg" : "text-pane-muted")}>{step.label}</div>
              {current ? <div className="text-[12px] tabular-nums text-pane-muted">{step.detail}</div> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Failure({ message }: { message: string | null }) {
  return (
    <div role="alert" className="rounded-xl bg-pane-hover px-3.5 py-3 text-[13px] leading-relaxed">
      <div className="font-medium text-warning">Nothing was changed.</div>
      <div className="mt-0.5 text-pane-muted">{message ?? "Kite couldn't finish the update."} Kite keeps running as it is; try again whenever you like.</div>
    </div>
  );
}

function PillButton({ primary, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...rest}
      className={cn(
        "flex h-8 shrink-0 items-center rounded-full px-3.5 text-[13px] font-medium transition-[background-color,filter] duration-150 touch:h-11",
        primary ? "bg-accent text-accent-fg hover:brightness-110" : "text-pane-fg hover:bg-pane-hover",
      )}
    >
      {children}
    </button>
  );
}

/** The shell's update state, read while it can matter (quicker while a download runs). */
function useShellUpdate(enabled: boolean) {
  const [state, setState] = useState<UpdateState | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    // Read shell state without tying an in-flight download to this component's lifetime.
    if (!enabled || !inDesktopApp()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let next: UpdateState | undefined;
      try {
        next = (await desktopInvoke("update", { action: "status" })) as UpdateState;
        if (!disposed) setState(next);
      } catch {
        /* A window closing during restart needs no error. */
      }
      if (!disposed) timer = setTimeout(poll, next?.phase === "downloading" || next?.phase === "installing" ? 250 : 2000);
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [enabled]);
  const install = async () => {
    if (pending.current) return;
    pending.current = true;
    try {
      setState((await desktopInvoke("update", { action: "install" })) as UpdateState);
    } catch {
      setState((s) => (s ? { ...s, phase: "error", error: "Kite couldn't start the update." } : s));
    } finally {
      pending.current = false;
    }
  };
  return { state, install };
}

// ---- Development demo: ?update-demo ----------------------------------------------------------

const DEMO_NOTES = `- Kite feels lighter: dragging the divider between the list and the reader, resizing the window and switching screens are smoother and quicker.
- Coming back to Mail from another screen is near instant.
- Moving through conversations with J and K is quicker.
- The sky's clouds hold still while you work and drift again when you pause.`;
const DEMO_SIZE = 38.4 * 1048576;

const demoParam = () => (process.env.NODE_ENV !== "production" ? new URLSearchParams(window.location.search).get("update-demo") : null);
/** The URL never changes under it, but React must look once after hydrating (the server knows no URL). */
const lookOnce = (changed: () => void) => {
  const timer = setTimeout(changed, 0);
  return () => clearTimeout(timer);
};

/** Plays the whole update with made-up numbers: available, a five-second download, installing, then back to the start. */
function useUpdateDemo() {
  const param = useSyncExternalStore(lookOnce, demoParam, () => null);
  const on = param !== null;
  const [state, setState] = useState<UpdateState>(() => ({
    phase: "available",
    current: "0.2.1",
    version: "0.2.2",
    notes: DEMO_NOTES,
    downloaded: 0,
    total: null,
    error: null,
  }));
  // `?update-demo=error`: the first download stops halfway, to show the failure and Try again.
  const [failedOnce, setFailedOnce] = useState(false);
  const failNext = param === "error" && !failedOnce;
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const later = (ms: number, run: () => void) => timers.current.push(setTimeout(run, ms));
  const install = async () => {
    setState((s) => ({ ...s, phase: "downloading", downloaded: 0, total: null, error: null }));
    later(700, () => setState((s) => ({ ...s, total: DEMO_SIZE })));
    for (let step = 1; step <= 25; step++) {
      later(700 + step * 200, () => {
        if (failNext && step === 14) {
          timers.current.forEach(clearTimeout);
          setFailedOnce(true);
          setState((s) => ({ ...s, phase: "error", error: "The download stopped: the connection was reset." }));
          return;
        }
        setState((s) => (s.phase === "downloading" ? { ...s, downloaded: Math.min(DEMO_SIZE, (DEMO_SIZE * step) / 25) } : s));
        if (step === 25) {
          later(400, () => setState((s) => ({ ...s, phase: "installing" })));
          later(4400, () => setState((s) => ({ ...s, phase: "available", downloaded: 0, total: null })));
        }
      });
    }
  };
  return { on, state: on ? state : null, install };
}
