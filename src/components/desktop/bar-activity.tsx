"use client";

import { useState } from "react";
import {
  Alert02Icon,
  Bug01Icon,
  Calendar03Icon,
  ChartLineData01Icon,
  CheckmarkCircle02Icon,
  CodeIcon,
  Download04Icon,
  FavouriteIcon,
  FlashIcon,
  Home01Icon,
  InformationCircleIcon,
  LinkSquare02Icon,
  Mail01Icon,
  Message01Icon,
  Money03Icon,
  MusicNote01Icon,
  Notification03Icon,
  Rocket01Icon,
  SparklesIcon,
  StarIcon,
  Timer02Icon,
  Upload04Icon,
  Wrench01Icon,
} from "@hugeicons/core-free-icons";
import type { IconSvgElement } from "@hugeicons/react";
import type { BarActivity, BarValue } from "@/lib/bar/spec";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { CopyIcon } from "../ui/copy";

/*
 * Other apps' activities in the Kite bar (the Kite bar API, docs/bar.md), drawn in Kite's own look
 * from their validated JSON: on the sky row the icon, title, the value at a glance and the buttons;
 * on the paper sheet the subtitle and body; progress and countdowns on the lime line (bar.tsx). Copy
 * and Open go through the shell (it acts on the activity it holds); callbacks go to the integration
 * through the server.
 */


const ICONS: Record<BarActivity["icon"], IconSvgElement> = {
  bell: Notification03Icon,
  check: CheckmarkCircle02Icon,
  alert: Alert02Icon,
  info: InformationCircleIcon,
  build: Wrench01Icon,
  deploy: Rocket01Icon,
  bug: Bug01Icon,
  code: CodeIcon,
  timer: Timer02Icon,
  calendar: Calendar03Icon,
  message: Message01Icon,
  mail: Mail01Icon,
  music: MusicNote01Icon,
  download: Download04Icon,
  upload: Upload04Icon,
  chart: ChartLineData01Icon,
  money: Money03Icon,
  home: Home01Icon,
  bolt: FlashIcon,
  sparkles: SparklesIcon,
  star: StarIcon,
  heart: FavouriteIcon,
};

/** Icon and progress colours, from Kite's tokens. */
/** Icon colours on the sky: white, or a tone that still reads on it. */
const TINT: Record<BarActivity["tint"], { text: string }> = {
  accent: { text: "text-white" },
  success: { text: "text-lime" },
  warning: { text: "text-[#ffd27a]" },
  danger: { text: "text-[#ffb3b5]" },
  neutral: { text: "text-white" },
};

/** "4:05", "1:02:09", "now". */
function remaining(until: string, now: number) {
  const left = Math.max(0, Math.round((new Date(until).getTime() - now) / 1000));
  if (!left) return "now";
  const h = Math.floor(left / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = String(left % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The value's short form, for the pill. */
function glance(value: BarValue | undefined, now: number) {
  if (!value) return null;
  switch (value.type) {
    case "text":
      return value.text;
    case "code":
      return value.code;
    case "progress":
      return `${Math.round(value.progress * 100)}%`;
    case "countdown":
      return remaining(value.until, now);
  }
}

/** Whether the activity's value ticks (the page runs its clock while it shows). */
export const ticks = (activity: BarActivity) => activity.value?.type === "countdown";

/** How far along the lime line is: progress fills it, a countdown drains it over its last ten minutes. */
export function activityLine(activity: BarActivity, now: number) {
  const value = activity.value;
  if (value?.type === "progress") return value.progress;
  if (value?.type === "countdown") return Math.min(1, Math.max(0, (new Date(value.until).getTime() - now) / (10 * 60_000)));
  return null;
}

/** Whether there's anything for the paper sheet: words, or a value's label. */
export const hasSheet = (activity: BarActivity) =>
  Boolean(activity.body || activity.subtitle || (activity.value && "label" in activity.value && activity.value.label));

/** Frosted controls on the sky and the white pill for the last button (the bar's own, components/desktop/bar.tsx). */
const FROST =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.16] px-3 text-[13px] text-frame-fg transition-[background-color,transform] duration-150 hover:bg-white/[0.26] active:scale-95";
const SOLID =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-frame-active px-3.5 text-[13px] font-medium text-frame-active-fg shadow-[0_4px_12px_-4px_rgb(10_30_70/0.45)] transition-transform duration-150 active:scale-95";

/** The activity on the bar's row: its icon and title, the value at a glance, and its buttons (all of them while open). */
export function ActivityRow(props: {
  activity: BarActivity;
  now: number;
  open: boolean;
  /** Copy the code value (no index) or a copy button's text; open an open_url button. */
  onCopy: (index?: number) => void;
  onOpen: (index: number) => void;
  onCallback: (id: string) => void;
}) {
  const { activity, now } = props;
  const tint = TINT[activity.tint];
  /** Buttons (and the code's Copy) that just did their thing: a tick for a moment. */
  const [done, setDone] = useState<string | null>(null);
  const flash = (what: string) => {
    setDone(what);
    setTimeout(() => setDone((current) => (current === what ? null : current)), 1_400);
  };
  const value = activity.value;
  const short = glance(value, now);
  // At rest only the last button (the one thing to do); open, all of them.
  const buttons = activity.actions.map((action, index) => ({ action, index })).slice(props.open ? 0 : -1);
  return (
    <>
      <span className={cn("grid size-7 shrink-0 place-items-center rounded-full bg-white/[0.18]", tint.text)}>
        <Icon icon={ICONS[activity.icon]} size={15} />
      </span>
      <span className="max-w-[220px] truncate text-[13.5px] font-medium">{activity.title}</span>
      {value?.type === "code" ? (
        <>
          <span className="px-1 text-[20px] font-semibold leading-none tabular-nums tracking-[0.06em]">{value.code}</span>
          <button
            onClick={() => {
              props.onCopy();
              flash("code");
            }}
            className={SOLID}
          >
            <CopyIcon copied={done === "code"} tint={false} />
            {done === "code" ? "Copied" : "Copy"}
          </button>
        </>
      ) : short ? (
        <span className="whitespace-nowrap font-accent text-[15.5px] leading-none tabular-nums text-frame-fg/85">{short}</span>
      ) : null}
      {buttons.map(({ action, index }) => {
        const key = `${action.type}:${index}`;
        const last = index === activity.actions.length - 1 && value?.type !== "code";
        return (
          <button
            key={key}
            onClick={() => {
              if (action.type === "copy") props.onCopy(index);
              else if (action.type === "open_url") props.onOpen(index);
              else props.onCallback(action.id);
              flash(key);
            }}
            title={action.type === "open_url" ? new URL(action.url).host : undefined}
            className={last ? SOLID : FROST}
          >
            {done === key ? <CopyIcon copied tint={false} size={13} /> : action.type === "open_url" ? <Icon icon={LinkSquare02Icon} size={13} /> : null}
            {action.label}
          </button>
        );
      })}
    </>
  );
}

/** On paper under the bar: who it's from, its words, and the value's label. */
export function ActivitySheet({ activity }: { activity: BarActivity }) {
  const value = activity.value;
  const label = value && "label" in value ? value.label : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="truncate text-[12px] text-pane-muted">
        {activity.subtitle ?? activity.source.name}
        {label ? ` · ${label}` : ""}
      </div>
      {activity.body ? <p className="line-clamp-4 font-reading text-[14px] leading-relaxed">{activity.body}</p> : null}
    </div>
  );
}
