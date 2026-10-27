"use client";

import { useEffect, useImperativeHandle, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { motion } from "motion/react";
import { addDays, addMonths, endOfMonth, format, isBefore, isSameDay, isSameMonth, startOfDay, startOfMonth } from "date-fns";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowUpRight01Icon,
  Calendar03Icon,
  CalendarIcon,
  GlobeIcon,
  Location01Icon,
  Mail01Icon,
  Menu01Icon,
  RepeatIcon,
  Tick02Icon,
  UserIcon,
  Video01Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import type { CalendarEvent } from "@/lib/calendar/event";
import type { AttendeeStatus } from "@/lib/calendar/invite";
import type { PickedWhen } from "@/lib/calendar/when";
import { demoEvents, eventSpan, eventsOn, placeAllDay, placeTimed, weekDays, weekStart } from "@/lib/calendar/week";
import { blurFade, springSnappy } from "@/lib/motion";
import { serviceName } from "@/lib/mail/providers";
import { accountName, type Account, type Thread } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { AccountFace } from "../mail/account-face";
import type { TodayTarget } from "../home/day";
import { Dialog } from "../ui/dialog";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Tooltip } from "../ui/tooltip";
import { pad, ymd } from "@/lib/format";

const HOUR_PX = 48;

type CalendarMode = "month" | "week" | "day" | "agenda";
const MODES: { id: CalendarMode; label: string; icon: IconData }[] = [
  { id: "month", label: "Month", icon: ViewIcon },
  { id: "week", label: "Week", icon: Calendar03Icon },
  { id: "day", label: "Day", icon: CalendarIcon },
  { id: "agenda", label: "Agenda", icon: Menu01Icon },
];

/** What mail-app's shortcuts (`[`, `]`, `.`) do to the open calendar. */
export type CalendarHandle = { move: (direction: 1 | -1) => void; today: () => void };

type Props = {
  ref?: React.Ref<CalendarHandle>;
  live: boolean;
  accounts: Account[];
  /** Sample threads in demo mode (their invites stand in for the calendar). */
  demoThreads: Thread[];
  /** Bumped when the local copy of the calendars changed. */
  refreshKey: number;
  onOpen: (target: TodayTarget) => void;
  /** "Add to calendar", prefilled with the day (and time) the user picked. */
  onAdd: (when: PickedWhen | null) => void;
};

// Per-viewer conveniences kept in this browser: the chosen layout and the accounts left out.
const MODE_KEY = "kite-calendar-mode";
const HIDDEN_KEY = "kite-calendar-hidden";
const listeners = new Set<() => void>();
const read = (key: string) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice holds for this page load only.
  }
  listeners.forEach((l) => l());
};
function useStored(key: string) {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => read(key),
    () => "",
  );
}

/** The days a layout shows around `day`. */
function rangeFor(mode: CalendarMode, day: Date) {
  if (mode === "month") {
    const from = weekStart(startOfMonth(day));
    return { from, to: addDays(from, 42) };
  }
  if (mode === "week") {
    const from = weekStart(day);
    return { from, to: addDays(from, 7) };
  }
  if (mode === "day") return { from: startOfDay(day), to: addDays(startOfDay(day), 1) };
  const from = startOfMonth(day);
  return { from, to: addDays(endOfMonth(day), 1) };
}

/**
 * Calendar: the accounts' own calendars by month (with the picked day's events beside it), week, day
 * or agenda. Read-only: an event opens a card (Join, open in your calendar, the invite email), an
 * empty day or slot opens "Add to calendar". Which accounts show is picked here and kept in this browser.
 * Days outside the synced window are read once and not stored.
 */
