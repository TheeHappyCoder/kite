"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cancel01Icon, Key01Icon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import { Icon } from "./icon";

import { CopyIcon } from "./ui/copy";
/** `choices` instead of `code`: Kite couldn't tell which part to copy; the pick is remembered per sender. */
export type CodeAlert = { id: string; service: string; code?: string; choices?: string[] };

const VISIBLE_MS = 3 * 60_000;

/** The sign-in code bar: pops up when a code email arrives, one click to copy. */
export function CodePopup({ alert, onDismiss }: { alert: CodeAlert | null; onDismiss: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  useEffect(() => {
    if (!alert) return;
    const timer = setTimeout(onDismiss, VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [alert, onDismiss]);

  const copy = async (value = alert?.code) => {
    if (!value) return;
    await navigator.clipboard.writeText(value);
    setCopied(value);
    setTimeout(() => setCopied(null), 1500);
  };
  /** One part of a code Kite couldn't settle: copied, and remembered for this sender's next codes. */
  const pick = (index: number) => {
    if (!alert?.choices?.[index]) return;
    void copy(alert.choices[index]);
    void fetch("/api/codes/pick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: alert.id, index }) }).catch(() => {});
  };

  return (
    <AnimatePresence>
      {alert ? (
        <motion.div
          key={alert.id}
          initial={{ opacity: 0, y: -16, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={{ opacity: 0, y: -16, filter: "blur(8px)" }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="fixed left-1/2 top-4 z-[90] -translate-x-1/2"
        >
          <div className="ink-chrome flex items-center gap-3 rounded-2xl border border-frame-border bg-frame py-2.5 pl-3 pr-2.5 text-frame-fg shadow-2xl">
            <span className="grid size-9 place-items-center rounded-xl bg-accent/20 text-accent">
              <Icon icon={Key01Icon} size={18} />
            </span>
            {alert.code ? (
              <>
                <div>
                  <div className="text-[11.5px] text-frame-muted">{alert.service} code</div>
                  <div data-sensitive className="tabular-nums text-[20px] font-semibold tracking-[0.2em]">
                    {alert.code}
                  </div>
                </div>
                <button
                  onClick={() => void copy()}
                  className="ml-2 flex h-9 items-center gap-1.5 rounded-full bg-frame-fg px-3.5 text-[12.5px] font-medium text-frame"
                >
                  <CopyIcon copied={copied !== null} tint={false} />
                  <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={copied !== null ? "y" : "n"} {...blurFade({ y: 4, blur: 3, speed: "moderate" })}>
                      {copied !== null ? "Copied" : "Copy"}
                    </motion.span>
                  </AnimatePresence>
                </button>
              </>
            ) : (
              <>
                <div className="min-w-0">
                  <div className="truncate text-[11.5px] text-frame-muted">{alert.service} code</div>
                  <div className="truncate text-[12.5px]">Which part do you type?</div>
                </div>
                <div data-sensitive className="ml-1 flex items-center gap-1.5">
                  {alert.choices?.map((value, index) => (
                    <button
                      key={value}
                      onClick={() => pick(index)}
                      className="flex h-9 items-center gap-1.5 rounded-full border border-frame-border px-3 tabular-nums text-[14px] font-semibold tracking-[0.12em] transition-colors duration-150 hover:bg-frame-hover"
                    >
                      {copied === value ? <CopyIcon copied tint={false} /> : null}
                      {value}
                    </button>
                  ))}
                </div>
              </>
            )}
            <button onClick={onDismiss} aria-label="Dismiss" className="grid size-8 place-items-center rounded-full text-frame-muted hover:bg-frame-hover hover:text-frame-fg">
              <Icon icon={Cancel01Icon} size={14} />
            </button>
          </div>
          {permission === "default" ? (
            <button
              onClick={() => Notification.requestPermission().then(setPermission)}
              className="mx-auto mt-1.5 block rounded-full bg-frame/90 px-3 py-1 text-[11.5px] text-frame-muted hover:text-frame-fg"
            >
              Also show codes as Windows notifications
            </button>
          ) : null}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
