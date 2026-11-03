"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { AlarmClockIcon, Archive02Icon, ArrowDown01Icon, MailSend01Icon, TimeScheduleIcon } from "@hugeicons/core-free-icons";
import { addDays, addHours, format, nextMonday, setHours, setMinutes, startOfMinute } from "date-fns";
import { blurFade, springSnappy } from "@/lib/motion";
import { useShortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Spinner } from "../ui/spinner";
import { KeyCombo } from "../ui/kbd";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Tooltip } from "../ui/tooltip";

/** `archive`: once it's sent (or scheduled), the conversation it answers leaves the Inbox. */
export type SendOptions = { sendAt?: string; remindDays?: number; archive?: boolean };

const REMIND_KEY = "kite-remind-days";
const REMIND_CHOICES = [0, 1, 3, 7];

function at(date: Date, hour: number) {
  return startOfMinute(setMinutes(setHours(date, hour), 0));
}

function laterOptions(now = new Date()) {
  const options: { label: string; date: Date }[] = [{ label: "In 1 hour", date: startOfMinute(addHours(now, 1)) }];
  if (now.getHours() < 17) options.push({ label: "This evening", date: at(now, 18) });
  options.push({ label: "Tomorrow morning", date: at(addDays(now, 1), 8) });
  options.push({ label: "Tomorrow afternoon", date: at(addDays(now, 1), 13) });
  if (now.getDay() !== 0) options.push({ label: "Monday morning", date: at(nextMonday(now), 8) });
  return options;
}

