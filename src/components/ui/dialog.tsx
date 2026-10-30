"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { blurFade, exitFor } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { CircleButton } from "../mail/circle-button";

/**
 * Every modal in Kite: one top bar (what it is on the left, what you can do with it on the right, then
 * Close), the content, and a footer only where a form needs one. No dividers, no fade over the content.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  icon,
  actions,
  stage = false,
  sensitive = false,
  dismiss = true,
  cover = false,
  bare = false,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** Beside the title: a file's type, the action being confirmed. */
  icon?: React.ReactNode;
  /** In the top bar, before Close: ghost `CircleButton`s and at most one solid pill. */
  actions?: React.ReactNode;
  /** The content is something to look at (a document, a message): it sits on a soft inset panel and fills it. */
  stage?: boolean;
  /** The title and description show who wrote or what about: screen privacy blurs them. */
  sensitive?: boolean;
  /** False: Escape and clicks outside do nothing, for a dialog that handles its own way out (Close still works). */
  dismiss?: boolean;
  /** Opaque sky over the whole app, shown at once and with no way out: the app lock. */
  cover?: boolean;
  /** The children are the whole card: no top bar or footer of the dialog's own. */
  bare?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const closable = dismiss && !cover;
  useEffect(() => {
    if (!open || !closable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closable, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className={cn("fixed inset-0 grid grid-cols-[minmax(0,1fr)] place-items-center p-4 max-sm:p-2", cover ? "z-[200]" : "z-50")}>
          {cover ? (
            // Never fades in: mail must not show through. Unlocked, it lifts away.
            <motion.div className="on-sky bg-sky absolute inset-0" exit={{ opacity: 0, filter: "blur(12px)", scale: 1.03, transition: exitFor.slow }} />
          ) : (
            <motion.div
              className="absolute inset-0 bg-black/45 backdrop-blur-[3px]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: 0.24 } }}
              exit={{ opacity: 0, transition: exitFor.slow }}
              onClick={closable ? onClose : undefined}
            />
          )}
          <motion.div
            role="dialog"
            aria-modal
            aria-label={title}
            {...blurFade({ y: 8, blur: 8, speed: "slow" })}
            className={cn(
              "relative flex max-h-[85vh] w-[560px] max-w-full flex-col max-sm:max-h-[94vh] overflow-hidden rounded-2xl border border-pane-border bg-pane text-pane-fg shadow-2xl",
              className,
            )}
          >
            {bare ? children : <>
            <header className={cn("flex min-h-14 shrink-0 items-center gap-3 py-2.5 pr-2.5", icon ? "pl-4" : "pl-5")}>
              {icon}
              <div data-sensitive={sensitive || undefined} className="min-w-0 flex-1">
                <h2 className="truncate text-[14px] font-semibold tracking-tight">{title}</h2>
                {description ? <p className="text-[12px] text-pane-muted">{description}</p> : null}
              </div>
              <div className="flex shrink-0 items-center gap-0.5">
                {actions}
                <CircleButton ghost icon={Cancel01Icon} label="Close" onClick={onClose} />
              </div>
            </header>
            {stage ? (
              <div className={cn("mx-2 flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl bg-pane-2", !footer && "mb-2")}>{children}</div>
            ) : (
              <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
            )}
            {footer ? <footer className="flex shrink-0 items-center gap-2 px-4 pb-3 pt-2.5">{footer}</footer> : null}
            </>}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