export function CalendarView({ ref, live, accounts, demoThreads, refreshKey, onOpen, onAdd }: Props) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, []);
  const storedMode = useStored(MODE_KEY);
  const mode: CalendarMode = MODES.some((m) => m.id === storedMode) ? (storedMode as CalendarMode) : "month";
  const hiddenRaw = useStored(HIDDEN_KEY);
  const hidden = useMemo(() => new Set(hiddenRaw ? hiddenRaw.split(",") : []), [hiddenRaw]);

  const [day, setDay] = useState(() => startOfDay(new Date()));
  const move = (direction: 1 | -1) =>
    setDay((d) => (mode === "month" || mode === "agenda" ? addMonths(d, direction) : addDays(d, direction * (mode === "week" ? 7 : 1))));
  useImperativeHandle(ref, () => ({ move, today: () => setDay(startOfDay(new Date())) }));

  // Accounts with a calendar Kite may read (all of them in demo mode), and the ones shown.
  const usable = live ? accounts.filter((a) => a.calendar === true) : accounts;
  const shown = usable.filter((a) => !hidden.has(a.id));
  const scope = shown.map((a) => a.id).join(",");

  const { from, to } = useMemo(() => rangeFor(mode, day), [mode, day]);
  const [loaded, setLoaded] = useState<{ key: string; events: CalendarEvent[]; failed: boolean } | null>(null);
  // Bumped when an event added in Kite is removed from its card.
  const [removed, setRemoved] = useState(0);
  const key = `${from.toISOString()}|${to.toISOString()}|${scope}|${refreshKey}|${removed}`;
  useEffect(() => {
    if (!live || !scope) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ account: scope, from: from.toISOString(), to: to.toISOString() });
    fetch(`/api/calendar/events?${params}`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("Calendar couldn't be read"))))
      .then((data: { events: CalendarEvent[]; failed?: string[] }) => setLoaded({ key, events: data.events, failed: !!data.failed?.length }))
      .catch(() => {
        if (!controller.signal.aborted) setLoaded({ key, events: [], failed: true });
      });
    return () => controller.abort();
  }, [live, key, scope, from, to]);

  const demo = useMemo(() => (live ? [] : demoEvents(demoThreads)), [live, demoThreads]);
  const events = !scope ? [] : live ? (loaded?.key === key ? loaded.events : null) : demo.filter((e) => !hidden.has(e.accountId));
  const failed = live && loaded?.key === key && loaded.failed;
  const color = (id: string) => (shown.length > 1 ? accounts.find((a) => a.id === id)?.color : undefined);

  const [open, setOpen] = useState<CalendarEvent | null>(null);
  const last = addDays(to, -1);
  const title =
    mode === "month" || mode === "agenda"
      ? format(day, "MMMM yyyy")
      : mode === "day"
        ? format(day, "EEEE d MMMM")
        : isSameMonth(from, last)
          ? `${format(from, "d")} – ${format(last, "d MMMM yyyy")}`
          : `${format(from, "d MMM")} – ${format(last, "d MMM yyyy")}`;
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const missing = live ? accounts.filter((a) => a.calendar === false) : [];
  const unit = mode === "agenda" ? "month" : mode;

  return (
    <section className="@container flex h-full flex-col overflow-hidden rounded-2xl bg-pane pane-on-sky text-pane-fg">
      <header className="relative z-20 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-pane-border px-3 py-3 @md:px-4">
        <div className="flex min-w-0 items-center gap-1">
          <NavButton icon={ArrowLeft01Icon} label={`Previous ${unit}`} shortcut="calendarPrev" onClick={() => move(-1)} />
          <Tooltip label="Back to today" shortcut="calendarToday">
            <button
              onClick={() => setDay(startOfDay(new Date()))}
              className="min-w-0 truncate rounded-lg px-2 py-1 text-[14px] font-semibold tabular-nums transition-colors duration-150 hover:bg-pane-hover"
            >
              {title}
            </button>
          </Tooltip>
          <NavButton icon={ArrowRight01Icon} label={`Next ${unit}`} shortcut="calendarNext" onClick={() => move(1)} />
        </div>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-2">
          <AccountPicker usable={usable} missing={missing} hidden={hidden} />
          <ModeSwitch mode={mode} />
          <NavButton icon={Add01Icon} label="Add to calendar" shortcut="addToCalendar" onClick={() => onAdd(mode === "month" || mode === "day" ? { date: ymd(day) } : null)} />
        </div>
      </header>

      {live && !usable.length ? (
        <Notice>Turn on &ldquo;Use your calendar&rdquo; for an account in Settings → Accounts to see its events here.</Notice>
      ) : !shown.length ? (
        <Notice>No calendars picked. Choose which accounts to show from the calendars menu above.</Notice>
      ) : failed ? (
        <Notice>Some calendars couldn&apos;t be read for these days. They&apos;ll show again when the connection is back.</Notice>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        {mode === "month" ? (
          <MonthView day={day} now={now} events={events} color={color} onPick={setDay} onOpen={setOpen} onAdd={onAdd} />
        ) : mode === "week" || mode === "day" ? (
          <TimeGrid days={mode === "week" ? weekDays(from) : [from]} now={now} events={events ?? []} color={color} onOpen={setOpen} onAdd={onAdd} />
        ) : (
          <Agenda from={from} to={to} now={now} events={events} color={color} onOpen={setOpen} />
        )}
      </div>

      <footer className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-pane-border px-4 py-2.5 text-[11.5px] text-pane-muted">
        <span className="flex items-center gap-1.5">
          <Icon icon={GlobeIcon} size={13} />
          Times in {zone.replace(/_/g, " ")}
        </span>
        <span>{!live ? "Sample calendar: connect your mail to see your own" : `${shown.length} of ${usable.length} calendar${usable.length === 1 ? "" : "s"} shown`}</span>
        {events === null ? <span>Reading…</span> : null}
      </footer>

      {open ? (
        <EventCard
          event={open}
          live={live}
          accounts={accounts}
          demoThreads={demoThreads}
          onClose={() => setOpen(null)}
          onRemoved={() => {
            setOpen(null);
            setRemoved((n) => n + 1);
          }}
          onOpen={(target) => {
            setOpen(null);
            onOpen(target);
          }}
        />
      ) : null}
    </section>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return <p className="mx-3 mt-3 rounded-xl border border-dashed border-pane-muted/40 px-3.5 py-2.5 text-[12.5px] text-pane-muted @md:mx-4">{children}</p>;
}

function NavButton({ icon, label, shortcut, onClick }: { icon: IconData; label: string; shortcut: "calendarPrev" | "calendarNext" | "addToCalendar"; onClick: () => void }) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        aria-label={label}
        onClick={onClick}
        className="grid size-8 shrink-0 place-items-center rounded-lg bg-pane-2 text-pane-fg/80 transition-[background-color,color] duration-150 hover:bg-pane-hover hover:text-pane-fg"
      >
        <Icon icon={icon} size={16} />
      </button>
    </Tooltip>
  );
}

