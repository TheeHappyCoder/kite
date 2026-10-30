"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowRight01Icon, Cancel01Icon, SecurityCheckIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { desktopInvoke, inDesktopApp, type DesktopUpdateState } from "@/lib/desktop";
import { parseReleaseNotes, type ReleaseFeature, type ReleaseNotes } from "@/lib/release-notes";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
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
  const notes = useMemo(() => parseReleaseNotes(state.notes), [state.notes]);
  // Notes with features get a tab each (and keep the width through the download, so nothing jumps).
  const wide = notes.features.length > 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      bare
      className={cn("rounded-3xl border-0 shadow-[0_30px_80px_-24px_rgb(0_0_0/0.5)] ring-1 ring-white/[0.07]", wide ? "w-[820px]" : "w-[460px]")}
    >
      {/* A strip of the sky (the app's own, by the time of day), with Kite on its string. */}
      <div className={cn("on-sky bg-sky relative isolate shrink-0 overflow-hidden text-white", wide ? "h-36" : "h-44")}>
        <div aria-hidden className="sky-layer" />
        <SkyKite height={height} wide={wide} />
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
      </div>

      {/* The progress on paper, not on the sky's edge: a white line there vanished against a light pane. */}
      {busy ? (
        <div className="mx-5 mt-4 flex items-center gap-3">
          <div
            role="progressbar"
            aria-label="Update"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={state.phase === "installing" ? 100 : (percent ?? undefined)}
            className="h-1.5 flex-1 overflow-hidden rounded-full bg-pane-hover"
          >
            <div className="kite-update-bar h-full rounded-full bg-accent" style={{ width: `${state.phase === "installing" ? 100 : (percent ?? 0)}%` }} />
          </div>
          <span className="w-10 text-right text-[12px] font-medium tabular-nums text-pane-muted">{state.phase === "installing" ? "100%" : percent === null ? "" : `${percent}%`}</span>
        </div>
      ) : null}

      {wide && view === "notes" ? (
        <Features notes={notes} />
      ) : (
        <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-5 pb-2 pt-4">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div key={view} {...blurFade({ y: 6, speed: "moderate" })} className={cn(wide && "max-w-[480px]")}>
              {view === "notes" ? <Notes text={state.notes} /> : view === "progress" ? <Steps state={state} starting={starting} /> : <Failure message={state.error} />}
            </motion.div>
          </AnimatePresence>
        </div>
      )}

      {/* The reassurance as one slim line: beside the buttons in the wide dialog, else a row of its own so the buttons keep theirs. */}
      {wide ? null : <Reassurance progress={view === "progress"} className="mx-5 mt-2" />}
      <footer className="flex items-center justify-end gap-2 px-5 pb-4 pt-3">
        {wide ? <Reassurance progress={view === "progress"} className="mr-auto max-sm:hidden" /> : null}
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

