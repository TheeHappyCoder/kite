"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ViewOffSlashIcon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import { useShortcuts } from "@/lib/shortcuts";
import { AiErrorText } from "../../ai-usage-link";
import { Icon } from "../../icon";
import { KeyCombo } from "../../ui/kbd";
import { Spinner } from "../../ui/spinner";
import type { SetToast, Toast } from "./util";

/** Seconds left on a held message, counting down once a second; at zero it's going out (a spinner until "sent"). */
function Countdown({ seconds }: { seconds: number }) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const timer = setInterval(() => setLeft((n) => Math.max(0, n - 1)), 1000);
    return () => clearInterval(timer);
  }, []);
  return left ? <span className="tabular-nums text-frame-muted">{left}s</span> : <Spinner size={12} className="text-frame-muted" />;
}

/** Toasts leave after five seconds; a held message's stays while it can be undone (the "sent" event replaces it), a busy one until it's replaced. */
export function useToastTimer(toast: Toast | null, setToast: SetToast) {
  useEffect(() => {
    // A busy toast stays until what it's waiting on replaces it.
    if (!toast || toast.busy) return;
    const timer = setTimeout(() => setToast(null), toast.held ? (toast.held.seconds + 5) * 1000 : toast.action ? 9000 : 5000);
    return () => clearTimeout(timer);
  }, [toast, setToast]);
}

/** The one toast at the bottom of the window, with Undo when there's something to undo. */
export function AppToast({ toast, onUndo, setToast }: { toast: Toast | null; onUndo: () => void; setToast: SetToast }) {
  const shortcuts = useShortcuts();
  return (
    <AnimatePresence>
      {toast ? (
        <motion.div key="toast" {...blurFade({ y: 10, blur: 8 })} className="fixed bottom-5 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2">
          <div className="ink-chrome flex items-center gap-4 whitespace-nowrap rounded-full border border-frame-border bg-frame/95 px-4 py-2 text-[13px] text-frame-fg shadow-[0_18px_40px_-14px_rgb(10_20_40/0.55)] backdrop-blur-xl">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.span key={toast.message} {...blurFade({ y: 6, blur: 4 })} className="flex min-w-0 items-center gap-2">
                {toast.busy ? <Spinner size={13} className="text-frame-muted" /> : null}
                <span className="min-w-0 truncate">
                  <AiErrorText message={toast.message} />
                </span>
                {toast.held ? <Countdown key={toast.held.id} seconds={toast.held.seconds} /> : null}
              </motion.span>
            </AnimatePresence>
            {toast.action ? (
              <button
                onClick={() => {
                  toast.action!.run();
                  setToast(null);
                }}
                className="shrink-0 font-medium text-frame-fg hover:opacity-80"
              >
                {toast.action.label}
              </button>
            ) : null}
            {toast.undo || toast.onUndo ? (
              <button onClick={onUndo} className="flex shrink-0 items-center gap-1.5 font-medium text-accent hover:opacity-80">
                Undo
                {shortcuts.primary("undo") ? <KeyCombo combo={shortcuts.primary("undo")!} keyClassName="bg-frame-active text-frame-muted" /> : null}
              </button>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** Shown while screen privacy blurs mail; clicking it turns it off. */
export function ScreenPrivacyBadge({ on, onOff }: { on: boolean; onOff: () => void }) {
  const shortcuts = useShortcuts();
  return (
    <AnimatePresence>
      {on ? (
        <motion.div key="screen-private" {...blurFade({ y: -8, blur: 6 })} className="fixed left-1/2 top-3 z-50 -translate-x-1/2">
          <button
            onClick={onOff}
            className="ink-chrome flex items-center gap-2 rounded-full border border-frame-border bg-frame px-3.5 py-1.5 text-[12.5px] text-frame-fg shadow-2xl hover:bg-frame-hover"
          >
            <Icon icon={ViewOffSlashIcon} size={14} className="text-accent" />
            Screen privacy on
            {shortcuts.primary("screenPrivacy") ? <KeyCombo combo={shortcuts.primary("screenPrivacy")!} keyClassName="bg-frame-active text-frame-muted" /> : null}
          </button>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