/** Month / Week / Day / Agenda: a pill track with the sliding indicator. */
function ModeSwitch({ mode }: { mode: CalendarMode }) {
  return (
    <FluidList tone="pill" axis="x" role="radiogroup" aria-label="Layout" className="flex items-center gap-0.5 rounded-full bg-pane-2 p-0.5">
      {MODES.map((m) => {
        const active = m.id === mode;
        return (
          <button
            key={m.id}
            {...FLUID_ITEM}
            role="radio"
            aria-checked={active}
            onClick={() => write(MODE_KEY, m.id)}
            className={cn(
              "relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-[color,background-color,font-weight] duration-150",
              active ? "font-semibold text-pane-fg" : "font-medium text-pane-muted data-[lit]:text-pane-fg",
            )}
          >
            {active ? (
              <motion.span
                layoutId="calendar-mode"
                transition={springSnappy}
                className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
              />
            ) : null}
            <Icon icon={m.icon} size={14} className="relative hidden @2xl:block" />
            <span className="relative">{m.label}</span>
          </button>
        );
      })}
    </FluidList>
  );
}

/** Which accounts' calendars show: tick boxes, remembered in this browser. */
function AccountPicker({ usable, missing, hidden }: { usable: Account[]; missing: Account[]; hidden: Set<string> }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (!usable.length && !missing.length) return null;
  const shown = usable.filter((a) => !hidden.has(a.id));
  const toggle = (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    write(HIDDEN_KEY, [...next].join(","));
  };

  return (
    <div ref={box} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex h-[34px] max-w-[220px] items-center gap-2 rounded-full bg-pane-2 pl-3 pr-2.5 text-[12.5px] font-medium transition-colors duration-150 hover:bg-pane-hover"
      >
        <span className="flex shrink-0 -space-x-1">
          {(shown.length ? shown : usable).slice(0, 4).map((a) => (
            <span key={a.id} className={cn("size-2.5 rounded-full ring-2 ring-pane-2", !shown.length && "opacity-40")} style={{ background: a.color }} />
          ))}
        </span>
        <span className="truncate">{shown.length === usable.length ? "All calendars" : shown.length === 1 ? accountName(shown[0]) : `${shown.length} calendars`}</span>
        <Icon icon={ArrowDown01Icon} size={14} className="shrink-0 text-pane-muted" />
      </button>
      {open ? (
        <motion.div {...blurFade({ y: -4 })} className="absolute right-0 top-[calc(100%+6px)] z-30 w-[320px] max-w-[85vw] rounded-2xl border border-pane-border bg-pane-raised p-1.5 shadow-xl">
          <p className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">Show calendars</p>
          <FluidList tone="pane" className="flex flex-col">
            {usable.map((a) => {
              const on = !hidden.has(a.id);
              return (
                <button
                  key={a.id}
                  {...FLUID_ITEM}
                  role="checkbox"
                  aria-checked={on}
                  onClick={() => toggle(a.id)}
                  className="flex min-w-0 items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-[background-color] duration-150"
                >
                  <AccountFace account={a} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium">{accountName(a)}</span>
                    <span className="block truncate text-[11.5px] text-pane-muted">
                      {a.email} · {serviceName(a)}
                    </span>
                  </span>
                  <span
                    className="grid size-4 shrink-0 place-items-center rounded-[5px] border transition-colors duration-150"
                    style={on ? { background: a.color, borderColor: a.color } : { borderColor: "var(--pane-border)" }}
                  >
                    {on ? <Icon icon={Tick02Icon} size={11} className="text-white" /> : null}
                  </span>
                </button>
              );
            })}
          </FluidList>
          {missing.length ? (
            <p className="px-2.5 pb-1.5 pt-2 text-[11.5px] leading-snug text-pane-muted">
              {missing.map(accountName).join(", ")}: turn on &ldquo;Use your calendar&rdquo; in Settings → Accounts.
            </p>
          ) : null}
        </motion.div>
      ) : null}
    </div>
  );
}