function Reassurance({ progress, className }: { progress: boolean; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 whitespace-nowrap rounded-full bg-pane-hover px-3 py-1.5 text-[12px]", className)}>
      <Icon icon={SecurityCheckIcon} size={14} className="shrink-0 text-accent" />
      {progress ? (
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
  );
}

/**
 * Kite's mark flying on a string over the sky strip. `height` 0–1: where it flies (the download lifts
 * it). It sways a little while the dialog is open; nothing else moves.
 */
function SkyKite({ height, wide }: { height: number; wide: boolean }) {
  // Drawn at the strip's own size (the wide dialog's strip is wider and shorter), so it never flies out of it.
  const W = wide ? 820 : 460;
  const H = wide ? 144 : 176;
  const x = W - 100;
  const y = H * 0.64 - height * H * 0.44;
  const tail = { x: x, y: y + 26 };
  const string = `M ${tail.x} ${tail.y} Q ${tail.x - 40} ${H - 10} ${tail.x - 120} ${H + 6}`;
  return (
    <svg aria-hidden viewBox={`0 0 ${W} ${H}`} className="pointer-events-none absolute inset-0 h-full w-full" preserveAspectRatio="xMidYMid slice">
      {/* Both glide to each new height (progress arrives in steps a few times a second): the string as a CSS `d`. */}
      <path stroke="white" strokeOpacity={0.55} strokeWidth={1} fill="none" className="kite-glide" style={{ d: `path("${string}")` } as React.CSSProperties} />
      <g className="kite-glide" style={{ transform: `translate(${x - 18}px, ${y - 22}px)` }}>
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

/**
 * What's new as tabs (lib/release-notes.ts): a feature each, its picture or animated picture under its
 * text, and the smaller fixes last. ↑ / ↓ move through them; one column of pills on narrow windows.
 */
function Features({ notes }: { notes: ReleaseNotes }) {
  const tabs: (ReleaseFeature & { polish?: boolean })[] = [
    ...notes.features,
    ...(notes.polish.length ? [{ title: "Smaller things", media: null, polish: true, lines: notes.polish.map((text) => ({ bullet: true, text })) }] : []),
  ];
  const [at, setAt] = useState(0);
  const tab = tabs[Math.min(at, tabs.length - 1)];
  const next = tabs[at + 1];
  const move = (by: number) => setAt((i) => Math.max(0, Math.min(tabs.length - 1, i + by)));
  return (
    <div className="flex h-[min(440px,54vh)] min-h-0 border-b border-pane-border max-sm:h-[min(520px,62vh)] max-sm:flex-col">
      <nav
        aria-label="What’s new"
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
          e.preventDefault();
          move(e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1);
        }}
        className="scroll-fade w-[17rem] shrink-0 overflow-y-auto border-r border-pane-border p-2 max-sm:w-auto max-sm:overflow-x-auto max-sm:border-b max-sm:border-r-0"
      >
        <h3 className="px-2.5 pb-1.5 pt-1.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-pane-muted max-sm:hidden">What’s new</h3>
        <FluidList tone="pane" follow="[data-selected=true]" className="flex flex-col gap-0.5 max-sm:flex-row">
          {tabs.map((t, i) => (
            <button
              key={t.title}
              {...FLUID_ITEM}
              role="tab"
              aria-selected={i === at}
              data-selected={i === at}
              tabIndex={i === at ? 0 : -1}
              onClick={() => setAt(i)}
              className={cn(
                "flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-left text-[13px] transition-[background-color,color] duration-150 data-[lit]:bg-pane-hover touch:h-11",
                i === at ? "bg-pane-hover font-medium text-pane-fg" : "text-pane-muted data-[lit]:text-pane-fg",
              )}
            >
              <span className="min-w-0 flex-1 truncate">{t.title}</span>
              {t.polish ? (
                // The fixes: a wink, not a number.
                <span className="rounded-full bg-accent-soft px-1.5 py-px text-[10.5px] font-semibold text-accent">Nerd stuff</span>
              ) : (
                <span className="rounded-full bg-lime px-1.5 py-px text-[10.5px] font-semibold text-lime-fg">New</span>
              )}
            </button>
          ))}
        </FluidList>
      </nav>

      <div role="tabpanel" aria-label={tab.title} className="scroll-fade min-w-0 flex-1 overflow-y-auto px-6 py-5">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={at} {...blurFade({ y: 6, speed: "moderate" })}>
            {at === 0 && notes.intro.length ? <p className="mb-3 text-[12.5px] leading-relaxed text-pane-muted">{notes.intro.join(" ")}</p> : null}
            <h3 className="text-[19px] font-semibold leading-tight tracking-tight">
              <AccentTitle text={tab.title} />
            </h3>
            <NoteText lines={tab.lines} />
            {tab.media ? <FeatureMedia key={tab.media} src={tab.media} alt={tab.title} /> : null}
            {next ? (
              <button onClick={() => move(1)} className="mt-5 flex items-center gap-1 text-[12.5px] font-medium text-accent hover:underline">
                Next: {next.title}
                <Icon icon={ArrowRight01Icon} size={13} />
              </button>
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

/** A feature's text: paragraphs, and "- " lines as a list. */
function NoteText({ lines }: { lines: ReleaseFeature["lines"] }) {
  return (
    <div className="mt-2 flex flex-col gap-2 text-[13.5px] leading-relaxed text-pane-fg/90">
      {lines.map((line, i) =>
        line.bullet ? (
          <div key={i} className="flex gap-2.5">
            <span aria-hidden className="mt-[0.6em] size-1.5 shrink-0 rounded-full bg-accent" />
            <span className="min-w-0">{line.text}</span>
          </div>
        ) : (
          <p key={i}>{line.text}</p>
        ),
      )}
    </div>
  );
}

/** The feature's picture (an animated WebP or GIF plays by itself), framed like a card; gone if it doesn't load. */
function FeatureMedia({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  if (state === "failed") return null;
  return (
    <figure className="relative mt-4 aspect-[16/10] overflow-hidden rounded-xl border border-pane-border bg-pane-2">
      {state === "loading" ? (
        <span className="absolute inset-0 grid place-items-center text-pane-muted">
          <Spinner />
        </span>
      ) : null}
      {/* eslint-disable-next-line @next/next/no-img-element -- a remote picture from the release, not a page asset */}
      <img
        src={src}
        alt={alt}
        referrerPolicy="no-referrer"
        onLoad={() => setState("ready")}
        onError={() => setState("failed")}
        className={cn("size-full object-cover object-top transition-opacity duration-150", state === "ready" ? "opacity-100" : "opacity-0")}
      />
    </figure>
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
    current: process.env.KITE_VERSION ?? "",
    version: "",
    notes: "",
    downloaded: 0,
    total: null,
    error: null,
  }));
  // The newest release's real notes and pictures (docs/whats-new/<version>/), so they can be read here before tagging.
  useEffect(() => {
    if (!on) return;
    let live = true;
    void fetch("/api/dev/whats-new")
      .then((res) => res.json() as Promise<{ version: string; notes: string }>)
      .then(({ version, notes }) => live && setState((s) => ({ ...s, version, notes })));
    return () => {
      live = false;
    };
  }, [on]);
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
