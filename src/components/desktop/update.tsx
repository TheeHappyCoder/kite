"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { CloudDownloadIcon } from "@hugeicons/core-free-icons";
import { desktopInvoke, inDesktopApp, type DesktopUpdateState } from "@/lib/desktop";
import { Dialog } from "../ui/dialog";
import { Icon } from "../icon";
import "./update.css";

type UpdateState = DesktopUpdateState;
const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;

export function DesktopUpdate({ trigger }: { trigger: (open: () => void, label: string) => ReactNode }) {
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  useEffect(() => {
    // Read shell state without tying an in-flight download to this component's lifetime.
    if (!inDesktopApp()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      let next: UpdateState | undefined;
      try {
        next = await desktopInvoke("update", { action: "status" }) as UpdateState;
        if (!disposed) setState(next);
      } catch { /* A window closing during restart needs no error. */ }
      if (!disposed) timer = setTimeout(poll, next?.phase === "downloading" || next?.phase === "installing" ? 250 : 2000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);

  const install = async () => {
    if (pending.current) return;
    pending.current = true;
    setStarting(true);
    setError(null);
    try {
      const next = await desktopInvoke("update", { action: "install" }) as UpdateState;
      setState(next);
    } catch { setError("Kite couldn't start the update. Please try again."); }
    finally { pending.current = false; setStarting(false); }
  };
  if (!state || state.phase === "idle") return null;
  const busy = starting || state.phase === "downloading" || state.phase === "installing";
  const installing = state.phase === "installing";
  const percent = state.total ? Math.min(100, Math.round(state.downloaded / state.total * 100)) : undefined;
  const status = installing ? "Installing and restarting…" : "Downloading your update…";
  return <>
    {trigger(() => setOpen(true), busy ? "Updating Kite" : "Update available")}
    <Dialog open={open} onClose={() => setOpen(false)} title={busy ? "A little better, almost ready" : "A new Kite is here"}
      description={`Kite ${state.current}${state.version ? ` → ${state.version}` : ""}`}
      footer={<>
        <span className="flex-1 text-xs text-pane-muted">{busy ? "Kite will reopen when it’s ready." : "Your accounts, mail and settings stay with you."}</span>
        {!busy && <button autoFocus onClick={() => void install()} className="rounded-lg bg-pane-fg px-4 py-2 text-sm font-medium text-pane hover:opacity-85">{state.phase === "error" || error ? "Try again" : "Update & restart"}</button>}
      </>}>
      <div className="px-5 pb-6 pt-2">
        {busy ? <div className="py-6" aria-live="polite">
          <div className="mb-5 flex items-center gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-pane-hover"><Icon icon={CloudDownloadIcon} size={22} /></span>
            <span className="t-shimmer text-sm font-medium" data-text={status}>{status}</span>
          </div>
          <div role="progressbar" aria-label={status} aria-valuemin={0} aria-valuemax={100} aria-valuenow={installing ? undefined : percent} className="kite-update-track h-1.5 overflow-hidden rounded-full bg-pane-hover">
            <div className="kite-update-progress h-full rounded-full bg-pane-fg" data-indeterminate={installing || percent === undefined} style={{ width: installing || percent === undefined ? "35%" : `${percent}%` }} />
          </div>
          <p className="mt-3 text-xs tabular-nums text-pane-muted">{installing ? "Replacing the old app files. This window will close shortly." : `${mb(state.downloaded)}${state.total ? ` of ${mb(state.total)} · ${percent}%` : " downloaded"}`}</p>
        </div> : <>
          <h3 className="mb-3 text-xs font-medium text-pane-muted">What’s new</h3>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words text-[13px] leading-relaxed">{state.notes?.trim() || "A fresh version of Kite is ready to install."}</div>
        </>}
        {(error || state.error) && <p role="alert" className="mt-4 rounded-lg border border-pane-border p-3 text-sm">{error || state.error}</p>}
      </div>
    </Dialog>
  </>;
}

