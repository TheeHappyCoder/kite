"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { addDays, addMonths, addYears, format, isSameDay, isSameMonth, setMonth, setYear, startOfMonth, startOfWeek } from "date-fns";
import { ArrowLeft01Icon, ArrowRight01Icon, Calendar03Icon, Cancel01Icon, Clock01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { blurFade, directionalBlurFade, springSnappy } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { FLUID_ITEM, FluidList } from "./fluid-hover";
import { Tooltip } from "./tooltip";
import { pad, ymd } from "@/lib/format";

// The house date and time pickers, used instead of native date and time inputs. DateTimePicker: a pill
// field that opens the month (its name zooms out to months and decades) beside the day's times (Starts /
// Ends, quick lengths), with Today, the picked day and the times along the bottom. TimePicker: one time
// from a quarter-hour list. Both are portalled and placed fixed under the field (above it when there's no
// room), like Select, and either can take a custom trigger. Arrow keys move the day, Page Up / Down the
// month, Enter or Escape close. `dateOnly` drops the times (all-day events, plain dates).

/** A day ("YYYY-MM-DD", or "" for none yet) and local wall-clock times ("HH:mm"). */
type DateTimeValue = { date: string; start: string; end: string };

const dayOf = (value: string) => {
  const [y, m, d] = value.split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
const minutes = (time: string) => {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
};
const clock = (total: number) => `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
const LAST = 23 * 60 + 59;
/** Every quarter hour. */
const TIMES = Array.from({ length: 96 }, (_, i) => clock(i * 15));

function duration(start: string, end: string) {
  const total = minutes(end) - minutes(start);
  if (total <= 0) return "";
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h${m ? ` ${m}m` : ""}` : `${m}m`;
}

/** What a custom trigger spreads on its button (the PDF editor's calendar mark, a time inside a pill). */
type TriggerProps = {
  ref: React.RefObject<HTMLButtonElement | null>;
  type: "button";
  "aria-label": string;
  "aria-haspopup": "dialog";
  "aria-expanded": boolean;
  onClick: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
};

const GAP = 6;

export type Spot = { left: number; width: number; top?: number; bottom?: number };

/**
 * A panel fixed beside its trigger: below if it fits, else above (anchored by its bottom edge), else pinned
 * inside the window. Closes on a click elsewhere, when the page scrolls under it, and when the window gets
 * wider or narrower (not on height alone: a phone's address bar or keyboard changes that).
 */
function usePopover() {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [spot, setSpot] = useState<Spot | null>(null);
  const open = !!spot;

  const place = (width: number, height: number) => {
    const r = trigger.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - GAP - 8;
    const above = r.top - GAP - 8;
    setSpot({
      // Centred on the trigger, kept on screen.
      left: Math.max(8, Math.min(r.left + r.width / 2 - width / 2, window.innerWidth - width - 8)),
      width,
      ...(below >= height ? { top: r.bottom + GAP } : above >= height ? { bottom: window.innerHeight - r.top + GAP } : { top: Math.max(8, window.innerHeight - height - 8) }),
    });
  };
  const hide = (focus = true) => {
    setSpot(null);
    if (focus) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const width = window.innerWidth;
    const dismiss = () => setSpot(null);
    const away = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node) && !trigger.current?.contains(e.target as Node)) dismiss();
    };
    const scrolled = (e: Event) => {
      if (!panel.current?.contains(e.target as Node)) dismiss();
    };
    const resized = () => {
      if (window.innerWidth !== width) dismiss();
    };
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("scroll", scrolled, true);
    window.addEventListener("resize", resized);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("scroll", scrolled, true);
      window.removeEventListener("resize", resized);
    };
  }, [open]);

  return { trigger, panel, spot, place, hide };
}

type Popover = ReturnType<typeof usePopover>;

