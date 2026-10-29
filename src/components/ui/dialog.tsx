"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { blurFade, exitFor } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";

export function Dialog({
  open,
  onClose,
  title,
  description,
  bare = false,
  children,
  footer,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  /** The children are the whole card: no header, close button or footer of the dialog's own. */
  bare?: boolean;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 grid grid-cols-[minmax(0,1fr)] place-items-center p-4 max-sm:p-2">
          <motion.div
            className="absolute inset-0 bg-black/45 backdrop-blur-[3px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1, transition: { duration: 0.24 } }}
            exit={{ opacity: 0, transition: exitFor.slow }}
            onClick={onClose}
          />
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
            <header className="flex items-start gap-3 px-5 pb-3 pt-4">
              <div className="flex-1">
                <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
                {description ? <p className="mt-0.5 text-[12.5px] text-pane-muted">{description}</p> : null}
              </div>
              <button
                onClick={onClose}
                aria-label="Close"
                className="grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg touch:size-11"
              >
                <Icon icon={Cancel01Icon} size={16} />
              </button>
            </header>
            <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">{children}</div>
            {footer ? <footer className="flex items-center gap-2 border-t border-pane-border px-5 py-3">{footer}</footer> : null}
            </>}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
