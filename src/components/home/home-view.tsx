"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Cancel01Icon,
  CheckmarkCircle02Icon,
  PencilEdit02Icon,
  Search01Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import type { Expectation } from "@/lib/automations/expect";
import { singleAccount } from "@/lib/mail/scope";
import type { TodayData } from "@/lib/today";
import { differenceInCalendarDays, format, isToday, isYesterday } from "date-fns";
import { formatAmount } from "@/lib/automations/values";
import type { CalendarEvent } from "@/lib/calendar/event";
import type { DesktopCode } from "@/lib/desktop";
import { greeting, sortHome, type HomeData, type HomeLine } from "@/lib/home";
import { blurFade, spring } from "@/lib/motion";
import type { ThreadOverride } from "@/lib/mail/overrides";
import type { AccountScope } from "@/lib/mail/scope";
import type { Account, Thread } from "@/lib/mail/types";
import { shownReplies, waitedFor, type RepliesData, type ReplyItem } from "@/lib/replies";
import { cn, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { Avatar } from "../mail/avatar";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { useCopy, CopyIcon } from "../ui/copy";
import { DayPanel, Expected, type ExpectAction, type TodayTarget } from "./day";

// Home: what needs you. People on the left (your turn, their turn, what automations are waiting
// for); your day on the right (calendar, follow-ups, snoozes, sends, pins), then Updates (the
// provider's Updates, Social and Forums, lib/home.ts) one line each with the amount an automation
// collected from it, and the reading shelf. Everything else is the Inbox's. A conversation opens as
// a sheet over the right-hand side, so the people you owe stay in view.

type HomeResponse = HomeData & { people: RepliesData; codes: DesktopCode[] };

const DAY = 86_400_000;

export function HomeView({
  live,
  accounts,
  accountId,
  demoThreads,
  overrides,
  threads,
  demoPeople,
  events,
  day,
  now,
  refreshKey,
  selectedId,
  sheet,
  onOpen,
  onCloseSheet,
  onReply,
  onExpect,
  onCompose,
  onSearch,
}: {
  live: boolean;
  accounts: Account[];
  accountId: AccountScope;
  /** Demo mode: Home is sorted from the sample threads. */
  demoThreads: Thread[];
  overrides: Record<string, ThreadOverride>;
  /** The inbox as loaded (for previews of people's mail). */
  threads: Thread[];
  /** Demo mode's To reply / Waiting on (lib/today.ts demoToday). */
  demoPeople: RepliesData | null;
  /** Calendar events from Today, for "starting soon". */
  events: CalendarEvent[];
  /** Your day (lib/today.ts): calendar, follow-ups, snoozes, sends, pins, Expected. Null while loading. */
  day: TodayData | null;
  now: Date | null;
  refreshKey: string;
  selectedId: string | null;
  /** The reader, shown as a sheet while a conversation is open. */
  sheet: React.ReactNode;
  onOpen: (target: TodayTarget) => void;
  onCloseSheet: () => void;
  /** Nudge opens a prefilled reply; Done sets it aside until a new message; Dismiss: not someone you answer here. */
  onReply: (item: ReplyItem, action: "nudge" | "done" | "dismiss") => void;
  onExpect: (item: Expectation, action: ExpectAction) => void;
  onCompose: () => void;
  onSearch: () => void;
}) {
  const [data, setData] = useState<{ key: string; home: HomeResponse } | null>(null);
  const requestKey = `${accountId}:${refreshKey}`;
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    fetch(`/api/home?account=${encodeURIComponent(accountId)}`, { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<HomeResponse>) : Promise.reject(new Error("Home couldn't be read"))))
      .then((home) => setData({ key: requestKey, home }))
      .catch(() => {});
    return () => controller.abort();
  }, [live, accountId, requestKey]);

  const home = useMemo<HomeResponse | null>(() => {
    if (live) return data?.home ?? null;
    if (!demoPeople || !now) return null;
    const own = new Map(accounts.map((a) => [a.id, a.email]));
    const sorted = sortHome(
      demoThreads.map((thread) => ({
        thread,
        inbox: thread.mailbox === "inbox",
        bulk: thread.category === "newsletters" || thread.category === "notifications",
        list: thread.category === "newsletters",
      })),
      demoPeople,
      { amounts: new Map(), me: (id) => own.get(id), now: now.getTime() },
    );
    return { ...sorted, people: demoPeople, codes: [] };
  }, [live, data, demoPeople, now, accounts, demoThreads]);

  const people = useMemo(() => (home ? shownReplies(home.people, overrides) : null), [home, overrides]);
  const byId = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const previewOf = (threadId: string) => {
    const thread = byId.get(threadId);
    const last = thread?.messages.filter((m) => !m.draft).at(-1);
    return last?.preview ?? last?.snippet ?? last?.body[0] ?? "";
  };

  const hour = now?.getHours() ?? 9;
  // The person's own first name from their provider (demo accounts are named "Personal" and "Work").
  const own = accounts[0]?.name?.trim();
  const me = live && own && !own.includes("@") ? own.split(/\s+/)[0] : undefined;
  const soon = useMemo(() => {
    if (!now) return null;
    const t = now.getTime();
    return (
      events
        .filter((e) => !e.allDay && e.you !== "declined")
        .map((e) => ({ e, start: new Date(e.start).getTime() }))
        .filter(({ start }) => start > t - 5 * 60_000 && start < t + 90 * 60_000)
        .sort((a, b) => a.start - b.start)[0] ?? null
    );
  }, [events, now]);

  const dot = (id: string) => (!singleAccount(accountId, accounts) ? accounts.find((a) => a.id === id)?.color : undefined);

  // Narrow windows show one side at a time.
  const [side, setSide] = useState<"people" | "things">("people");

  return (
    <section className="@container flex h-full min-h-0 flex-col">
      <header className="flex min-w-0 flex-wrap items-center gap-2 px-1 pb-3 pt-1.5 text-frame-fg">
        <h1 className="mr-2 truncate text-[26px] font-medium leading-none tracking-[-0.04em] [text-shadow:0_2px_24px_rgb(10_40_90/0.18)]">
          Good <span className="font-accent text-[1.12em]">{greeting(hour)}</span>
          {me ? `, ${me}` : ""}
        </h1>
        <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {home?.codes.map((code) => <CodeChip key={code.id} code={code} />)}
          {soon && now ? <MeetingChip event={soon.e} start={soon.start} now={now.getTime()} /> : null}
        </div>
        <button
          onClick={onSearch}
          className="flex h-9 items-center gap-2 rounded-full border border-frame-border bg-frame-hover px-3.5 text-[13px] text-frame-fg/90 backdrop-blur-md transition-colors duration-150 hover:bg-white/25 touch:h-11"
        >
          <Icon icon={Search01Icon} size={15} />
          <span className="@max-[560px]:hidden">Search everything</span>
        </button>
        <button
          onClick={onCompose}
          className="ink-chrome flex h-9 items-center gap-2 rounded-full bg-frame px-4 text-[13px] font-medium text-frame-fg shadow-[0_10px_24px_-12px_rgb(10_20_40/0.6)] transition-transform duration-150 active:translate-y-px touch:h-11"
        >
          Write
          <Icon icon={PencilEdit02Icon} size={15} />
        </button>
      </header>

      <div className="mb-2 hidden @max-[760px]:flex">
        <div className="flex gap-1 rounded-full border border-frame-border bg-frame-hover p-1 backdrop-blur-md">
          {(["people", "things"] as const).map((id) => (
            <button
              key={id}
              onClick={() => setSide(id)}
              className={cn(
                "h-8 rounded-full px-4 text-[13px] transition-colors duration-150",
                side === id ? "bg-frame-active font-medium text-frame-active-fg shadow-sm" : "text-frame-fg/85",
              )}
            >
              {id === "people" ? "People" : "Your day"}
            </button>
          ))}
        </div>
      </div>

      <div className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-2 @max-[760px]:grid-cols-1">
        <Card className={cn(side !== "people" && "@max-[760px]:hidden")}>
          <CardHead title={<span className="font-accent text-[1.18em]">People</span>} note="Who you owe, and who owes you" />
          {!people || !home ? (
            <Loading />
          ) : (
            <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              <Section label="Your turn" count={people.toReply.length} live>
                {people.toReply.length ? (
                  <FluidList tone="pane" className="flex flex-col gap-px">
                    {people.toReply.map((item, i) => (
                      <PersonRow
                        key={item.threadId}
                        item={item}
                        index={i}
                        now={now}
                        preview={previewOf(item.threadId)}
                        selected={selectedId === item.threadId}
                        onOpen={() => onOpen(item)}
                        actions={[
                          { label: "Done", icon: CheckmarkCircle02Icon, tip: "No reply needed", run: () => onReply(item, "done") },
                          {
                            label: "Not for me",
                            icon: Cancel01Icon,
                            tip: item.known ? "Never track this conversation" : "Kite stops suggesting replies to them",
                            run: () => onReply(item, "dismiss"),
                          },
                        ]}
                      />
                    ))}
                  </FluidList>
                ) : (
                  <Calm text="Nobody is waiting on you." />
                )}
              </Section>
              {people.waiting.length ? (
                <Section label="Their turn" count={people.waiting.length}>
                  <FluidList tone="pane" className="flex flex-col gap-px">
                    {people.waiting.map((item, i) => (
                      <PersonRow
                        key={item.threadId}
                        item={item}
                        index={i}
                        now={now}
                        theirs
                        selected={selectedId === item.threadId}
                        onOpen={() => onOpen(item)}
                        actions={[
                          { label: `Nudge · ${now ? waitedFor(item.at, now.getTime()) : ""}`, tip: "Reply with a short follow-up (you review it first)", run: () => onReply(item, "nudge") },
                          { label: "Done", icon: CheckmarkCircle02Icon, tip: "Stop waiting", run: () => onReply(item, "done") },
                        ]}
                      />
                    ))}
                  </FluidList>
                </Section>
              ) : null}
              {day?.expected.length && now ? (
                <div className="mt-3 px-1">
                  <Expected items={day.expected} now={now} all dot={dot} onOpen={onOpen} onAction={onExpect} />
                </div>
              ) : null}
            </div>
          )}
        </Card>

        <Card className={cn(side !== "things" && "@max-[760px]:hidden")}>
          <CardHead
            title={
              <>
                Your <span className="font-accent text-[1.18em]">day</span>
              </>
            }
            note={now ? format(now, "EEEE d MMMM") : ""}
          />
          {!home || !day || !now ? (
            <Loading />
          ) : (
            <>
              <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pb-3 pt-3">
                <DayPanel data={day} now={now} demo={!live} dot={dot} onOpen={onOpen} />
                {home.things.length ? (
                  <div className="mt-2">
                    <div className="px-3 pb-1 pt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">Updates</div>
                    {byDay(home.things, now).map(([label, lines]) => (
                      <Section key={label} label={label}>
                        <FluidList tone="pane" className="flex flex-col gap-px">
                          {lines.map((line) => (
                            <ThingRow key={line.threadId} line={line} selected={selectedId === line.threadId} onOpen={() => onOpen(line)} />
                          ))}
                        </FluidList>
                      </Section>
                    ))}
                  </div>
                ) : null}
              </div>
              {home.reading.length ? <Shelf lines={home.reading} now={now} onOpen={onOpen} /> : null}
            </>
          )}
        </Card>

        <AnimatePresence>
          {sheet ? (
            <motion.div
              key="sheet"
              initial={{ opacity: 0, x: 28, filter: "blur(6px)" }}
              animate={{ opacity: 1, x: 0, filter: "blur(0px)", transition: spring.slow }}
              exit={{ opacity: 0, x: 20, filter: "blur(6px)", transition: { duration: 0.16 } }}
              className="absolute inset-y-0 right-0 z-10 flex w-[min(620px,58%)] @max-[760px]:w-full"
            >
              <Tooltip label="Close" shortcut="back" side="left" className="absolute -left-4 top-3 z-20 @max-[760px]:left-2">
                <button
                  aria-label="Close conversation"
                  onClick={onCloseSheet}
                  className="ink-chrome grid size-8 place-items-center rounded-full border border-frame-border bg-frame text-frame-fg shadow-lg transition-transform duration-150 hover:scale-105"
                >
                  <Icon icon={Cancel01Icon} size={14} />
                </button>
              </Tooltip>
              <div className="min-w-0 flex-1 overflow-hidden rounded-2xl shadow-[0_30px_80px_-24px_rgb(10_30_60/0.55),0_0_0_1px_rgb(0_0_0/0.04)]">{sheet}</div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </section>
  );
}

function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("pane-on-sky flex min-h-0 flex-col overflow-hidden rounded-2xl bg-pane text-pane-fg", className)}>{children}</div>;
}

