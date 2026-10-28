"use client";

import { useState, type ReactNode } from "react";
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
 * Other apps' activities in the Kite bar (the Kite bar API, docs/bar.md), drawn like Kite's own items
 * from their validated JSON: the icon, title and a line under it (the value at a glance, the
 * subtitle), then the buttons; the body below while it's open; progress as a thin line along the
 * bottom (bar.tsx). Copy and Open go through the shell (it acts on the activity it holds); callbacks
 * go to the integration through the server.
 */

/** The Kite bar's controls (bar.tsx, bar-reply.tsx): plain buttons, the one thing to do in the accent, the item's icon tile. */
export const BTN =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-pane-2 px-2.5 text-[12.5px] text-pane-fg transition-colors duration-150 hover:bg-pane-hover";
export const PRIMARY =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 text-[12.5px] font-medium text-accent-fg transition-[filter] duration-150 hover:brightness-110";
const TILE_R = 15;
const TILE_RING = 2 * Math.PI * TILE_R;

/** The item's icon in a round tile; `ring` (0 to 1) draws progress or time left round it. */
export function Tile({ className, ring, children }: { className?: string; ring?: number | null; children: ReactNode }) {
  return (
    <span className={cn("relative grid size-8 shrink-0 place-items-center rounded-full bg-pane-2", className)}>
      {ring != null ? (
        <svg viewBox="0 0 32 32" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle
            cx="16"
            cy="16"
            r={TILE_R}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray={TILE_RING}
            strokeDashoffset={TILE_RING * (1 - ring)}
            className="transition-[stroke-dashoffset] duration-150"
          />
        </svg>
      ) : null}
      {children}
    </span>
  );
}

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

/** Icon colours, from Kite's tokens. */
const TINT: Record<BarActivity["tint"], string> = {
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
  neutral: "text-pane-fg",
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

/** The value's short form, for the line under the title. */
function glance(value: BarValue | undefined, now: number) {
  if (!value) return null;
  switch (value.type) {
    case "text":
      return value.text;
    case "code":
      return null;
    case "progress":
      return `${Math.round(value.progress * 100)}%`;
    case "countdown":
      return remaining(value.until, now);
  }
}

/** Whether the activity's value ticks (the page runs its clock while it shows). */
export const ticks = (activity: BarActivity) => activity.value?.type === "countdown";

/** How far along the tile's ring is (progress only). */
export const activityLine = (activity: BarActivity) => (activity.value?.type === "progress" ? activity.value.progress : null);

/** Whether there's a body to show under the row while open. */
export const hasSheet = (activity: BarActivity) => Boolean(activity.body);

/** The activity's row: icon, title, a line under it, and its buttons. */
export function ActivityRow(props: {
  activity: BarActivity;
  now: number;
  /** Copy the code value (no index) or a copy button's text; open an open_url button. */
  onCopy: (index?: number) => void;
  onOpen: (index: number) => void;
  onCallback: (id: string) => void;
}) {
  const { activity, now } = props;
  /** Buttons (and the code's Copy) that just did their thing: a tick for a moment. */
  const [done, setDone] = useState<string | null>(null);
  const flash = (what: string) => {
    setDone(what);
    setTimeout(() => setDone((current) => (current === what ? null : current)), 1_400);
  };
  const value = activity.value;
  const label = value && "label" in value ? value.label : undefined;
  const under = [glance(value, now), label, activity.subtitle ?? activity.source.name].filter(Boolean).join(" · ");
  return (
    <>
      <Tile className={TINT[activity.tint]} ring={activityLine(activity)}>
        <Icon icon={ICONS[activity.icon]} size={16} />
      </Tile>
      <Lines title={activity.title} under={under} />
      {value?.type === "code" ? (
        <>
          <span className="text-[17px] font-semibold tabular-nums tracking-[0.06em]">{value.code}</span>
          <button
            onClick={() => {
              props.onCopy();
              flash("code");
            }}
            className={PRIMARY}
          >
            <CopyIcon copied={done === "code"} tint={false} size={13} />
            {done === "code" ? "Copied" : "Copy"}
          </button>
        </>
      ) : null}
      {activity.actions.map((action, index) => {
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
            className={last ? PRIMARY : BTN}
          >
            {done === key ? <CopyIcon copied tint={false} size={13} /> : action.type === "open_url" ? <Icon icon={LinkSquare02Icon} size={13} /> : null}
            {action.label}
          </button>
        );
      })}
    </>
  );
}

/** A title and a muted line under it, taking the row's spare width. */
export function Lines({ title, under }: { title: ReactNode; under?: ReactNode }) {
  return (
    <span className="flex min-w-0 flex-1 flex-col justify-center leading-tight">
      <span className="truncate text-[13px] font-semibold">{title}</span>
      {under ? <span className="truncate text-[12px] text-pane-muted">{under}</span> : null}
    </span>
  );
}

/** The activity's words, under the row while it's open. */
export function ActivitySheet({ activity }: { activity: BarActivity }) {
  return <p className="line-clamp-4 text-[13px] leading-relaxed">{activity.body}</p>;
}