function readRemind() {
  try {
    const value = Number(localStorage.getItem(REMIND_KEY));
    return REMIND_CHOICES.includes(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** Send button with a menu for Send and archive (replies), sending later and asking for a follow-up nudge. */
/** One menu row: a single line, the label giving way (truncated) before the time or keys do. */
const ROW = "flex h-9 w-full items-center gap-2.5 whitespace-nowrap rounded-xl px-2.5 text-left text-[13px] transition-colors duration-150 touch:h-11";

export function SendMenu({
  disabled,
  sending = false,
  why,
  compact,
  archive,
  onSend,
}: {
  disabled: boolean;
  /** Pressed and on its way: a spinner, and the button stays in its colour. */
  sending?: boolean;
  /** Why it's off ("Add someone to send it to"), for the tooltip. */
  why?: string;
  compact?: boolean;
  /** Offer "Send and archive": the message answers a conversation. */
  archive?: boolean;
  onSend: (options: SendOptions) => void;
}) {
  const shortcuts = useShortcuts();
  const sendArchiveKeys = shortcuts.primary("sendArchive");
  const [open, setOpen] = useState(false);
  const remindPill = useId();
  const [remindDays, setRemindDays] = useState(readRemind);
  const ref = useRef<HTMLDivElement>(null);
  const options = useMemo(() => (open ? laterOptions() : []), [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [open]);

  const chooseRemind = (days: number) => {
    setRemindDays(days);
    try {
      localStorage.setItem(REMIND_KEY, String(days));
    } catch {}
  };

  const send = (sendAt?: Date, alsoArchive = false) => {
    setOpen(false);
    onSend({ sendAt: sendAt?.toISOString(), remindDays: remindDays || undefined, archive: alsoArchive || undefined });
  };

  return (
    <div ref={ref} className="relative flex items-center">
      {/* A texture accent pill (globals.css). Off, it keeps its shape (a quiet pill), so it reads as "not yet" rather than missing. */}
      <div
        data-variant="accent"
        data-off={(disabled && !sending) || undefined}
        className={cn("texture flex items-center overflow-hidden rounded-full", sending && "cursor-progress")}
      >
        <Tooltip label={sending ? "Sending" : (why ?? (remindDays ? `Send · nudge in ${remindDays}d if no reply` : "Send"))} side="top">
          <button
            aria-label={sending ? "Sending" : "Send"}
            aria-busy={sending || undefined}
            disabled={disabled}
            onClick={() => send()}
            className={cn(
              "flex h-8 items-center gap-1.5 text-[12.5px] font-medium hover:bg-black/10 disabled:cursor-[inherit] disabled:hover:bg-transparent",
              compact ? "w-8 justify-center" : "pl-4 pr-3",
            )}
          >
            {compact ? null : sending ? "Sending" : "Send"}
            {sending ? <Spinner size={compact ? 15 : 13} /> : <Icon icon={remindDays ? AlarmClockIcon : MailSend01Icon} size={compact ? 16 : 14} />}
          </button>
        </Tooltip>
        <Tooltip label={archive ? "Send and archive, send later or set a reminder" : "Send later or set a reminder"} side="top">
          <button
            aria-label="Send options"
            disabled={disabled}
            onClick={() => setOpen((o) => !o)}
            className={cn(
              "flex h-8 w-6 items-center justify-center border-l hover:bg-black/10 disabled:cursor-[inherit] disabled:hover:bg-transparent",
              disabled && !sending ? "border-pane-border" : "border-white/20",
            )}
          >
            <Icon icon={ArrowDown01Icon} size={13} />
          </button>
        </Tooltip>
      </div>

      <AnimatePresence>
        {open ? (
          <motion.div
            {...blurFade({ y: 6, blur: 6 })}
            role="menu"
            className="absolute bottom-10 right-0 z-30 w-[18rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-2xl border border-pane-border bg-pane p-1 text-pane-fg shadow-menu"
          >
            {archive ? (
              <>
                <FluidList tone="pane" className="flex flex-col">
                  <button {...FLUID_ITEM} role="menuitem" onClick={() => send(undefined, true)} className={ROW}>
                    <Icon icon={Archive02Icon} size={16} className="shrink-0 text-pane-muted" />
                    <span className="min-w-0 flex-1 truncate">Send and archive</span>
                    {sendArchiveKeys ? <KeyCombo combo={sendArchiveKeys} className="shrink-0" keyClassName="bg-pane-2 text-pane-muted" /> : null}
                  </button>
                </FluidList>
                <div role="separator" className="mx-2 my-1 h-px bg-pane-border" />
              </>
            ) : null}
            <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">Send later</div>
            <FluidList tone="pane" className="flex flex-col">
              {options.map((option, i) => (
                <button
                  key={option.label}
                  {...FLUID_ITEM}
                  role="menuitem"
                  onClick={() => send(option.date)}
                  className={cn(ROW, "blur-fade-up")}
                  style={{ "--i": i } as React.CSSProperties}
                >
                  <Icon icon={TimeScheduleIcon} size={16} className="shrink-0 text-pane-muted" />
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">{format(option.date, "EEE HH:mm")}</span>
                </button>
              ))}
            </FluidList>
            <div role="separator" className="mx-2 my-1 h-px bg-pane-border" />
            <div className="px-2.5 pb-2 pt-1.5">
              <div className="flex items-center gap-2 whitespace-nowrap text-[12px] text-pane-muted">
                <Icon icon={AlarmClockIcon} size={14} className="shrink-0" />
                <span className="truncate">Remind me if nobody replies</span>
              </div>
              <div className="mt-2 flex rounded-full bg-pane-2 p-[3px]">
                {REMIND_CHOICES.map((days) => (
                  <button
                    key={days}
                    onClick={() => chooseRemind(days)}
                    aria-pressed={remindDays === days}
                    className={cn(
                      "relative h-6 flex-1 whitespace-nowrap rounded-full text-[11.5px] transition-colors duration-150 touch:h-9",
                      remindDays === days ? "font-semibold text-pane-fg" : "font-medium text-pane-muted hover:text-pane-fg",
                    )}
                  >
                    {remindDays === days ? (
                      <motion.span
                        layoutId={`${remindPill}-remind`}
                        transition={springSnappy}
                        className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_0_0_1px_var(--pane-border),0_1px_2px_rgb(0_0_0/0.06)]"
                      />
                    ) : null}
                    <span className="relative">{days === 0 ? "Off" : days === 7 ? "1 week" : `${days} day${days > 1 ? "s" : ""}`}</span>
                  </button>
                ))}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