function triggerProps(pop: Popover, label: string, show: () => void): TriggerProps {
  return {
    ref: pop.trigger,
    type: "button",
    "aria-label": label,
    "aria-haspopup": "dialog",
    "aria-expanded": !!pop.spot,
    onClick: () => (pop.spot ? pop.hide() : show()),
    onKeyDown: (e) => {
      if (!pop.spot && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        show();
      }
    },
  };
}

/** The floating card both pickers open (and the space editor: the house look for a small editing card). */
export function Panel({
  spot,
  panelRef,
  label,
  onKeyDown,
  style,
  className,
  children,
}: {
  spot: Spot | null;
  panelRef: React.RefObject<HTMLDivElement | null>;
  label: string;
  onKeyDown: (e: React.KeyboardEvent) => void;
  style?: React.CSSProperties;
  className?: string;
  children: React.ReactNode;
}) {
  if (typeof document === "undefined") return null;
  return createPortal(
    <AnimatePresence>
      {spot ? (
        <motion.div
          ref={panelRef}
          key="picker"
          role="dialog"
          aria-label={label}
          onKeyDown={onKeyDown}
          {...blurFade({ y: spot.bottom === undefined ? -6 : 6, blur: 6, speed: "moderate" })}
          style={{ position: "fixed", left: spot.left, top: spot.top, bottom: spot.bottom, width: spot.width, ...style }}
          className={cn(
            "z-50 max-h-[calc(100dvh-16px)] overflow-hidden rounded-2xl border border-pane-fg/[0.06] bg-pane-raised text-pane-fg shadow-[0_16px_40px_rgba(0,0,0,0.32)]",
            className,
          )}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

/** The pill field both pickers show by default (`className` resizes it); `onClear` adds a clear button while there's a value. */
function Field({
  props,
  icon,
  summary,
  empty,
  onClear,
  className,
  children,
}: {
  props: TriggerProps;
  icon: typeof Calendar03Icon;
  summary: string;
  empty: boolean;
  onClear?: () => void;
  className?: string;
  children: React.ReactNode;
}) {
  const clearable = !!onClear && !empty;
  return (
    <span className="relative flex min-w-0">
      <button
        {...props}
        className={cn(
          "flex h-10 w-full min-w-0 items-center gap-2.5 rounded-full border border-pane-border bg-pane-2 px-4 text-left text-[13.5px] outline-none transition-[background-color,border-color] duration-150 focus-visible:border-accent/60",
          props["aria-expanded"] ? "border-accent/60" : "hover:bg-pane-hover",
          clearable && "pr-10",
          className,
        )}
      >
        <Icon icon={icon} size={15} className="shrink-0 text-pane-muted" />
        <span key={summary} className={cn("blur-fade min-w-0 flex-1 truncate tabular-nums", empty && "text-pane-muted")}>
          {children}
        </span>
      </button>
      {clearable ? (
        // Placed by the wrapper: blur-fade animates translate, which would undo a centring translate on the button.
        <Tooltip label="Clear" className="absolute inset-y-0 right-2 flex items-center">
          <button
            type="button"
            aria-label="Clear"
            onClick={onClear}
            className="blur-fade grid size-6 place-items-center rounded-full text-pane-muted transition-[background-color,color,transform] duration-150 hover:bg-pane-hover hover:text-pane-fg active:scale-90"
          >
            <Icon icon={Cancel01Icon} size={12} />
          </button>
        </Tooltip>
      ) : null}
    </span>
  );
}

/** The wide panel's columns: month, times. */
const COLUMNS = [304, 196];
/** The narrow panel's widest. */
const COMPACT_WIDTH = 360;

/**
 * Where each cell sits. Wide: the month beside the times (the month's grid runs down beside the quick
 * lengths), a footer across both. Narrow (the window can't fit the columns): one column, the times under
 * the month. `height` is roughly the panel's, for placing it.
 */
function layout(dateOnly: boolean, compact: boolean) {
  const rows: { areas: string[]; size: string; px: number }[] = [];
  if (dateOnly) rows.push({ areas: ["mh"], size: "52px", px: 52 }, { areas: ["mb"], size: "auto", px: 272 });
  else if (compact)
    rows.push(
      { areas: ["mh"], size: "52px", px: 52 },
      { areas: ["mb"], size: "auto", px: 272 },
      { areas: ["th"], size: "52px", px: 52 },
      { areas: ["tb"], size: "176px", px: 176 },
      { areas: ["tf"], size: "48px", px: 48 },
    );
  else
    rows.push(
      { areas: ["mh", "th"], size: "52px", px: 52 },
      { areas: ["mb", "tb"], size: "minmax(0,1fr)", px: 224 },
      { areas: ["mb", "tf"], size: "48px", px: 48 },
    );
  rows.push({ areas: dateOnly || compact ? ["ft"] : ["ft", "ft"], size: "44px", px: 44 });
  return {
    areas: rows.map((r) => `"${r.areas.join(" ")}"`).join(" "),
    rows: rows.map((r) => r.size).join(" "),
    columns: compact || dateOnly ? "minmax(0,1fr)" : `${COLUMNS[0]}px minmax(0,1fr)`,
    width: dateOnly ? COLUMNS[0] : COLUMNS[0] + COLUMNS[1],
    height: rows.reduce((sum, r) => sum + r.px, 0),
  };
}

/** How far the month cell is zoomed out: days, the year's months, or a decade. */
type Zoom = "days" | "months" | "years";

export function DateTimePicker({
  value,
  onChange,
  dateOnly = false,
  label,
  placeholder = "Pick a date",
  onClear,
  trigger,
  className,
}: {
  value: DateTimeValue;
  onChange: (value: DateTimeValue) => void;
  dateOnly?: boolean;
  /** Accessible name of the field. */
  label: string;
  /** Shown while there's no date. */
  placeholder?: string;
  /** Adds a clear button to the field while there's a date. */
  onClear?: () => void;
  /** Draws the trigger instead of the pill field. */
  trigger?: (props: TriggerProps) => React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const pop = usePopover();
  const open = !!pop.spot;
  const selected = dayOf(value.date);
  const [today] = useState(() => new Date());
  // The month on show, and which way it last moved (for the slide).
  const [view, setView] = useState(() => startOfMonth(selected ?? today));
  const [dir, setDir] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("days");
  const [edit, setEdit] = useState<"start" | "end">("start");
  const [compact, setCompact] = useState(false);
  const grid = layout(dateOnly, compact);

  const show = () => {
    const wide = layout(dateOnly, false);
    const narrow = window.innerWidth < wide.width + 16;
    setCompact(narrow);
    setView(startOfMonth(selected ?? today));
    setDir(0);
    setZoom("days");
    setEdit("start");
    pop.place(narrow ? Math.min(COMPACT_WIDTH, window.innerWidth - 16) : wide.width, layout(dateOnly, narrow).height);
  };

  // Keyboard focus follows the picked day (today while there's none).
  useEffect(() => {
    if (open && zoom === "days") pop.panel.current?.querySelector<HTMLElement>(`[data-day="${value.date || ymd(today)}"]`)?.focus({ preventScroll: true });
  }, [open, value.date, view, zoom, today, pop.panel]);

  /** Back or forward a month, a year or a decade, by the zoom. */
  const step = (by: number) => {
    setDir(by);
    setView((v) => (zoom === "days" ? addMonths(v, by) : addYears(v, zoom === "months" ? by : by * 10)));
  };
  /** A click on a plain date is the whole job, so it closes; keys only move. */
  const pickDay = (day: Date, click = false) => {
    if (zoom !== "days") setZoom("days");
    if (!isSameMonth(day, view)) {
      setDir(day > view ? 1 : -1);
      setView(startOfMonth(day));
    }
    onChange({ ...value, date: ymd(day) });
    if (dateOnly && click) pop.hide();
  };
  const pickTime = (time: string) => {
    if (edit === "end") return onChange({ ...value, end: time });
    // A new start keeps the event's length.
    const length = Math.max(15, minutes(value.end) - minutes(value.start));
    onChange({ ...value, start: time, end: clock(Math.min(LAST, minutes(time) + length)) });
    setEdit("end");
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      // Escape steps back in from months or years first.
      if (e.key === "Escape" && zoom !== "days") {
        setDir(0);
        return setZoom("days");
      }
      return pop.hide();
    }
    if (e.key === "Tab") return;
    const by: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in by && (e.target as HTMLElement).dataset.day) {
      e.preventDefault();
      pickDay(addDays(selected ?? today, by[e.key]));
    } else if (zoom === "days" && (e.key === "PageUp" || e.key === "PageDown")) {
      e.preventDefault();
      const next = addMonths(selected ?? today, e.key === "PageUp" ? -1 : 1);
      setDir(e.key === "PageUp" ? -1 : 1);
      setView(startOfMonth(next));
      onChange({ ...value, date: ymd(next) });
    }
  };

  const thisYear = (d: Date) => d.getFullYear() === today.getFullYear();
  const day = selected ? format(selected, thisYear(selected) ? "EEE d MMM" : "EEE d MMM yyyy") : "";
  const summary = selected ? `${day}${dateOnly ? "" : ` · ${value.start} – ${value.end}`}` : placeholder;
  const length = dateOnly || !selected ? "" : duration(value.start, value.end);
  const props = triggerProps(pop, selected ? `${label}: ${summary}` : label, show);
  const longDay = selected ? format(selected, thisYear(selected) ? "EEEE d MMMM" : "EEEE d MMMM yyyy") : "No date yet";

  return (
    <>
      {trigger ? (
        trigger(props)
      ) : (
        <Field props={props} icon={Calendar03Icon} summary={summary} empty={!selected} onClear={onClear} className={className}>
          {summary}
          {length ? <span className="text-pane-muted"> · {length}</span> : null}
        </Field>
      )}
      <Panel
        spot={pop.spot}
        panelRef={pop.panel}
        label={label}
        onKeyDown={onKey}
        style={{ gridTemplateAreas: grid.areas, gridTemplateColumns: grid.columns, gridTemplateRows: grid.rows }}
        // One grid for every part: the header and footer rows line up across the month and the times.
        className="grid overflow-y-auto overflow-x-hidden [scrollbar-width:none]"
      >
        <Month
          id={id}
          view={view}
          dir={dir}
          zoom={zoom}
          selected={selected}
          today={today}
          onStep={step}
          onZoom={(next, at) => {
            setDir(0);
            setZoom(next);
            if (at) setView(startOfMonth(at));
          }}
          onPick={(d) => pickDay(d, true)}
        />
        {dateOnly ? null : (
          <Times
            id={id}
            value={value}
            compact={compact}
            edit={edit}
            onEdit={setEdit}
            onPick={pickTime}
            onEnd={(end) => {
              onChange({ ...value, end });
              setEdit("end");
            }}
          />
        )}
        <div className={cn(FOOTER, "justify-between gap-3 px-4 text-[12.5px] [grid-area:ft]")}>
          <button type="button" onClick={() => pickDay(today, true)} className="shrink-0 rounded-md font-semibold text-accent transition-opacity duration-150 hover:opacity-75">
            Today
          </button>
          <span key={longDay} className={cn("blur-fade min-w-0 truncate text-pane-muted", !dateOnly && "text-center")}>
            {longDay}
          </span>
          {dateOnly ? null : (
            <span key={`${value.start}-${value.end}`} className="blur-fade shrink-0 tabular-nums text-pane-fg/90">
              {value.start} – {value.end}
            </span>
          )}
        </div>
      </Panel>
    </>
  );
}

/** Shared by both halves, so their rows meet in one line. */
export const HEADER = "flex min-w-0 items-center border-b border-pane-fg/[0.06]";
export const FOOTER = "flex min-w-0 items-center border-t border-pane-fg/[0.06]";
/** The accent outline on whatever is chosen in a list or a segmented control. */
const CHOSEN = "bg-accent/15 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_65%,transparent)]";

/**
 * The month's cells: its name (a button that zooms out to the year's months, then to the decade) with
 * arrows, and the day grid, or the months or years to jump to.
 */
function Month({
  id,
  view,
  dir,
  zoom,
  selected,
  today,
  onStep,
  onZoom,
  onPick,
}: {
  id: string;
  view: Date;
  dir: number;
  zoom: Zoom;
  selected: Date | null;
  today: Date;
  onStep: (by: number) => void;
  /** Zooms to `next`, showing the month of `at` when given. */
  onZoom: (next: Zoom, at?: Date) => void;
  onPick: (day: Date) => void;
}) {
  const year = view.getFullYear();
  const decade = year - (year % 10);
  const title = zoom === "days" ? format(view, "MMMM yyyy") : zoom === "months" ? String(year) : `${decade} – ${decade + 9}`;
  const unit = zoom === "days" ? "month" : zoom === "months" ? "year" : "decade";
  const slide = { custom: { x: dir, y: 0 }, variants: directionalBlurFade, initial: "initial", animate: "animate", exit: "exit" } as const;

  return (
    <>
      <div className={cn(HEADER, "gap-1.5 px-3 [grid-area:mh]")}>
        <div className="relative h-8 min-w-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout" custom={{ x: dir, y: 0 }}>
            <motion.button
              key={`${zoom}-${title}`}
              {...slide}
              type="button"
              disabled={zoom === "years"}
              onClick={() => onZoom(zoom === "days" ? "months" : "years")}
              aria-label={zoom === "years" ? title : `${title}: pick a ${zoom === "days" ? "month" : "year"}`}
              className="absolute inset-y-0 left-0 flex max-w-full items-center rounded-lg px-1.5 text-[15px] font-semibold tabular-nums transition-[background-color] duration-150 enabled:hover:bg-pane-hover disabled:cursor-default"
            >
              <span className="truncate">{title}</span>
            </motion.button>
          </AnimatePresence>
        </div>
        <Step icon={ArrowLeft01Icon} label={`Previous ${unit}`} onClick={() => onStep(-1)} />
        <Step icon={ArrowRight01Icon} label={`Next ${unit}`} onClick={() => onStep(1)} />
      </div>

      <div className="px-3 pb-2.5 pt-3 [grid-area:mb]">
        <div className="relative">
          <AnimatePresence initial={false} mode="popLayout" custom={{ x: dir, y: 0 }}>
            <motion.div key={`${zoom}-${zoom === "days" ? ymd(view) : zoom === "months" ? year : decade}`} {...slide}>
              {zoom === "days" ? (
                <Days id={id} view={view} selected={selected} today={today} onPick={onPick} />
              ) : (
                <Choices
                  id={id}
                  label={title}
                  items={
                    zoom === "months"
                      ? Array.from({ length: 12 }, (_, m) => {
                          const at = setMonth(view, m);
                          return {
                            key: m,
                            label: format(at, "MMM"),
                            chosen: !!selected && isSameMonth(selected, at),
                            now: isSameMonth(today, at),
                            outside: false,
                            pick: () => onZoom("days", at),
                          };
                        })
                      : // The decade with a year either side, those two muted (like the days of other months).
                        Array.from({ length: 12 }, (_, i) => {
                          const y = decade - 1 + i;
                          return {
                            key: y,
                            label: String(y),
                            chosen: selected?.getFullYear() === y,
                            now: today.getFullYear() === y,
                            outside: i === 0 || i === 11,
                            pick: () => onZoom("months", setYear(view, y)),
                          };
                        })
                  }
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </>
  );
}

/** The weekday names and six weeks of days. */
function Days({ id, view, selected, today, onPick }: { id: string; view: Date; selected: Date | null; today: Date; onPick: (day: Date) => void }) {
  const first = startOfWeek(view, { weekStartsOn: 1 });
  const days = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  return (
    <>
      <div className="grid grid-cols-7 pb-2">
        {days.slice(0, 7).map((d) => (
          <span key={d.getDay()} className="text-center text-[11.5px] font-medium text-pane-muted">
            {format(d, "EEEEEE")}
          </span>
        ))}
      </div>
      <FluidList tone="pane" axis="xy" role="grid" aria-label={format(view, "MMMM yyyy")} className="grid grid-cols-7 gap-y-1">
        {days.map((d) => {
          const isSelected = !!selected && isSameDay(d, selected);
          const isToday = isSameDay(d, today);
          const inMonth = isSameMonth(d, view);
          return (
            <button
              key={ymd(d)}
              {...FLUID_ITEM}
              type="button"
              role="gridcell"
              data-day={ymd(d)}
              // The picked day takes Tab, else today.
              tabIndex={isSelected || (!selected && isToday) ? 0 : -1}
              aria-selected={isSelected}
              aria-label={format(d, "EEEE d MMMM yyyy")}
              onClick={() => onPick(d)}
              className={cn(
                "relative mx-auto grid size-9 place-items-center rounded-lg text-[13.5px] tabular-nums outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-accent/50",
                isSelected ? "font-semibold text-accent-fg" : inMonth ? "text-pane-fg" : "text-pane-muted/40",
              )}
            >
              {isSelected ? <motion.span layoutId={`${id}-day`} transition={springSnappy} className="absolute inset-0 rounded-lg bg-accent" /> : null}
              <span className="relative">{format(d, "d")}</span>
              {isToday ? <span className={cn("absolute bottom-1 size-1 rounded-full", isSelected ? "bg-accent-fg" : "bg-accent")} /> : null}
            </button>
          );
        })}
      </FluidList>
    </>
  );
}

/** Months or years to jump to, three across, filling the days' height so the panel keeps its size. */
function Choices({ id, label, items }: { id: string; label: string; items: { key: number; label: string; chosen: boolean; now: boolean; outside: boolean; pick: () => void }[] }) {
  return (
    <FluidList tone="pane" axis="xy" role="grid" aria-label={label} className="grid h-[262px] grid-cols-3 grid-rows-4 gap-1.5 py-1">
      {items.map((item, i) => (
        <button
          key={item.key}
          {...FLUID_ITEM}
          type="button"
          role="gridcell"
          aria-selected={item.chosen}
          onClick={item.pick}
          className={cn(
            "blur-fade relative grid place-items-center rounded-lg text-[13.5px] tabular-nums outline-none transition-[background-color,color] duration-150 focus-visible:ring-2 focus-visible:ring-accent/50",
            item.chosen ? "font-semibold text-accent-fg" : item.outside ? "text-pane-muted/40" : "text-pane-fg",
          )}
          style={{ "--i": i } as React.CSSProperties}
        >
          {item.chosen ? <motion.span layoutId={`${id}-choice`} transition={springSnappy} className="absolute inset-0 rounded-lg bg-accent" /> : null}
          <span className="relative">{item.label}</span>
          {item.now ? <span className={cn("absolute bottom-1.5 size-1 rounded-full", item.chosen ? "bg-accent-fg" : "bg-accent")} /> : null}
        </button>
      ))}
    </FluidList>
  );
}

function Step({ icon, label, onClick }: { icon: typeof ArrowLeft01Icon; label: string; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="grid size-8 shrink-0 place-items-center rounded-lg border border-pane-border bg-pane-2/40 text-pane-fg/80 transition-[background-color,color,transform] duration-150 hover:bg-pane-hover hover:text-pane-fg active:scale-90"
      >
        <Icon icon={icon} size={15} />
      </button>
    </Tooltip>
  );
}

/** One time in a list: the chosen one outlined in the accent with a tick. */
function TimeRow({
  id,
  time,
  chosen,
  disabled,
  onPick,
}: {
  id: string;
  time: string;
  chosen: boolean;
  disabled?: boolean;
  onPick: (time: string) => void;
}) {
  return (
    <button
      {...FLUID_ITEM}
      type="button"
      data-time={time}
      data-chosen={chosen}
      tabIndex={chosen ? 0 : -1}
      disabled={disabled}
      onClick={() => onPick(time)}
      className={cn(
        "relative flex h-8 shrink-0 items-center justify-between rounded-lg px-3 text-[13.5px] tabular-nums outline-none transition-[background-color,color,opacity] duration-150 focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-default disabled:opacity-30",
        chosen ? "font-semibold text-pane-fg" : "text-pane-fg/80",
      )}
    >
      {chosen ? <motion.span layoutId={`${id}-time`} transition={springSnappy} className={cn("absolute inset-0 rounded-lg", CHOSEN)} /> : null}
      <span className="relative">{time}</span>
      {chosen ? <Icon icon={Tick02Icon} size={15} className="blur-fade relative text-accent" /> : null}
    </button>
  );
}

const QUICK = [
  { mins: 30, label: "30m" },
  { mins: 60, label: "1h" },
  { mins: 90, label: "1½h" },
  { mins: 120, label: "2h" },
];

/** The times' three cells: Starts / Ends, the day's quarter hours, and quick lengths. */
function Times({
  id,
  value,
  compact,
  edit,
  onEdit,
  onPick,
  onEnd,
}: {
  id: string;
  value: DateTimeValue;
  compact: boolean;
  edit: "start" | "end";
  onEdit: (edit: "start" | "end") => void;
  onPick: (time: string) => void;
  /** A quick length: sets the end only. */
  onEnd: (time: string) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const current = edit === "start" ? value.start : value.end;
  // One list for Starts and Ends (so switching never swaps content under the scroll): in Ends, times up to
  // the start are dimmed and can't be picked.
  const options = value.end === clock(LAST) ? [...TIMES, clock(LAST)] : TIMES;
  const length = minutes(value.end) - minutes(value.start);

  // The chosen time sits in the middle of the column: at once when the panel opens, gliding there on a switch.
  const placed = useRef(false);
  useLayoutEffect(() => {
    const box = list.current;
    const chosen = box?.querySelector<HTMLElement>("[data-chosen=true]");
    if (!box || !chosen) return;
    const offset = chosen.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: offset - box.clientHeight / 2 + chosen.offsetHeight / 2, behavior: placed.current ? "smooth" : "instant" });
    placed.current = true;
  }, [edit]);

  const side = compact ? "" : "border-l border-pane-fg/[0.06]";
  return (
    <>
      <div className={cn(HEADER, side, "px-3 [grid-area:th]", compact && "border-t")}>
        <div className="grid h-8 w-full grid-cols-2 gap-0.5 rounded-lg border border-pane-border bg-pane-2/40 p-0.5">
          {(["start", "end"] as const).map((which) => {
            const active = edit === which;
            return (
              <button
                key={which}
                type="button"
                onClick={() => onEdit(which)}
                aria-pressed={active}
                className={cn(
                  "relative rounded-md text-[12.5px] transition-[color,font-weight] duration-150",
                  active ? "font-semibold text-pane-fg" : "font-medium text-pane-muted hover:text-pane-fg",
                )}
              >
                {active ? <motion.span layoutId={`${id}-edit`} transition={springSnappy} className={cn("absolute inset-0 rounded-md", CHOSEN)} /> : null}
                <span className="relative">{which === "start" ? "Starts" : "Ends"}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className={cn(side, "relative min-h-0 [grid-area:tb]")}>
        <div ref={list} className="scroll-fade absolute inset-0 overflow-y-auto px-2">
          <FluidList tone="pane" className="flex flex-col gap-0.5 py-2">
            {options.map((time) => (
              <TimeRow key={time} id={id} time={time} chosen={time === current} disabled={edit === "end" && time <= value.start} onPick={onPick} />
            ))}
          </FluidList>
        </div>
      </div>

      <div className={cn(side, "flex items-center border-t border-pane-fg/[0.06] px-3 [grid-area:tf]")}>
        <div className="grid w-full grid-cols-4 gap-1.5">
          {QUICK.map(({ mins, label }) => {
            const end = clock(Math.min(LAST, minutes(value.start) + mins));
            const active = length === mins;
            return (
              <button
                key={mins}
                type="button"
                onClick={() => onEnd(end)}
                aria-label={`Lasts ${duration("00:00", clock(mins))}`}
                aria-pressed={active}
                className={cn(
                  "relative flex h-7 items-center justify-center rounded-lg border text-[12px] tabular-nums transition-[color,border-color,font-weight,transform] duration-150 active:scale-95",
                  active ? "border-transparent font-semibold text-pane-fg" : "border-pane-border text-pane-muted hover:text-pane-fg",
                )}
              >
                {active ? <motion.span layoutId={`${id}-quick`} transition={springSnappy} className={cn("absolute inset-0 rounded-lg", CHOSEN)} /> : null}
                <span className="relative whitespace-nowrap">{label}</span>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}

const TIME_WIDTH = 168;
const TIME_HEIGHT = 296;

/**
 * One time of day ("HH:mm") from the quarter hours (a time off the quarter, like 09:05, stays in the list
 * while it's the value). The list opens on the value; arrow keys move along it, a click or Enter picks
 * (one `onChange`) and closes, Escape closes without a change.
 */
export function TimePicker({
  value,
  onChange,
  label,
  trigger,
  className,
}: {
  value: string;
  onChange: (time: string) => void;
  /** Accessible name of the field. */
  label: string;
  /** Draws the trigger instead of the pill field. */
  trigger?: (props: TriggerProps) => React.ReactNode;
  className?: string;
}) {
  const id = useId();
  const pop = usePopover();
  const open = !!pop.spot;
  const list = useRef<HTMLDivElement>(null);
  const options = TIMES.includes(value) ? TIMES : [...TIMES, value].sort();

  const show = () => pop.place(TIME_WIDTH, TIME_HEIGHT);
  const pick = (time: string) => {
    onChange(time);
    pop.hide();
  };

  // The chosen time sits in the middle of the list and takes focus.
  useLayoutEffect(() => {
    const box = list.current;
    const chosen = box?.querySelector<HTMLElement>("[data-chosen=true]");
    if (!open || !box || !chosen) return;
    const offset = chosen.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    box.scrollTo({ top: offset - box.clientHeight / 2 + chosen.offsetHeight / 2, behavior: "instant" });
    chosen.focus({ preventScroll: true });
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    const row = (e.target as HTMLElement).dataset.time;
    if (e.key === "Escape" || e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      return e.key === "Enter" && row ? pick(row) : pop.hide();
    }
    const by: Record<string, number> = { ArrowUp: -1, ArrowDown: 1, PageUp: -4, PageDown: 4, Home: -options.length, End: options.length };
    if (!(e.key in by)) return;
    e.preventDefault();
    const at = options.indexOf(row ?? value);
    const next = options[Math.max(0, Math.min(options.length - 1, at + by[e.key]))];
    const el = list.current?.querySelector<HTMLElement>(`[data-time="${next}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const props = triggerProps(pop, `${label}: ${value}`, show);

  return (
    <>
      {trigger ? (
        trigger(props)
      ) : (
        <Field props={props} icon={Clock01Icon} summary={value} empty={false} className={className}>
          {value}
        </Field>
      )}
      <Panel spot={pop.spot} panelRef={pop.panel} label={label} onKeyDown={onKey} style={{ height: TIME_HEIGHT }}>
        <div ref={list} className="scroll-fade h-full overflow-y-auto px-2">
          <FluidList tone="pane" className="flex flex-col gap-0.5 py-2">
            {options.map((time) => (
              <TimeRow key={time} id={id} time={time} chosen={time === value} onPick={pick} />
            ))}
          </FluidList>
        </div>
      </Panel>
    </>
  );
}