function CardHead({ title, note }: { title: React.ReactNode; note: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-5 pb-1 pt-4">
      <h2 className="text-[21px] font-medium leading-none tracking-[-0.035em]">{title}</h2>
      <span className="truncate text-[12px] text-pane-muted @max-[900px]:hidden">{note}</span>
    </div>
  );
}

function Section({ label, count, live, children }: { label: string; count?: number; live?: boolean; children: React.ReactNode }) {
  return (
    <div className="mt-3">
      <div className="flex items-center gap-2 px-3 pb-1.5 text-[12px] font-medium text-pane-muted">
        {label}
        {count ? (
          <span className={cn("rounded-full px-1.5 py-px text-[11px] font-semibold tabular-nums", live ? "bg-lime text-lime-fg" : "bg-pane-2 text-pane-muted")}>{count}</span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

function Loading() {
  return (
    <div className="grid flex-1 place-items-center text-pane-muted">
      <Spinner size={18} />
    </div>
  );
}

function Calm({ text }: { text: string }) {
  return <p className="blur-fade px-3 py-2 text-[13px] text-pane-muted">{text}</p>;
}

function PersonRow({
  item,
  index,
  now,
  preview,
  theirs,
  selected,
  onOpen,
  actions,
}: {
  item: ReplyItem;
  index: number;
  now: Date | null;
  preview?: string;
  theirs?: boolean;
  selected: boolean;
  onOpen: () => void;
  actions: { label: string; tip: string; icon?: Parameters<typeof Icon>[0]["icon"]; run: () => void }[];
}) {
  const waited = now ? now.getTime() - new Date(item.at).getTime() : 0;
  const long = !theirs && waited >= 2 * DAY;
  return (
    <div
      {...FLUID_ITEM}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      data-selected={selected || undefined}
      style={{ "--i": index } as React.CSSProperties}
      className={cn(
        "blur-fade-up group/row relative flex cursor-default gap-3 rounded-xl px-3 py-2.5 outline-none transition-[background-color] duration-150",
        selected ? "bg-pane-selected" : "data-[lit]:bg-pane-hover",
      )}
    >
      <Avatar name={item.person.name || item.person.email} email={item.person.email} className={cn("size-9 text-[11.5px]", theirs && "opacity-60 grayscale")} />
      <div className="min-w-0 flex-1" data-sensitive>
        <div className="flex items-baseline gap-2">
          <span className={cn("truncate text-[14px] font-semibold", theirs && "font-medium text-pane-muted")}>
            {item.person.name || item.person.email}
            {item.others ? <span className="font-normal text-pane-muted"> +{item.others}</span> : null}
          </span>
          <span className={cn("ml-auto shrink-0 text-[12px] tabular-nums", long ? "font-medium text-warning" : "text-pane-muted", "group-data-[lit]/row:invisible")}>
            {theirs ? `you wrote ${formatListDate(item.at)}` : long ? `waiting ${now ? waitedFor(item.at, now.getTime()) : ""}` : formatListDate(item.at)}
          </span>
        </div>
        <div className={cn("truncate text-[13px]", theirs ? "text-pane-muted" : "text-pane-fg/75")}>
          <span className={cn("font-medium", theirs ? "text-pane-muted" : "text-pane-fg")}>{item.subject || "(no subject)"}</span>
          {preview ? <span> · {preview}</span> : null}
        </div>
        {item.question || item.drafted || (!theirs && !item.known) ? (
          <div className="mt-1 flex gap-1.5">
            {item.question ? <span className="rounded-full bg-accent-soft px-2 py-px text-[11px] font-medium text-accent">Asks you something</span> : null}
            {!theirs && !item.known ? <span className="rounded-full bg-pane-2 px-2 py-px text-[11px] font-medium text-pane-muted">New person</span> : null}
            {item.drafted ? <span className="rounded-full bg-pane-2 px-2 py-px text-[11px] font-medium text-pane-muted">Draft started</span> : null}
          </div>
        ) : null}
      </div>
      <span className="absolute right-3 top-2 hidden items-center gap-1 group-data-[lit]/row:flex">
        {actions.map((action) => (
          <Tooltip key={action.label} label={action.tip}>
            <button
              {...FLUID_IGNORE}
              onClick={(e) => {
                e.stopPropagation();
                action.run();
              }}
              className="flex h-7 items-center gap-1.5 rounded-full border border-pane-border bg-pane px-2.5 text-[12px] font-medium text-pane-fg/80 shadow-sm transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg touch:h-9"
            >
              {action.icon ? <Icon icon={action.icon} size={14} /> : null}
              {action.label}
            </button>
          </Tooltip>
        ))}
      </span>
    </div>
  );
}

function ThingRow({ line, selected, onOpen }: { line: HomeLine; selected: boolean; onOpen: () => void }) {
  return (
    <div
      {...FLUID_ITEM}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn(
        "flex cursor-default items-center gap-3 rounded-xl px-3 py-2 outline-none transition-[background-color] duration-150",
        selected ? "bg-pane-selected" : "data-[lit]:bg-pane-hover",
      )}
    >
      <Avatar name={line.name} email={line.email} className="size-8 rounded-[10px] text-[10.5px]" />
      <div className="min-w-0 flex-1 truncate text-[13px] text-pane-muted" data-sensitive>
        <span className={cn("text-pane-fg", line.unread ? "font-semibold" : "font-medium")}>{line.name}</span>
        <span> · {line.subject}</span>
      </div>
      {line.amount ? (
        <span data-sensitive className="shrink-0 text-[13.5px] font-semibold tabular-nums text-pane-fg">
          {formatAmount(line.amount.value, line.amount.currency)}
        </span>
      ) : (
        <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">{formatListDate(line.at)}</span>
      )}
      {line.unread ? <span aria-label="Unread" className="size-1.5 shrink-0 rounded-full bg-accent" /> : null}
    </div>
  );
}

/** The things grouped by local day: Today, Yesterday, then weekdays and dates. */
function byDay(lines: HomeLine[], now: Date | null): [string, HomeLine[]][] {
  const groups = new Map<string, HomeLine[]>();
  for (const line of lines) {
    const date = new Date(line.at);
    const label = isToday(date)
      ? "Today"
      : isYesterday(date)
        ? "Yesterday"
        : now && differenceInCalendarDays(now, date) < 7
          ? format(date, "EEEE")
          : format(date, "d MMMM");
    groups.set(label, [...(groups.get(label) ?? []), line]);
  }
  return [...groups];
}

function Shelf({ lines, now, onOpen }: { lines: HomeLine[]; now: Date | null; onOpen: (line: HomeLine) => void }) {
  return (
    <div className="border-t border-pane-border bg-pane-2 px-3 pb-3 pt-2.5">
      <div className="flex items-center gap-2 px-1 pb-2 text-[12px] font-medium text-pane-muted">
        To read <span className="rounded-full bg-pane px-1.5 py-px text-[11px] font-semibold tabular-nums">{lines.length}</span>
      </div>
      <FluidList tone="pane" axis="x" className="scroll-fade flex gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none]">
        {lines.map((line, i) => (
          <button
            key={line.threadId}
            {...FLUID_ITEM}
            onClick={() => onOpen(line)}
            style={{ "--i": i } as React.CSSProperties}
            className="blur-fade-up flex w-52 shrink-0 flex-col gap-1 rounded-xl border border-pane-border bg-pane px-3 py-2.5 text-left transition-[background-color,border-color] duration-150 data-[lit]:border-pane-muted/30"
          >
            <span className="flex items-center gap-2 text-[11.5px] text-pane-muted">
              <Avatar name={line.name} email={line.email} className="size-4 text-[7px]" />
              <span className="truncate">{line.name}</span>
              <span className="ml-auto shrink-0 tabular-nums">{now ? formatListDate(line.at) : ""}</span>
            </span>
            <span data-sensitive className={cn("line-clamp-2 text-[13px] leading-snug", line.unread ? "font-semibold" : "font-medium")}>
              {line.subject || "(no subject)"}
            </span>
          </button>
        ))}
      </FluidList>
    </div>
  );
}

function CodeChip({ code }: { code: DesktopCode }) {
  const { copied, copy } = useCopy();
  const value = code.code ?? code.choices?.at(-1);
  return (
    <motion.div {...blurFade({ y: -4, blur: 4 })} className="flex h-9 shrink-0 items-center gap-2 rounded-full border border-frame-border bg-frame-hover pl-3.5 pr-1 text-[13px] backdrop-blur-md">
      <span className="size-1.5 rounded-full bg-lime shadow-[0_0_0_3px_rgb(198_245_111/0.3)]" />
      <span className="text-frame-fg/85">{code.service}</span>
      {value ? (
        <>
          <span data-sensitive className="font-semibold tracking-[0.08em] tabular-nums">{value}</span>
          <button
            onClick={() => copy(value)}
            className="flex h-7 items-center gap-1.5 rounded-full bg-frame-active px-2.5 text-[12px] font-medium text-frame-active-fg"
          >
            <CopyIcon copied={copied} size={13} tint={false} />
            {copied ? "Copied" : "Copy"}
          </button>
        </>
      ) : null}
    </motion.div>
  );
}

function MeetingChip({ event, start, now }: { event: CalendarEvent; start: number; now: number }) {
  const minutes = Math.round((start - now) / 60_000);
  return (
    <motion.div {...blurFade({ y: -4, blur: 4 })} className="flex h-9 min-w-0 items-center gap-2 rounded-full border border-frame-border bg-frame-hover pl-3.5 pr-1 text-[13px] backdrop-blur-md">
      <span className="min-w-0 truncate" data-sensitive>
        {event.summary} {minutes > 0 ? `in ${minutes} min` : "now"}
      </span>
      {event.join ? (
        <a
          href={event.join}
          target="_blank"
          rel="noreferrer"
          className="flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-frame-active px-2.5 text-[12px] font-medium text-frame-active-fg"
        >
          <Icon icon={Video01Icon} size={13} />
          Join
        </a>
      ) : (
        <span className="pr-2.5 text-frame-fg/75">{format(start, "HH:mm")}</span>
      )}
    </motion.div>
  );
}