const timeOf = (event: CalendarEvent) => {
  if (event.allDay) return "All day";
  const { start, end } = eventSpan(event);
  return `${format(start, "HH:mm")}–${format(end, "HH:mm")}`;
};

/** A month of big day tiles, the picked day's events beside it (below on narrow panes). */
function MonthView({
  day,
  now,
  events,
  color,
  onPick,
  onOpen,
  onAdd,
}: {
  day: Date;
  now: Date;
  events: CalendarEvent[] | null;
  color: (accountId: string) => string | undefined;
  onPick: (day: Date) => void;
  onOpen: (event: CalendarEvent) => void;
  onAdd: (when: PickedWhen) => void;
}) {
  const days = useMemo(() => {
    const first = weekStart(startOfMonth(day));
    return Array.from({ length: 42 }, (_, i) => addDays(first, i));
  }, [day]);
  // Six rows only when the month needs them.
  const shownDays = isSameMonth(days[35], day) ? days : days.slice(0, 35);
  const today = startOfDay(now);
  const picked = events ? eventsOn(events, day) : [];

  return (
    <div className="scroll-fade flex min-h-0 flex-1 flex-col overflow-y-auto @3xl:flex-row @3xl:overflow-hidden">
      <div className="min-w-0 flex-1 px-3 pb-3 pt-3 @md:px-4 @3xl:overflow-y-auto">
        <div className="mb-1 grid grid-cols-7">
          {days.slice(0, 7).map((d) => (
            <span key={d.toISOString()} className="text-center text-[11.5px] font-medium text-pane-muted">
              {format(d, "EEE")}
            </span>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1 @md:gap-1.5">
          {shownDays.map((d) => {
            const inMonth = isSameMonth(d, day);
            const isPicked = isSameDay(d, day);
            const isToday = isSameDay(d, today);
            const past = isBefore(d, today);
            const dots = events ? eventsOn(events, d) : [];
            return (
              <button
                key={d.toISOString()}
                onClick={() => onPick(d)}
                onDoubleClick={() => onAdd({ date: ymd(d) })}
                aria-label={`${format(d, "EEEE d MMMM")}: ${dots.length ? `${dots.length} event${dots.length > 1 ? "s" : ""}` : "nothing planned"}`}
                aria-pressed={isPicked}
                className={cn(
                  "relative flex aspect-[5/4] min-h-11 flex-col items-center justify-center gap-1 rounded-2xl text-[15px] font-semibold tabular-nums transition-[background-color,color] duration-150 @3xl:text-[17px]",
                  isPicked ? "bg-pane-fg text-pane" : "hover:bg-pane-hover",
                  !isPicked && (!inMonth ? "text-pane-muted/40" : past ? "text-pane-muted/70" : isToday ? "text-accent" : "text-pane-fg"),
                )}
              >
                {format(d, "d")}
                <span className="flex h-1.5 items-center gap-0.5">
                  {dots.slice(0, 3).map((e) => (
                    <span key={e.id} className={cn("size-1.5 rounded-full", isPicked && "ring-1 ring-pane")} style={{ background: color(e.accountId) ?? "var(--accent)" }} />
                  ))}
                </span>
                {isToday && !isPicked ? <span className="absolute inset-x-[35%] bottom-1.5 h-0.5 rounded-full bg-accent" /> : null}
              </button>
            );
          })}
        </div>
      </div>

      <aside className="shrink-0 border-t border-pane-border px-3 py-4 @md:px-4 @3xl:w-[340px] @3xl:overflow-y-auto @3xl:border-l @3xl:border-t-0">
        <div className="mb-3 flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{isSameDay(day, today) ? "Today" : format(day, "EEEE")}</h2>
            <p className="text-[12.5px] text-pane-muted">{format(day, "d MMMM yyyy")}</p>
          </div>
          <Tooltip label="Add to calendar on this day">
            <button
              aria-label="Add to calendar on this day"
              onClick={() => onAdd({ date: ymd(day) })}
              className="grid size-8 shrink-0 place-items-center rounded-lg bg-pane-2 text-pane-fg/80 transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={Add01Icon} size={15} />
            </button>
          </Tooltip>
        </div>
        {events === null ? (
          <div className="grid grid-cols-2 gap-2">
            {[0, 1].map((i) => (
              <div key={i} className="h-[78px] animate-pulse rounded-xl bg-pane-2" />
            ))}
          </div>
        ) : picked.length ? (
          <FluidList key={ymd(day)} tone="pane" axis="xy" className="grid grid-cols-2 gap-2">
            {picked.map((event, i) => (
              <EventTile key={event.id} event={event} now={now} color={color(event.accountId)} index={i} onOpen={onOpen} />
            ))}
          </FluidList>
        ) : (
          <button
            key={ymd(day)}
            onClick={() => onAdd({ date: ymd(day) })}
            className="blur-fade flex h-[96px] w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-pane-muted/40 text-[13px] font-medium text-pane-muted transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg"
          >
            Nothing planned
            <span className="text-[12px] font-normal">Add an event</span>
          </button>
        )}
      </aside>
    </div>
  );
}

/** An event as a card in the day panel: big time, title; past ones fade, declined ones are struck through. */
function EventTile({ event, now, color, index, onOpen }: { event: CalendarEvent; now: Date; color?: string; index: number; onOpen: (event: CalendarEvent) => void }) {
  const { start, end } = eventSpan(event);
  const past = end.getTime() <= now.getTime();
  const happening = !event.allDay && start.getTime() <= now.getTime() && !past;
  const declined = event.you === "declined";
  const label = happening
    ? "Now"
    : past
      ? "Past"
      : event.you === "needs-action"
        ? "Not answered"
        : event.you === "tentative"
          ? "Maybe"
          : event.allDay
            ? "All day"
            : format(end, "'until' HH:mm");
  return (
    <button
      {...FLUID_ITEM}
      onClick={() => onOpen(event)}
      className={cn(
        "blur-fade-up relative flex min-w-0 flex-col items-start gap-0.5 rounded-xl border border-pane-border px-3 py-2.5 text-left transition-[background-color,border-color] duration-150 data-[lit]:bg-pane-hover",
        happening && "border-accent/60",
        past && "opacity-60",
      )}
      style={{ "--i": index } as React.CSSProperties}
    >
      <span className="flex w-full items-center gap-1.5 text-[11px] text-pane-muted">
        {color ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: color }} /> : null}
        <span className={cn("truncate", happening && "font-medium text-accent", declined && "line-through")}>{label}</span>
      </span>
      <span className={cn("text-[15px] font-semibold tabular-nums", declined && "line-through")}>{event.allDay ? "All day" : format(start, "HH:mm")}</span>
      <span data-sensitive className={cn("w-full truncate text-[12px] text-pane-muted", declined && "line-through")} title={event.summary}>
        {event.summary}
      </span>
    </button>
  );
}

/** Week or day: hours down, days across; overlapping events side by side, all-day ones on top. */
function TimeGrid({
  days,
  now,
  events,
  color,
  onOpen,
  onAdd,
}: {
  days: Date[];
  now: Date;
  events: CalendarEvent[];
  color: (accountId: string) => string | undefined;
  onOpen: (event: CalendarEvent) => void;
  onAdd: (when: PickedWhen) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const bars = useMemo(() => placeAllDay(events, days[0]).filter((b) => b.column < days.length), [events, days]);
  const rows = bars.reduce((n, b) => Math.max(n, b.row + 1), 0);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  // Open at 07:00 (earlier before eight in the morning), not at midnight; only when the grid first shows.
  useEffect(() => {
    const at = new Date();
    if (scroller.current) scroller.current.scrollTop = Math.max(0, (Math.min(at.getHours() * 60 + at.getMinutes(), 8 * 60) / 60 - 1) * HOUR_PX);
  }, []);

  const slotFor = (day: Date, y: number): PickedWhen => {
    const minutes = Math.max(0, Math.min(23 * 60, Math.floor(y / (HOUR_PX / 2)) * 30));
    const endMinutes = Math.min(minutes + 60, 23 * 60 + 59);
    return { date: ymd(day), start: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`, end: `${pad(Math.floor(endMinutes / 60))}:${pad(endMinutes % 60)}` };
  };

  const columns = { gridTemplateColumns: `3.5rem repeat(${days.length}, minmax(0, 1fr))` };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid shrink-0 border-b border-pane-border" style={columns}>
        <span />
        {days.map((day) => {
          const isToday = isSameDay(day, now);
          return (
            <div key={day.toISOString()} className="flex min-w-0 flex-col items-center gap-0.5 border-l border-pane-border/60 py-2">
              <span className={cn("text-[10.5px] font-semibold uppercase tracking-[0.08em]", isToday ? "text-accent" : "text-pane-muted")}>{format(day, "EEE")}</span>
              <span className={cn("grid size-7 place-items-center rounded-lg text-[14px] font-semibold tabular-nums", isToday && "bg-accent text-accent-fg")}>{format(day, "d")}</span>
            </div>
          );
        })}
        {rows ? (
          <div className="relative border-t border-pane-border/60" style={{ gridColumn: `2 / span ${days.length}`, height: rows * 24 + 8 }}>
            {bars.map((bar) => (
              <button
                key={bar.event.id}
                onClick={() => onOpen(bar.event)}
                data-sensitive
                className="absolute h-[22px] truncate rounded-md px-2 text-left text-[11.5px] font-medium transition-[filter] duration-150 hover:brightness-110"
                style={{
                  left: `calc(${(bar.column / days.length) * 100}% + 2px)`,
                  width: `calc(${(Math.min(bar.span, days.length - bar.column) / days.length) * 100}% - 4px)`,
                  top: bar.row * 24 + 4,
                  ...tint(color(bar.event.accountId), bar.event),
                }}
                title={bar.event.summary}
              >
                {bar.event.summary}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <div ref={scroller} className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div className="relative grid" style={{ ...columns, height: 24 * HOUR_PX }}>
          <div className="relative">
            {Array.from({ length: 23 }, (_, i) => (
              <span key={i} className="absolute right-2.5 -translate-y-1/2 text-[10px] tabular-nums text-pane-muted" style={{ top: (i + 1) * HOUR_PX }}>
                {pad(i + 1)}:00
              </span>
            ))}
          </div>
          {days.map((day) => {
            const placed = placeTimed(events, day);
            const isToday = isSameDay(day, now);
            return (
              <div
                key={day.toISOString()}
                className={cn("relative cursor-cell border-l border-pane-border/60", isToday && "bg-accent/[0.03]")}
                style={{
                  backgroundImage: `repeating-linear-gradient(to bottom, transparent 0 ${HOUR_PX - 1}px, color-mix(in srgb, var(--pane-border) 60%, transparent) ${HOUR_PX - 1}px ${HOUR_PX}px)`,
                }}
                onClick={(e) => {
                  if (e.target !== e.currentTarget) return;
                  onAdd(slotFor(day, e.clientY - e.currentTarget.getBoundingClientRect().top));
                }}
              >
                {placed.map((p) => (
                  <button
                    key={p.event.id}
                    {...FLUID_IGNORE}
                    onClick={() => onOpen(p.event)}
                    className="absolute flex flex-col overflow-hidden rounded-lg px-2 py-1 text-left transition-[filter] duration-150 hover:brightness-110"
                    style={{
                      top: (p.top / 60) * HOUR_PX + 1,
                      height: Math.max(20, (p.height / 60) * HOUR_PX - 2),
                      left: `calc(${(p.lane / p.lanes) * 100}% + 3px)`,
                      width: `calc(${100 / p.lanes}% - 6px)`,
                      ...tint(color(p.event.accountId), p.event),
                    }}
                    title={`${p.event.summary} · ${timeOf(p.event)}`}
                  >
                    <span data-sensitive className="truncate text-[12px] font-semibold leading-tight">
                      {p.event.summary}
                    </span>
                    {p.height >= 45 ? <span className="truncate text-[10.5px] tabular-nums opacity-70">{timeOf(p.event)}</span> : null}
                  </button>
                ))}
                {isToday ? (
                  <span className="pointer-events-none absolute inset-x-0 z-10 h-px bg-accent" style={{ top: (nowMinutes / 60) * HOUR_PX }}>
                    <span className="absolute -left-1 -top-[3.5px] size-2 rounded-full bg-accent" />
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** An event's colours: the account's colour when several are shown, else the accent; quieter when not answered yet. */
function tint(accountColor: string | undefined, event: CalendarEvent): React.CSSProperties {
  const base = accountColor ?? "var(--accent)";
  const pending = event.you === "needs-action" || event.you === "tentative";
  return {
    background: `color-mix(in srgb, ${base} ${pending ? 10 : 22}%, var(--pane))`,
    boxShadow: pending ? `inset 0 0 0 1px color-mix(in srgb, ${base} 45%, transparent)` : undefined,
    color: "var(--pane-fg)",
  };
}

/** The month's days that have something; in the current month, from today on. */
function Agenda({
  from,
  to,
  now,
  events,
  color,
  onOpen,
}: {
  from: Date;
  to: Date;
  now: Date;
  events: CalendarEvent[] | null;
  color: (accountId: string) => string | undefined;
  onOpen: (event: CalendarEvent) => void;
}) {
  const today = startOfDay(now);
  const days: { day: Date; list: CalendarEvent[] }[] = [];
  for (let d = isBefore(from, today) && isBefore(today, to) ? today : from; isBefore(d, to); d = addDays(d, 1)) {
    const list = events ? eventsOn(events, d) : [];
    if (list.length) days.push({ day: d, list });
  }
  return (
    <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-3 py-4 @md:px-4">
      {events === null ? (
        <div className="h-[120px] animate-pulse rounded-xl bg-pane-2" />
      ) : !days.length ? (
        <p className="blur-fade rounded-xl border border-dashed border-pane-muted/40 px-4 py-8 text-center text-[13px] text-pane-muted">Nothing planned for the rest of this month.</p>
      ) : (
        <div className="flex flex-col gap-5">
          {days.map(({ day, list }, i) => (
            <div key={ymd(day)} className="blur-fade-up grid gap-x-4 gap-y-1.5 @xl:grid-cols-[7rem_minmax(0,1fr)]" style={{ "--i": i } as React.CSSProperties}>
              <div className="flex items-baseline gap-2 px-1 @xl:flex-col @xl:gap-0 @xl:pt-2">
                <span className={cn("text-[13px] font-semibold", isSameDay(day, today) && "text-accent")}>{isSameDay(day, today) ? "Today" : format(day, "EEEE")}</span>
                <span className="text-[12px] text-pane-muted">{format(day, "d MMMM")}</span>
              </div>
              <FluidList tone="pane" className="flex flex-col">
                {list.map((event) => (
                  <button
                    key={event.id}
                    {...FLUID_ITEM}
                    onClick={() => onOpen(event)}
                    className="relative flex min-h-12 w-full items-center gap-3 rounded-xl px-2.5 py-1.5 text-left transition-[background-color] duration-150"
                  >
                    <span className="w-[86px] shrink-0 text-[12px] tabular-nums text-pane-muted">{timeOf(event)}</span>
                    <span className="h-7 w-[3px] shrink-0 rounded-full" style={{ background: color(event.accountId) ?? "var(--accent)" }} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span data-sensitive className="truncate text-[13.5px] font-medium">
                        {event.summary}
                      </span>
                      {event.location ? (
                        <span data-sensitive className="truncate text-[12px] text-pane-muted">
                          {event.location}
                        </span>
                      ) : null}
                    </span>
                    {event.join ? <Icon icon={Video01Icon} size={15} className="shrink-0 text-accent" /> : null}
                  </button>
                ))}
              </FluidList>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const YOUR_ANSWER: Record<AttendeeStatus, string> = {
  accepted: "You said yes",
  tentative: "You said maybe",
  declined: "You said no",
  "needs-action": "You haven't answered",
  delegated: "You delegated it",
};

/** Where an event comes from when it isn't the provider's own calendar (server/mail-calendar.ts). */
const SOURCE_LINE: Record<NonNullable<CalendarEvent["source"]>, string> = {
  mail: "From invites in your mail, not a calendar app",
  kite: "Added in Kite: only here, not on your other devices",
};

/** One event: when, where, who, your answer, Join, open in your calendar, and the invite email when Kite has it. */
function EventCard({
  event,
  live,
  accounts,
  demoThreads,
  onClose,
  onRemoved,
  onOpen,
}: {
  event: CalendarEvent;
  live: boolean;
  accounts: Account[];
  demoThreads: Thread[];
  onClose: () => void;
  onRemoved: () => void;
  onOpen: (target: TodayTarget) => void;
}) {
  const { start, end } = eventSpan(event);
  const lastDay = addDays(end, -1);
  const when = event.allDay
    ? isSameDay(start, lastDay)
      ? `${format(start, "EEEE d MMMM")}, all day`
      : `${format(start, "EEE d MMM")} – ${format(lastDay, "EEE d MMM")}, all day`
    : `${format(start, "EEEE d MMMM, HH:mm")}–${format(end, isSameDay(start, end) ? "HH:mm" : "EEE d MMM HH:mm")}`;
  const account = accounts.find((a) => a.id === event.accountId);
  const [finding, setFinding] = useState<"idle" | "busy" | "none">("idle");

  const openInvite = async () => {
    if (!event.uid || finding === "busy") return;
    if (!live) {
      const thread = demoThreads.find((t) => t.messages.some((m) => m.invite?.uid === event.uid));
      return thread ? onOpen({ threadId: thread.id, accountId: thread.accountId, subject: thread.subject }) : setFinding("none");
    }
    setFinding("busy");
    try {
      const params = new URLSearchParams({ account: event.accountId, uid: event.uid, summary: event.summary });
      const res = await fetch(`/api/calendar/invite?${params}`);
      const data = (await res.json()) as { thread?: { threadId: string; subject: string } | null };
      if (data.thread) onOpen({ threadId: data.thread.threadId, accountId: event.accountId, subject: data.thread.subject });
      else setFinding("none");
    } catch {
      setFinding("none");
    }
  };

  const facts: { icon: IconData; text: string }[] = [
    ...(event.location ? [{ icon: Location01Icon, text: event.location }] : []),
    ...(event.organizer ? [{ icon: UserIcon, text: `Organised by ${event.organizer.name || event.organizer.email}` }] : []),
    ...(event.recurring ? [{ icon: RepeatIcon, text: "Repeats" }] : []),
    ...(account ? [{ icon: Calendar03Icon, text: accountName(account) }] : []),
    ...(event.you ? [{ icon: Mail01Icon, text: YOUR_ANSWER[event.you] }] : []),
    ...(event.source ? [{ icon: event.source === "mail" ? Mail01Icon : Calendar03Icon, text: SOURCE_LINE[event.source] }] : []),
  ];
  // Events added in Kite can be removed here (inline confirm); everything else lives in mail or the provider's calendar.
  const [removing, setRemoving] = useState<"idle" | "confirm" | "busy" | "failed">("idle");
  const remove = async () => {
    setRemoving("busy");
    const res = await fetch(`/api/calendar/events?id=${encodeURIComponent(event.id)}`, { method: "DELETE", headers: { "content-type": "application/json" } }).catch(() => null);
    if (res?.ok) onRemoved();
    else setRemoving("failed");
  };
  const linkClass = "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium transition-colors duration-150";

  return (
    <Dialog open onClose={onClose} title={event.summary} description={when} className="w-[440px] max-w-full">
      <div className="flex flex-col gap-4 px-5 pb-5" data-sensitive>
        {facts.length ? (
          <ul className="flex flex-col gap-2 text-[13px]">
            {facts.map((fact) => (
              <li key={fact.text} className="flex min-w-0 items-center gap-2.5">
                <Icon icon={fact.icon} size={15} className="shrink-0 text-pane-muted" />
                <span className="truncate">{fact.text}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {event.join ? (
            <a href={event.join} target="_blank" rel="noopener noreferrer" className={cn(linkClass, "border-accent/50 text-accent hover:bg-accent-soft")}>
              <Icon icon={Video01Icon} size={14} />
              Join
            </a>
          ) : null}
          {event.link ? (
            <a href={event.link} target="_blank" rel="noopener noreferrer" className={cn(linkClass, "border-pane-border hover:bg-pane-hover")}>
              <Icon icon={ArrowUpRight01Icon} size={14} />
              Open in your calendar
            </a>
          ) : null}
          {event.uid ? (
            <button onClick={openInvite} disabled={finding === "busy"} className={cn(linkClass, "border-pane-border hover:bg-pane-hover disabled:opacity-60")}>
              <Icon icon={Mail01Icon} size={14} />
              {finding === "busy" ? "Looking…" : "Invite email"}
            </button>
          ) : null}
        </div>
        {finding === "none" ? <p className="text-[12.5px] text-pane-muted">No invite email for this event in your mail.</p> : null}
        {event.notes ? <p className="whitespace-pre-wrap text-[13px] text-pane-muted">{event.notes}</p> : null}
        {event.source === "kite" && live ? (
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            {removing === "confirm" || removing === "busy" ? (
              <>
                <span className="text-pane-muted">Remove this event from Kite?</span>
                <button onClick={() => void remove()} disabled={removing === "busy"} className={cn(linkClass, "h-8 border-danger/50 text-danger hover:bg-danger/10 disabled:opacity-60")}>
                  {removing === "busy" ? "Removing…" : "Remove"}
                </button>
                <button onClick={() => setRemoving("idle")} className={cn(linkClass, "h-8 border-pane-border hover:bg-pane-hover")}>
                  Keep
                </button>
              </>
            ) : (
              <button onClick={() => setRemoving("confirm")} className={cn(linkClass, "h-8 border-pane-border text-pane-muted hover:bg-pane-hover hover:text-pane-fg")}>
                Remove from Kite
              </button>
            )}
            {removing === "failed" ? <span className="text-warning">Kite couldn&rsquo;t remove it. Try again.</span> : null}
          </div>
        ) : null}
      </div>
    </Dialog>
  );
}
