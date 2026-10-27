"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Add01Icon, Cancel01Icon, RefreshIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import {
  DEFAULT_BINDINGS,
  SHORTCUT_DEFINITIONS,
  comboFromEvent,
  useShortcuts,
  type ShortcutAction,
} from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import { Dialog } from "./ui/dialog";
import { KeyCombo } from "./ui/kbd";

import { FLUID_ITEM, FluidList } from "./ui/fluid-hover";
type Recording = { action: ShortcutAction; index?: number } | null;

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { bindings, assign, remove, reset } = useShortcuts();
  const [recording, setRecording] = useState<Recording>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  const groups = useMemo(() => {
    const q = filter.toLowerCase();
    const map = new Map<string, typeof SHORTCUT_DEFINITIONS>();
    for (const def of SHORTCUT_DEFINITIONS) {
      if (q && !def.label.toLowerCase().includes(q)) continue;
      map.set(def.group, [...(map.get(def.group) ?? []), def]);
    }
    return [...map.entries()];
  }, [filter]);

  // Capture the next key press while recording. Runs in the capture phase so the
  // app's own shortcut handler never sees it.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && recording.index != null) {
        remove(recording.action, recording.index);
        setRecording(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return;
      const displaced = assign(recording.action, combo, recording.index);
      if (displaced) {
        const label = SHORTCUT_DEFINITIONS.find((d) => d.id === displaced)?.label;
        setNotice(`Moved from “${label}”`);
      } else {
        setNotice(null);
      }
      setRecording(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [recording, assign, remove]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 2600);
    return () => clearTimeout(t);
  }, [notice]);

  const close = () => {
    setRecording(null);
    setFilter("");
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={recording ? () => setRecording(null) : close}
      title="Keyboard shortcuts"
      description="Click a shortcut to change it. Backspace removes it, Esc cancels."
      footer={
        <>
          <AnimatePresence mode="popLayout">
            {notice ? (
              <motion.span key={notice} {...blurFade({ x: -8 })} className="text-[12px] text-warning">
                {notice}
              </motion.span>
            ) : null}
          </AnimatePresence>
          <button
            onClick={() => reset()}
            className="ml-auto flex h-8 items-center gap-1.5 rounded-full border border-pane-border px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
          >
            <Icon icon={RefreshIcon} size={14} /> Reset all
          </button>
          <button
            onClick={close}
            className="flex h-8 items-center rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90"
          >
            Done
          </button>
        </>
      }
    >
      <div className="px-5 pb-2">
        <label className="flex h-9 items-center gap-2 rounded-full border border-pane-border px-3 text-[13px] focus-within:border-accent/60">
          <Icon icon={Search01Icon} size={15} className="text-pane-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter actions"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
          />
        </label>
      </div>

      <div className="px-3 pb-4">
        {groups.map(([group, defs], g) => (
          <section key={group} className="blur-fade-up" style={{ "--i": g } as React.CSSProperties}>
            <h3 className="px-2 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">
              {group}
            </h3>
            <FluidList tone="pane">
            {defs.map((def) => {
              const combos = bindings[def.id];
              const isDefault = JSON.stringify(combos) === JSON.stringify(DEFAULT_BINDINGS[def.id]);
              return (
                <div key={def.id} {...FLUID_ITEM} className="group relative flex min-h-10 items-center gap-3 rounded-lg px-2">
                  <span className="flex-1 text-[13px]">{def.label}</span>
                  <div className="flex flex-wrap items-center justify-end gap-1.5">
                    {combos.map((combo, index) => (
                      <ComboButton
                        key={combo}
                        combo={combo}
                        recording={recording?.action === def.id && recording.index === index}
                        onClick={() => setRecording({ action: def.id, index })}
                      />
                    ))}
                    {recording?.action === def.id && recording.index == null ? (
                      <ComboButton recording onClick={() => setRecording(null)} />
                    ) : (
                      <button
                        onClick={() => setRecording({ action: def.id })}
                        aria-label={`Add shortcut for ${def.label}`}
                        className="grid size-6 place-items-center rounded-md text-pane-muted opacity-0 hover:bg-pane-2 hover:text-pane-fg group-hover:opacity-100"
                      >
                        <Icon icon={Add01Icon} size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => reset(def.id)}
                      aria-label={`Reset ${def.label}`}
                      disabled={isDefault}
                      className="grid size-6 place-items-center rounded-md text-pane-muted opacity-0 hover:bg-pane-2 hover:text-pane-fg disabled:invisible group-hover:opacity-100"
                    >
                      <Icon icon={RefreshIcon} size={12} />
                    </button>
                  </div>
                </div>
              );
            })}
            </FluidList>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function ComboButton({ combo, recording, onClick }: { combo?: string; recording?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex h-7 items-center gap-1 rounded-md border px-1.5 transition-colors",
        recording
          ? "border-accent bg-accent-soft text-accent"
          : "border-pane-border bg-pane-2 text-pane-fg/80 hover:border-pane-muted/50",
      )}
    >
      <AnimatePresence mode="popLayout" initial={false}>
        {recording ? (
          <motion.span key="rec" {...blurFade({ y: 4 })} className="flex items-center gap-1 px-1 text-[11.5px] font-medium">
            <span className="size-1.5 animate-pulse rounded-full bg-accent" />
            Press keys…
            <Icon icon={Cancel01Icon} size={11} />
          </motion.span>
        ) : (
          <motion.span key={combo} {...blurFade({ y: -4 })} className="flex">
            {/* flex, not inline: an inline wrapper adds a line box and pushes the caps off centre */}
            <KeyCombo combo={combo!} keyClassName="bg-pane text-pane-fg/80 shadow-[0_1px_0_var(--pane-border)]" />
          </motion.span>
        )}
      </AnimatePresence>
    </button>
  );
}
