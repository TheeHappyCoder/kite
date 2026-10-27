"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { FLUID_ITEM, FluidList } from "./fluid-hover";

// The house select: a pill trigger and a menu with the shared fluid highlight (it follows the
// pointer and the arrow keys alike). Never a native <select>. The menu is portalled and placed
// fixed under the trigger (above it when there's no room), so scrollers and cards never clip it.

/** `icon` (e.g. an account picture) and `detail` (a second, quieter line) are optional. */
type SelectOption<T extends string> = { value: T; label: string; icon?: React.ReactNode; detail?: string };

type Place = { left: number; top?: number; bottom?: number; minWidth: number; maxHeight: number };

const GAP = 6;
const MENU_MAX = 280;

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
  variant = "bordered",
  className,
  style,
  title,
  disabled,
}: {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  /** Accessible name (shown nowhere). */
  label: string;
  variant?: "bordered" | "borderless";
  className?: string;
  /** For a trigger placed over something, like a PDF form field. */
  style?: React.CSSProperties;
  title?: string;
  disabled?: boolean;
}) {
  const [place, setPlace] = useState<Place | null>(null);
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const open = !!place;
  const current = options.find((o) => o.value === value);

  const show = () => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    const up = below < Math.min(MENU_MAX, options.length * 32 + 8) && above > below;
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    setPlace({
      left: Math.min(r.left, window.innerWidth - Math.max(r.width, 160) - 8),
      minWidth: r.width,
      maxHeight: Math.min(MENU_MAX, up ? above : below),
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    });
  };
  const hide = (focus = true) => {
    setPlace(null);
    if (focus) trigger.current?.focus();
  };
  const pick = (option: SelectOption<T>) => {
    if (option.value !== value) onChange(option.value);
    hide();
  };

  // Closes on a click elsewhere, when the page scrolls under it, and when the window gets wider or narrower
  // (not on height alone: a phone's address bar or keyboard changes that).
  useEffect(() => {
    if (!open) return;
    const width = window.innerWidth;
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) hide(false);
    };
    const moved = (e: Event) => {
      if (!menu.current?.contains(e.target as Node)) hide(false);
    };
    const resized = () => {
      if (window.innerWidth !== width) hide(false);
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", moved, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", resized);
    };
  }, [open]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (e.key === "Tab") hide(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + options.length) % options.length);
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? 0 : options.length - 1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (options[active]) pick(options[active]);
    } else if (e.key.length === 1) {
      // Type a letter to jump to the next option starting with it.
      const key = e.key.toLowerCase();
      const next = options.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(key));
      const first = options.findIndex((o) => o.label.toLowerCase().startsWith(key));
      if (next >= 0 || first >= 0) setActive(next >= 0 ? next : first);
    }
  };

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        title={title}
        style={style}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKey}
        className={cn(
          "inline-flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-full px-3 text-[12.5px] outline-none transition-colors touch:h-11",
          variant === "bordered" ? "border border-pane-border focus-visible:border-accent/60" : "focus-visible:bg-pane-hover",
          open ? "bg-pane-hover" : "hover:bg-pane-hover",
          className,
        )}
      >
        {current?.icon ? <span className="flex shrink-0">{current.icon}</span> : null}
        <span className="min-w-0 truncate">
          {current?.label ?? "Select…"}
          {current?.detail ? <span className="text-pane-muted"> · {current.detail}</span> : null}
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} transition={{ type: "spring", duration: 0.16, bounce: 0 }} className="grid shrink-0 text-pane-muted">
          <Icon icon={ArrowDown01Icon} size={13} />
        </motion.span>
      </button>
      {typeof document === "undefined"
        ? null
        : createPortal(
            <AnimatePresence>
              {place ? (
                <motion.div
                  ref={menu}
                  key="menu"
                  id={id}
                  role="listbox"
                  aria-label={label}
                  aria-activedescendant={`${id}-${active}`}
                  onKeyDown={onKey}
                  {...blurFade({ y: place.top !== undefined ? -4 : 4, blur: 4, speed: "moderate" })}
                  style={{ position: "fixed", left: place.left, top: place.top, bottom: place.bottom, minWidth: place.minWidth, maxHeight: place.maxHeight }}
                  className="scroll-fade z-50 max-w-[min(320px,calc(100vw-16px))] overflow-y-auto rounded-xl border border-pane-border bg-pane-raised p-1 text-pane-fg shadow-[0_12px_32px_rgba(0,0,0,0.28)]"
                >
                  <FluidList tone="pane" follow="[data-selected=true]" className="flex flex-col">
                    {options.map((option, i) => {
                      const chosen = option.value === value;
                      return (
                        <div
                          key={option.value}
                          {...FLUID_ITEM}
                          id={`${id}-${i}`}
                          role="option"
                          aria-selected={chosen}
                          data-index={i}
                          data-selected={i === active}
                          onPointerMove={() => i !== active && setActive(i)}
                          onClick={() => pick(option)}
                          className={cn(
                            "relative flex cursor-default items-center gap-2 rounded-lg pl-2.5 pr-2 text-[12.5px] transition-[background-color,font-weight] duration-150",
                            option.detail ? "min-h-11 gap-2.5 py-1.5" : "h-8 touch:h-11",
                            chosen ? "font-medium" : "text-pane-fg/90",
                          )}
                        >
                          {option.icon ? <span className="flex shrink-0">{option.icon}</span> : null}
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{option.label}</span>
                            {option.detail ? <span className="block truncate text-[11.5px] font-normal text-pane-muted">{option.detail}</span> : null}
                          </span>
                          <span className="grid size-3.5 shrink-0 place-items-center text-accent">{chosen ? <Icon icon={Tick02Icon} size={13} /> : null}</span>
                        </div>
                      );
                    })}
                  </FluidList>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            document.body,
          )}
    </>
  );
}
