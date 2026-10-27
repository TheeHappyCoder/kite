"use client";

import { useMemo } from "react";
import { format } from "date-fns";
import {
  AlarmClockIcon,
  ArrowTurnBackwardIcon,
  ArrowUpRight01Icon,
  CheckListIcon,
  MailSend01Icon,
  PencilEdit01Icon,
  Calendar03Icon,
  Cancel01Icon,
  Mail01Icon,
  MailReply01Icon,
  PinIcon,
  Tick02Icon,
  TimeScheduleIcon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import type { CalendarEvent } from "@/lib/calendar/event";
import { waitedFor } from "@/lib/replies";
import { isReady, stepOf, stepText, whoText, type Expectation } from "@/lib/automations/expect";
import { DAYS_AHEAD, parseWhen, todayFor, type TodayData } from "@/lib/today";
import { useShortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { KeyCombo } from "../ui/kbd";
import { Tooltip } from "../ui/tooltip";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";

// Home's day (lib/today.ts): the calendar, follow-ups, snoozes, sends and pins beside the people you
// owe, and what automations are waiting for (Expected).

/** A conversation to open from Home. Snoozed and scheduled ones open in their own mailbox. */
export type TodayTarget = { threadId: string; accountId: string; subject: string; mailbox?: "snoozed" | "scheduled" };

export type ExpectAction = "send" | "edit" | "received" | "stop" | "reopen";

const time = (iso: string) => {
  const date = parseWhen(iso);
  return date ? format(date, "HH:mm") : "";
};

function dayLabel(offset: number, now: Date) {
  if (offset === -1) return "Yesterday";
  if (offset === 0) return "Today";
  if (offset === 1) return "Tomorrow";
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return format(date, "EEEE");
}

function dayDate(offset: number, now: Date) {
  const date = new Date(now);
  date.setDate(date.getDate() + offset);
  return format(date, "d MMM");
}

/** Days with events Home shows under Coming up. */
const COMING_DAYS = 3;

/**
 * Your day, on Home: what's coming up in your calendar, follow-ups due, snoozes waking and messages
 * sending today, and pinned conversations. Facts from the local copy only; empty parts stay out.
 */
export function DayPanel({ data, now, demo, dot, onOpen }: { data: TodayData; now: Date; demo: boolean; dot: (accountId: string) => string | undefined; onOpen: (target: TodayTarget) => void }) {
  const { primary } = useShortcuts();
  const shown = useMemo(() => todayFor(data, now, {}), [data, now]);
  // The next few days with something on; the whole week is in Calendar.
  const days = shown.days.slice(0, COMING_DAYS);
  const pinKey = primary("pin");
  return (
    <div className="flex flex-col gap-5">
      <Section title="Coming up" icon={Calendar03Icon} index={0}>
        {days.length ? (
          <div className="flex flex-col gap-3">
            {days.map((day) => (
              <div key={day.offset}>
                <h3 className="mb-0.5 flex items-baseline gap-2 px-2.5 text-[12.5px] font-medium">
                  <span className={cn(day.offset === -1 && "text-warning")}>{dayLabel(day.offset, now)}</span>
                  <span className="text-[11.5px] font-normal text-pane-muted">{dayDate(day.offset, now)}</span>
                </h3>
                <div className="flex flex-col">
                  {day.events.map((event) => (
                    <EventRow key={event.id} event={event} dot={dot(event.accountId)} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty>
            {demo
              ? "Meetings show up here once your mail and calendar are connected."
              : `Nothing in the next ${DAYS_AHEAD} days. Meetings show up here once "Use your calendar" is on in Settings.`}
          </Empty>
        )}
      </Section>

      {shown.followups.length ? (
        <Section title="Follow-ups due" icon={MailReply01Icon} index={1} count={shown.followups.length}>
          {shown.followups.map((f) => (
            <Row
              key={f.id}
              title={f.subject}
              detail={f.status === "nudged" ? `No reply since ${format(new Date(f.sentAt), "EEE d MMM")}` : `Nudge due at ${time(f.dueAt)}`}
              dot={dot(f.accountId)}
              onClick={() => onOpen({ threadId: f.threadId, accountId: f.accountId, subject: f.subject })}
            />
          ))}
        </Section>
      ) : null}

      {shown.waking.length ? (
        <Section title="Waking up today" icon={AlarmClockIcon} index={2} count={shown.waking.length}>
          {shown.waking.map((s) => (
            <Row
              key={s.threadId}
              title={s.subject}
              detail={`Back in your inbox at ${time(s.until)}`}
              dot={dot(s.accountId)}
              onClick={() => onOpen({ threadId: s.threadId, accountId: s.accountId, subject: s.subject, mailbox: "snoozed" })}
            />
          ))}
        </Section>
      ) : null}

      {shown.sending.length ? (
        <Section title="Sending today" icon={TimeScheduleIcon} index={3} count={shown.sending.length}>
          {shown.sending.map((s) => (
            <Row
              key={s.id}
              title={s.subject}
              detail={`To ${s.to || "no one yet"} at ${time(s.sendAt)}`}
              dot={dot(s.accountId)}
              onClick={() => onOpen({ threadId: `scheduled:${s.id}`, accountId: s.accountId, subject: s.subject, mailbox: "scheduled" })}
            />
          ))}
        </Section>
      ) : null}

      <Section title="Pinned" icon={PinIcon} index={4} count={shown.pinned.length}>
        {shown.pinned.length ? (
          shown.pinned.map((p) => (
            <Row key={p.threadId} title={p.subject} detail={p.from} dot={dot(p.accountId)} onClick={() => onOpen({ threadId: p.threadId, accountId: p.accountId, subject: p.subject })} />
          ))
        ) : (
          <Empty>
            Pin a conversation{pinKey ? <> with <KeyCombo combo={pinKey} className="mx-0.5 align-[-3px]" keyClassName="bg-pane-2 text-pane-muted" /></> : null} to keep it here.
          </Empty>
        )}
      </Section>
    </div>
  );
}

export function Section({ title, icon, index, count, children }: { title: string; icon: IconData; index: number; count?: number; children: React.ReactNode }) {
  return (
    <section className="blur-fade-up min-w-0" style={{ "--i": index } as React.CSSProperties}>
      <h2 className="mb-2 flex items-center gap-2 px-2.5 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">
        <Icon icon={icon} size={14} />
        <span className="flex-1">{title}</span>
        {count ? <span className="tabular-nums">{count}</span> : null}
      </h2>
      <FluidList tone="pane" className="flex flex-col">{children}</FluidList>
    </section>
  );
}

const ANSWER_WORD: Partial<Record<NonNullable<CalendarEvent["you"]>, string>> = { tentative: "Maybe", "needs-action": "Not answered" };

/** An event from your calendar: when, where, Join for video calls, and the event in your calendar. */
function EventRow({ event, dot }: { event: CalendarEvent; dot?: string }) {
  const start = parseWhen(event.start);
  const end = event.end ? parseWhen(event.end) : null;
  const when = event.allDay || !start ? "All day" : `${format(start, "HH:mm")}${end ? `–${format(end, "HH:mm")}` : ""}`;
  const answer = event.you ? ANSWER_WORD[event.you] : undefined;
  return (
    <div {...FLUID_ITEM} className="relative flex min-h-12 w-full items-center gap-3 rounded-lg px-2.5 py-1.5 transition-[background-color] duration-150">
      <Tooltip label={event.source === "mail" ? "From invites in your mail" : event.source === "kite" ? "Added in Kite, only here" : "From your calendar"}>
        <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-soft text-accent">
          <Icon icon={event.source === "mail" ? Mail01Icon : Calendar03Icon} size={16} />
        </span>
      </Tooltip>
      <span className="flex min-w-0 flex-1 flex-col">
        <span data-sensitive className="truncate text-[13.5px] font-medium" title={event.summary}>
          {event.summary}
        </span>
        <span className="flex items-center gap-1.5 truncate text-[12px] text-pane-muted">
          {dot ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} /> : null}
          <span data-sensitive className="truncate tabular-nums">
            {when}
            {event.location ? ` · ${event.location}` : ""}
          </span>
          {answer ? <span className="shrink-0 rounded-full bg-pane-2 px-1.5 text-[10.5px] font-medium">{answer}</span> : null}
        </span>
      </span>
      {event.join ? (
        <a
          href={event.join}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-accent/50 px-2.5 py-1 text-[12px] font-medium text-accent transition-colors duration-150 hover:bg-accent-soft"
        >
          <Icon icon={Video01Icon} size={13} />
          Join
        </a>
      ) : null}
      {event.link ? (
        <Tooltip label="Open in your calendar">
          <a
            href={event.link}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Open in your calendar"
            className="grid size-7 shrink-0 place-items-center rounded-full border border-pane-border text-pane-muted transition-colors duration-150 hover:text-pane-fg"
          >
            <Icon icon={ArrowUpRight01Icon} size={14} />
          </a>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function Row({ title, detail, dot, onClick }: { title: string; detail: string; dot?: string; onClick: () => void }) {
  return (
    <button {...FLUID_ITEM} onClick={onClick} className="blur-fade relative flex w-full flex-col rounded-lg px-2.5 py-2 text-left">
      <span className="truncate text-[13.5px] font-medium" title={title}>
        {title}
      </span>
      <span className="flex items-center gap-1.5 truncate text-[12px] text-pane-muted">
        {dot ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} /> : null}
        <span className="truncate">{detail}</span>
      </span>
    </button>
  );
}

/**
 * What automations wait for (the expect verb), grouped by automation: who's answered, who hasn't,
 * and the request or nudge that's ready. `all`: the whole checklist (Waiting on); otherwise only
 * what's ready or overdue (Today).
 */
export function Expected({
  items,
  now,
  all = false,
  dot,
  onOpen,
  onAction,
}: {
  items: Expectation[];
  now: Date;
  all?: boolean;
  dot: (accountId: string) => string | undefined;
  onOpen: (target: TodayTarget) => void;
  onAction: (item: Expectation, action: ExpectAction) => void;
}) {
  const at = now.getTime();
  const shown = all ? items : items.filter((e) => e.status === "waiting" && (isReady(stepOf(e, at)) || Date.parse(e.dueAt) <= at));
  const groups = new Map<string, Expectation[]>();
  for (const e of shown) groups.set(e.ruleName, [...(groups.get(e.ruleName) ?? []), e]);
  const ready = shown.filter((e) => isReady(stepOf(e, at))).length;
  return (
    <Section title={all ? "Expected" : "Expected, ready to nudge"} icon={CheckListIcon} index={all ? 0 : 3} count={all ? ready || undefined : shown.length}>
      {groups.size ? (
        [...groups].map(([rule, list]) => {
          const done = list.filter((e) => e.status === "met").length;
          return (
            <div key={rule} className="mb-2 flex flex-col">
              {all ? (
                <p className="flex items-baseline gap-2 px-2.5 pb-1 pt-2 text-[12.5px] font-medium">
                  {rule}
                  <span className="text-[11.5px] font-normal tabular-nums text-pane-muted">
                    {done} of {list.length} answered
                  </span>
                </p>
              ) : null}
              {list
                .sort((a, b) => Number(a.status !== "waiting") - Number(b.status !== "waiting") || a.dueAt.localeCompare(b.dueAt))
                .map((e) => (
                  <ExpectRow key={e.id} item={e} at={at} dot={dot(e.accountId)} onOpen={onOpen} onAction={onAction} />
                ))}
            </div>
          );
        })
      ) : (
        <Empty>
          Nothing expected yet. Automations that wait for an answer (Get paid, Client documents, Job applications) list each one here, with the nudge ready when it&apos;s late.
        </Empty>
      )}
    </Section>
  );
}

function ExpectRow({
  item,
  at,
  dot,
  onOpen,
  onAction,
}: {
  item: Expectation;
  at: number;
  dot?: string;
  onOpen: (target: TodayTarget) => void;
  onAction: (item: Expectation, action: ExpectAction) => void;
}) {
  const step = stepOf(item, at);
  const ready = isReady(step);
  const closed = item.status !== "waiting";
  const thread = item.metThreadId ?? item.threadId;
  const due = Date.parse(item.dueAt);
  const when = closed
    ? item.metAt
      ? format(new Date(item.metAt), "d MMM")
      : ""
    : step.kind === "ask"
      ? ""
      : due > at
        ? `due ${format(new Date(due), "d MMM")}`
        : `waiting ${waitedFor(item.since, at)}`;
  return (
    <div {...FLUID_ITEM} className={cn("blur-fade group relative flex w-full items-center gap-2 rounded-lg px-2.5 py-2 transition-[background-color] duration-150", closed && "opacity-60")}>
      <button
        onClick={() => thread && onOpen({ threadId: thread, accountId: item.accountId, subject: item.subject })}
        disabled={!thread}
        className="flex min-w-0 flex-1 flex-col text-left disabled:cursor-default"
      >
        <span data-sensitive className="truncate text-[13.5px] font-medium" title={item.subject}>
          {whoText(item.who)}
          <span className="font-normal text-pane-muted"> · {item.subject || "(no subject)"}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[12px] text-pane-muted">
          {dot ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: dot }} /> : null}
          <span className={cn("truncate", ready && "font-medium text-accent", item.error && "text-warning")}>{item.error ?? stepText(step, item)}</span>
          {when ? <span className="shrink-0 tabular-nums">· {when}</span> : null}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1">
        {ready ? (
          <>
            <Tooltip label={`Send the ${step.kind === "ask" ? "request" : "nudge"} now (Undo send applies)`}>
              <button
                {...FLUID_IGNORE}
                onClick={() => onAction(item, "send")}
                className="inline-flex items-center gap-1 rounded-full border border-accent/50 px-2.5 py-1 text-[12px] font-medium text-accent transition-colors duration-150 hover:bg-accent-soft"
              >
                <Icon icon={MailSend01Icon} size={13} />
                Send
              </button>
            </Tooltip>
            <RowAction icon={PencilEdit01Icon} label="Edit it first" onClick={() => onAction(item, "edit")} />
          </>
        ) : null}
        {closed ? (
          <RowAction icon={ArrowTurnBackwardIcon} label="Wait again" onClick={() => onAction(item, "reopen")} />
        ) : (
          <>
            <RowAction icon={Tick02Icon} label="It came: stop waiting" onClick={() => onAction(item, "received")} />
            <RowAction icon={Cancel01Icon} label="Stop waiting for this" onClick={() => onAction(item, "stop")} />
          </>
        )}
      </span>
    </div>
  );
}

function RowAction({ icon, label, onClick }: { icon: IconData; label: string; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <button
        {...FLUID_IGNORE}
        aria-label={label}
        onClick={onClick}
        className="grid size-7 shrink-0 place-items-center rounded-full border border-pane-border text-pane-muted transition-colors duration-150 hover:text-pane-fg"
      >
        <Icon icon={icon} size={14} />
      </button>
    </Tooltip>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="blur-fade px-2.5 py-1 text-[12.5px] leading-relaxed text-pane-muted">{children}</p>;
}
