"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { Archive02Icon, Cancel01Icon, Key01Icon, KeyboardIcon, LinkSquare02Icon, MailReply01Icon, Video01Icon } from "@hugeicons/core-free-icons";
import { desktopInvoke, inDesktopApp, type DesktopCode, type DesktopMail, type DesktopMeeting, type BarItem } from "@/lib/desktop";
import { exitFor, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { capitalise } from "@/lib/format";
import { Icon } from "../icon";
import { CopyIcon } from "../ui/copy";
import { DropZone, QuickReply, ReplySent, useQuickReply } from "./bar-reply";
import { ActivityRow, ActivitySheet, BTN, Lines, PRIMARY, Tile, hasSheet, ticks } from "./bar-activity";

/*
 * The Kite bar: a plain card just below the top edge of the screen, in Kite's light or dark panes, in a
 * window the desktop shell keeps warm (src-tauri/src/bar.rs). Its row is what's showing (a `BarItem`:
 * a sign-in code, a meeting about to start, mail to notify about, or another app's activity from the
 * Kite bar API, docs/bar.md): an icon, a title with a line under it, and every button it has, the one
 * thing to do in the accent. While it has just arrived or the pointer is over it, what needs room shows
 * under the row (the mail's first lines, the quick reply, an activity's words); what else waits is a
 * line of chips at the foot (click to bring one forward). The card is always the same width, so
 * nothing moves under the pointer; it slides in and out (opacity and position only) and the window
 * never resizes. The shell lets clicks in only over the box this page reports, and the window never
 * takes focus (but for a quick reply).
 */

/** Open after something arrives, unless the pointer is over it. */
const ARRIVE_MS = 4_000;
/** Then resting as one line before it leaves (a code; a meeting rests until just after it starts). */
const REST_MS = 60_000;
/** A meeting's pill stays until this long after its start, and at least `MEETING_REST_MIN_MS`. */
const MEETING_AFTER_MS = 2 * 60_000;
const MEETING_REST_MIN_MS = 30_000;
/** After a copy or open: the tick, then away. */
const DONE_MS = 1_200;
/** Mail stays open a little longer on arrival: there's a line to read. */
const MAIL_ARRIVE_MS = 6_000;
/** "Archived" with Undo, before it leaves. */
const ARCHIVED_MS = 4_000;
/** After picking a part: long enough to read what Kite will do next time. */
const PICKED_MS = 2_800;
/** With something waiting, a long-lived pill makes way after this long (and comes back). */
const TURN_MS = 8_000;
/** How far the bar floats below the top of the screen. */
const GAP = 8;
/** Chips at the foot; more than this become "+N". */
const MAX_CHIPS = 3;
/** The card's width: fixed, so hovering or a change of item never moves anything. */
const WIDTH = 500;
/** A new item's row comes in part by part: a few px up and in, one after another (opacity and transform only). */
const ROW_IN =
  "@keyframes bar-in{from{opacity:0;transform:translateY(4px)}}.bar-row>*{animation:bar-in .22s cubic-bezier(.22,1,.36,1) both}" +
  [2, 3, 4, 5, 6, 7, 8].map((n) => `.bar-row>:nth-child(${n}){animation-delay:${(n - 1) * 25}ms}`).join("");
/** The ring round ×: its radius and length. */
const RING_R = 12.5;
const RING = 2 * Math.PI * RING_R;

type Mode = "hidden" | "peek" | "expanded";
type Archived = "archived" | "restored" | "failed";

/** What the shell says along with the item (bar.rs `refresh_page`): what waits, in order. */
type Context = { waiting: BarItem[]; quiet: boolean };

declare global {
  interface Window {
    /** The shell hands the Kite bar what to show, new or updated (bar.rs `refresh_page`). */
    __kiteBar?: (item: BarItem, context?: Context) => void;
    /** The shell takes the showing item away (an integration removed it). */
    __kiteBarLeave?: (id: string) => void;
    /** Dev only (?demo): a sample item, queued like the shell would. */
    __kiteBarDemo?: (item: BarItem) => void;
  }
}

/** When an item is done and leaves for good: an activity when it expires (updates move it), a meeting
 * just after it starts, anything else a while after it first came (kept when it takes turns). */
function deadlineOf(item: BarItem, before: number | undefined) {
  if (item.kind === "activity") return new Date(item.expiresAt).getTime();
  if (before) return before;
  if (item.kind === "meeting") return Math.max(new Date(item.start).getTime() + MEETING_AFTER_MS, Date.now() + MEETING_REST_MIN_MS);
  return Date.now() + REST_MS;
}

/** Tells the shell (bar.rs `bar`). In a browser (the ?demo page) there is no shell to tell. */
const act = (action: string, args: Record<string, unknown> = {}) => {
  if (!inDesktopApp()) return;
  void desktopInvoke("bar", { action, ...args }).catch((error) => console.error(`bar ${action}:`, error));
};

export function Bar({ demo = false }: { demo?: boolean }) {
  const [item, setItem] = useState<BarItem | null>(null);
  /** The clock a meeting's countdown reads, ticking while one shows. */
  const [now, setNow] = useState(0);
  const [mode, setMode] = useState<Mode>("hidden");
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** The part of an unclear code the user just picked: the shape turns into its confirmation. */
  const [picked, setPicked] = useState<number | null>(null);
  const done = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Mail archived from the Kite bar: the shape says so, with Undo. */
  const [archived, setArchived] = useState<Archived | null>(null);
  const code = item?.kind === "code" ? item : null;
  const meeting = item?.kind === "meeting" ? item : null;
  const mail = item?.kind === "mail" ? item : null;
  const activity = item?.kind === "activity" ? item : null;
  /** What waits behind this one (the shell's queue), shown as chips. */
  const [queue, setQueue] = useState<BarItem[]>([]);
  const waiting = queue.length;
  const barRef = useRef<HTMLDivElement>(null);
  /** The ring round × (its time left). */
  const leaving = useRef<SVGCircleElement>(null);
  const itemRef = useRef<BarItem | null>(null);
  /** When each item is done (it leaves for good then): kept per id, so one that took turns keeps its time. */
  const deadlines = useRef(new Map<string, number>());
  /** The item is leaving only to make way (back in the queue), not done. */
  const again = useRef(false);
  /** A quick reply open in the Kite bar (it has the keyboard meanwhile), and files being dragged onto it. */
  const reply = useQuickReply(mail, demo);
  const [replying, setReplying] = useState(false);
  const [dragging, setDragging] = useState(false);
  /** The reply was opened by files dragged over the Kite bar: dragged away again without a drop, it closes. */
  const byDrag = useRef(false);
  const { reset: resetReply } = reply;
  const hasDraft = reply.text.trim().length > 0 || reply.files.length > 0;
  /** Nothing leaves while a reply is open, written, or on its way. */
  const holding = replying || hasDraft || reply.phase !== "writing";

  /** Leaves (pulls back up into the edge); the shell then shows what's next. */
  const leave = useCallback((makingWay = false) => {
    again.current = makingWay;
    setMode("hidden");
  }, []);

  // The shell calls in with each item; tell it the page is ready (again after a reload).
  useEffect(() => {
    window.__kiteBar = (next, context) => {
      setQueue(context?.waiting ?? []);
      setNow(Date.now());
      const same = itemRef.current?.id === next.id;
      itemRef.current = next;
      setItem(next);
      const deadline = deadlineOf(next, deadlines.current.get(next.id));
      deadlines.current.set(next.id, deadline);
      // An update to what's showing: in place, nothing else changes.
      if (same) return;
      if (done.current) clearTimeout(done.current);
      setCopied(null);
      setPicked(null);
      setArchived(null);
      setReplying(false);
      setDragging(false);
      resetReply();
      // Quiet, or a passive activity: just the pill.
      const calm = context?.quiet || (next.kind === "activity" && next.priority === "passive");
      setMode(calm ? "peek" : "expanded");
    };
    window.__kiteBarLeave = (id) => {
      if (itemRef.current?.id === id) leave();
    };
    act("ready");
    // The browser demo plays the shell's queue: a sample arriving while one shows waits as a chip.
    window.__kiteBarDemo = (next) => {
      if (itemRef.current) setQueue((current) => [...current, next]);
      else window.__kiteBar?.(next, { waiting: [], quiet: false });
    };
    return () => {
      delete window.__kiteBar;
      delete window.__kiteBarLeave;
      delete window.__kiteBarDemo;
    };
  }, [resetReply, leave]);

  // A file dropped anywhere else in the window would replace the page with it.
  useEffect(() => {
    const stop = (event: DragEvent) => event.preventDefault();
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  // Sent: the tick, then away.
  useEffect(() => {
    if (reply.phase !== "sent") return;
    const timer = setTimeout(() => leave(), DONE_MS + 400);
    return () => clearTimeout(timer);
  }, [reply.phase, leave]);

  // Open on arrival, then rest as one line until it's done, then leave; the pointer holds it where it
  // is. With something waiting, a long-lived one makes way after a while and comes back later.
  useEffect(() => {
    if (hovered || copied !== null || holding || mode === "hidden" || !item) return;
    if (mode === "expanded") {
      const timer = setTimeout(() => setMode("peek"), item.kind === "mail" ? MAIL_ARRIVE_MS : ARRIVE_MS);
      return () => clearTimeout(timer);
    }
    const left = (deadlines.current.get(item.id) ?? 0) - Date.now();
    const turn = waiting > 0 && left > TURN_MS + 1_000;
    const ms = turn ? TURN_MS : Math.max(left, 0);
    const timer = setTimeout(() => leave(turn), ms);
    // The ring round × runs down to the moment it leaves; the pointer stops it (and it fills again).
    const run = leaving.current?.animate([{ strokeDashoffset: 0, opacity: 1 }, { strokeDashoffset: RING, opacity: 1 }], { duration: ms, easing: "linear" });
    return () => {
      clearTimeout(timer);
      run?.cancel();
    };
  }, [mode, hovered, copied, holding, item, waiting, leave]);

  // Countdowns (a meeting's, an activity's) tick while they show.
  const ticking = meeting !== null || (activity !== null && ticks(activity));
  useEffect(() => {
    if (!ticking || mode === "hidden") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking, mode]);

  // Where clicks may land: the bar's box, reported whenever it changes size (and once it has slid in).
  const reportShape = useCallback(() => {
    const box = barRef.current?.getBoundingClientRect();
    if (box) act("shape", { shape: { x: box.left, y: box.top, w: box.width, h: box.height } });
  }, []);
  useEffect(() => {
    const bar = barRef.current;
    if (mode === "hidden" || !bar) return;
    const report = reportShape;
    report();
    const observer = new ResizeObserver(report);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [mode, reportShape]);

  const finish = (value: string, ms = DONE_MS) => {
    setCopied(value);
    done.current = setTimeout(() => leave(), ms);
  };
  const copy = (value?: string) => {
    if (!code) return;
    act("copy", value ? { value } : {});
    // In a browser there's no shell to copy: the demo copies itself.
    if (demo) void navigator.clipboard?.writeText(value ?? code.code ?? "").catch(() => {});
    finish(value ?? code.code ?? "");
  };
  const pick = (index: number) => {
    const value = code?.choices?.[index];
    if (!code || !value) return;
    act("copy", { value });
    if (demo) void navigator.clipboard?.writeText(value).catch(() => {});
    setPicked(index);
    finish(value, PICKED_MS);
    if (demo) return;
    // Remembered for this sender's codes of the same shape, so the next one copies directly.
    void fetch("/api/codes/pick", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: code.id, index }) }).catch(() => {});
  };
  const open = () => {
    act("open");
    finish("open");
  };
  /** Fill: the shell types the code into the field you're in (the bar never took the keyboard). */
  const fill = () => {
    if (!code?.code) return;
    act("fill");
    finish("fill");
  };
  const join = () => {
    act("join");
    if (demo && meeting?.join) window.open(meeting.join, "_blank", "noopener");
    finish("join");
  };
  /** Mail: Open and Reply bring Kite forward on the conversation (the shell), so the Kite bar goes. */
  const openMail = (reply: boolean) => {
    act(reply ? "reply" : "open");
    finish(reply ? "reply" : "open", 300);
  };
  const runOp = async (op: "archive" | "unarchive") => {
    if (!mail || demo) return true;
    const key = mail.threadId.slice(mail.accountId.length + 1);
    const res = await fetch(`/api/mail/threads/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: mail.accountId, op }),
    }).catch(() => null);
    return res?.ok ?? false;
  };
  const leaveIn = (ms: number) => {
    if (done.current) clearTimeout(done.current);
    done.current = setTimeout(() => leave(), ms);
  };
  const archive = async () => {
    setCopied("archive");
    setArchived("archived");
    leaveIn(ARCHIVED_MS);
    if (await runOp("archive")) return;
    setArchived("failed");
    leaveIn(ARCHIVED_MS);
  };
  const undoArchive = async () => {
    if (done.current) clearTimeout(done.current);
    const ok = await runOp("unarchive");
    setArchived(ok ? "restored" : "failed");
    leaveIn(ok ? DONE_MS : ARCHIVED_MS);
  };

  /** Quick reply: the Kite bar takes the keyboard (the shell) and the reply opens in place. */
  const startReply = () => {
    byDrag.current = false;
    setReplying(true);
    setMode("expanded");
    reply.prepare();
    act("focus");
  };
  const closeReply = () => {
    setReplying(false);
    act("release");
  };
  const sendReply = async () => {
    if (!(await reply.send())) return;
    setReplying(false);
    act("release");
  };
  const undoReply = async () => {
    if (!(await reply.undo())) return;
    setReplying(true);
    act("focus");
  };
  const openInKite = () => {
    setReplying(false);
    act("release");
    openMail(true);
  };
  /** Files from Explorer dragged over the mail bar: it opens into a reply to drop them on. */
  const filesDragged = (event: React.DragEvent) => mail !== null && reply.phase === "writing" && event.dataTransfer.types.includes("Files");
  const dragIn = (event: React.DragEvent) => {
    if (!filesDragged(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    if (dragging) return;
    setDragging(true);
    setMode("expanded");
    if (!replying) {
      byDrag.current = true;
      setReplying(true);
      reply.prepare();
    }
  };
  const dragOut = (event: React.DragEvent) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragging(false);
    if (byDrag.current && !hasDraft) setReplying(false);
  };
  const drop = (event: React.DragEvent) => {
    if (!filesDragged(event)) return;
    event.preventDefault();
    setDragging(false);
    byDrag.current = false;
    reply.addFiles(event.dataTransfer.files);
    act("focus");
  };
  /** Another app's activity: Copy and Open by the shell, callbacks and Dismiss to its integration. */
  const tellIntegration = (action: string) => {
    if (!activity || demo) return;
    void fetch("/api/bar/act", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: activity.id, action }) }).catch(() => {});
  };
  const activityCopy = (index?: number) => {
    act("copy", index === undefined ? {} : { index });
    if (!demo || !activity) return;
    const button = index === undefined ? null : activity.actions[index];
    const text = button?.type === "copy" ? button.text : activity.value?.type === "code" ? activity.value.code : "";
    void navigator.clipboard?.writeText(text).catch(() => {});
  };
  const activityOpen = (index: number) => {
    act("open", { index });
    const button = activity?.actions[index];
    if (demo && button?.type === "open_url") window.open(button.url, "_blank", "noopener");
  };
  const dismissActivity = () => {
    tellIntegration("dismiss");
    leave();
  };

  const mailView = reply.phase !== "writing" ? "sent" : archived ? "archived" : replying ? "reply" : mode;
  const shown = mode !== "hidden" && item !== null;
  const expanded = mode === "expanded";

  /** A chip: that item comes forward (the shell), what's showing waits first in line. */
  const front = (id: string) => {
    if (holding) return;
    act("front", { id });
    if (demo) {
      const chosen = queue.find((q) => q.id === id);
      if (chosen && item) window.__kiteBar?.(chosen, { waiting: [item, ...queue.filter((q) => q.id !== id)], quiet: false });
    }
  };
  const chips = queue.slice(0, MAX_CHIPS);
  const more = queue.length - chips.length;

  // What shows under the row while open: the reply, the mail's first lines, an activity's words.
  const sheet: { key: string; node: ReactNode } | null = !item
    ? null
    : mail && mailView === "reply"
      ? { key: `reply:${mail.id}`, node: <QuickReply mail={mail} reply={reply} onClose={closeReply} onOpenInKite={openInKite} onSend={() => void sendReply()} /> }
      : mail && expanded && mailView === "expanded" && mail.preview
        ? { key: `mail:${mail.id}`, node: <p className="line-clamp-3 text-[13px] leading-relaxed">{mail.preview}</p> }
        : activity && expanded && hasSheet(activity)
          ? { key: `activity:${activity.id}`, node: <ActivitySheet activity={activity} /> }
          : null;

  return (
    <div className="flex h-screen justify-center" style={{ background: "transparent", paddingTop: GAP }}>
      {/* The window is transparent: only the card paints. */}
      <style>{"html,body{background:transparent!important;overflow:hidden}" + ROW_IN}</style>
      <motion.div
        ref={barRef}
        data-sensitive
        className="relative flex h-max flex-col overflow-hidden rounded-xl border border-pane-border bg-pane text-pane-fg shadow-[0_10px_30px_-10px_rgb(0_0_0/0.35)]"
        style={{ width: WIDTH }}
        initial={false}
        animate={shown ? { opacity: 1, y: 0, scale: 1 } : { opacity: 0, y: -10, scale: 0.97 }}
        transition={shown ? spring.moderate : exitFor.moderate}
        onAnimationComplete={() => {
          if (shown) return reportShape();
          act("hidden", { again: again.current });
          // The browser demo plays the shell: the next in line comes up.
          if (!demo) return;
          if (queue.length) window.__kiteBar?.(queue[0], { waiting: queue.slice(1), quiet: false });
          else itemRef.current = null;
        }}
        onMouseEnter={() => {
          setHovered(true);
          if (copied === null && mode === "peek") setMode("expanded");
        }}
        onMouseLeave={() => {
          setHovered(false);
          if (copied === null && !holding && mode === "expanded") setMode("peek");
        }}
        onDragEnter={dragIn}
        onDragOver={dragIn}
        onDragLeave={dragOut}
        onDrop={drop}
      >
        {dragging ? <DropZone /> : null}
        <div key={`${item?.id}:${reply.phase}:${archived}:${picked}:${replying}`} className="bar-row flex h-[52px] items-center gap-2 pl-2.5 pr-1.5">
          {!item ? null : mail && mailView === "sent" ? (
            <ReplySent reply={reply} onUndo={undoReply} />
          ) : mail && archived ? (
            <ArchivedRow state={archived} onUndo={undoArchive} />
          ) : mail ? (
            <MailRow mail={mail} draft={hasDraft} replying={replying} onReply={startReply} onArchive={archive} onOpen={() => openMail(false)} />
          ) : meeting ? (
            <MeetingRow meeting={meeting} now={now} joined={copied !== null} onJoin={join} />
          ) : code ? (
            <CodeRow code={code} copied={copied} picked={picked} onCopy={() => copy()} onFill={fill} onPick={pick} onOpen={open} />
          ) : activity ? (
            <ActivityRow activity={activity} now={now} onCopy={activityCopy} onOpen={activityOpen} onCallback={tellIntegration} />
          ) : null}
          {item && !replying ? (
            <button
              onClick={() => (activity ? dismissActivity() : leave())}
              aria-label="Dismiss"
              title="Dismiss (the ring is how long it stays; point at it to keep it)"
              className="relative grid size-7 shrink-0 place-items-center rounded-full text-pane-muted transition-colors duration-150 hover:bg-pane-2 hover:text-pane-fg"
            >
              <svg viewBox="0 0 28 28" className="absolute inset-0 -rotate-90" aria-hidden>
                <circle ref={leaving} cx="14" cy="14" r={RING_R} fill="none" stroke="currentColor" strokeWidth={1.5} strokeDasharray={RING} strokeLinecap="round" opacity={0} />
              </svg>
              <Icon icon={Cancel01Icon} size={12} />
            </button>
          ) : null}
        </div>
        {sheet ? (
          <div key={sheet.key} className="border-t border-pane-border px-3 py-2.5">
            {sheet.node}
          </div>
        ) : null}
        {chips.length ? (
          <div className="flex h-9 items-center gap-1.5 border-t border-pane-border px-2.5 text-[12px]">
            <span className="shrink-0 text-pane-muted">Next</span>
            {chips.map((waitingItem) => (
              <Chip key={waitingItem.id} item={waitingItem} now={now} onClick={() => front(waitingItem.id)} />
            ))}
            {more > 0 ? <span className="shrink-0 tabular-nums text-pane-muted">+{more}</span> : null}
          </div>
        ) : null}
      </motion.div>
      {demo ? <DemoControls /> : null}
    </div>
  );
}

/** Something waiting: click to bring it forward. */
function Chip({ item, now, onClick }: { item: BarItem; now: number; onClick: () => void }) {
  const label =
    item.kind === "code" ? (item.code ?? item.service) : item.kind === "meeting" ? `${item.title} ${untilLabel(item.start, now)}` : item.kind === "mail" ? senderOf(item) : item.title;
  return (
    <button onClick={onClick} title="Show this" className={cn(BTN, "h-6 min-w-0 max-w-[150px] gap-1.5 px-2 text-[12px]")}>
      {item.kind === "mail" ? <Face mail={item} size={14} /> : null}
      <span className={item.kind === "code" && item.code ? "truncate font-semibold tabular-nums" : "truncate"}>{label}</span>
    </button>
  );
}

const hostOf = (link?: string) => {
  try {
    return link ? new URL(link).host : "";
  } catch {
    return "";
  }
};

const senderOf = (mail: DesktopMail) => mail.from.name || mail.from.email;

/** The sender's picture (the app's avatar cache), over their initial until it loads or if there's none. */
function Face({ mail, size }: { mail: DesktopMail; size: number }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-pane-2 font-medium text-pane-fg"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {senderOf(mail).slice(0, 1).toUpperCase()}
      {failed ? null : (
        // eslint-disable-next-line @next/next/no-img-element -- a local route, not an optimisable asset
        <img alt="" src={`/api/avatar?email=${encodeURIComponent(mail.from.email)}`} onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />
      )}
    </span>
  );
}

function MailRow(props: { mail: DesktopMail; draft: boolean; replying: boolean; onReply: () => void; onArchive: () => void; onOpen: () => void }) {
  const { mail } = props;
  return (
    <>
      <Face mail={mail} size={32} />
      <Lines title={mail.count > 1 ? `${senderOf(mail)} · ${mail.count} new` : senderOf(mail)} under={props.draft ? "Your reply is waiting" : mail.subject} />
      {props.replying ? null : (
        <>
          <button onClick={props.onReply} className={PRIMARY}>
            <Icon icon={MailReply01Icon} size={13} />
            {props.draft ? "Your reply" : "Reply"}
          </button>
          <button onClick={props.onArchive} className={BTN}>
            <Icon icon={Archive02Icon} size={13} />
            Archive
          </button>
          <button onClick={props.onOpen} className={BTN}>
            Open
          </button>
        </>
      )}
    </>
  );
}

/** After Archive: done (with Undo), put back, or it didn't work. */
function ArchivedRow({ state, onUndo }: { state: Archived; onUndo: () => void }) {
  return (
    <>
      <Tile className="text-pane-muted">
        <Icon icon={Archive02Icon} size={16} />
      </Tile>
      <Lines title={state === "archived" ? "Archived" : state === "restored" ? "Back in your Inbox" : "Couldn't do that"} under={state === "failed" ? "Try it in Kite" : undefined} />
      {state === "archived" ? (
        <button onClick={onUndo} className={BTN}>
          Undo
        </button>
      ) : null}
    </>
  );
}

/** "in 2 min", "in 40 s", "now", "started 3 min ago". */
function untilLabel(start: string, now: number) {
  const seconds = Math.round((new Date(start).getTime() - now) / 1000);
  if (seconds > 90) return `in ${Math.round(seconds / 60)} min`;
  if (seconds > 10) return `in ${seconds} s`;
  if (seconds > -60) return "now";
  return `started ${Math.round(-seconds / 60)} min ago`;
}

/** How much of the last ten minutes before a meeting is left. */
const meetingLeft = (meeting: DesktopMeeting, now: number) => Math.min(1, Math.max(0, (new Date(meeting.start).getTime() - now) / (10 * 60_000)));

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function MeetingRow(props: { meeting: DesktopMeeting; now: number; joined: boolean; onJoin: () => void }) {
  const { meeting } = props;
  const starts = untilLabel(meeting.start, props.now);
  const when = `${timeOf(meeting.start)}${meeting.end ? ` – ${timeOf(meeting.end)}` : ""}`;
  return (
    <>
      {/* The ring runs down the last ten minutes before it starts. */}
      <Tile className="text-accent" ring={meetingLeft(meeting, props.now)}>
        <Icon icon={Video01Icon} size={16} />
      </Tile>
      <Lines
        title={meeting.title}
        under={[starts === "now" ? "Starting now" : starts.startsWith("started") ? capitalise(starts) : `Starts ${starts}`, when, meeting.place].filter(Boolean).join(" · ")}
      />
      {meeting.join ? (
        <button onClick={props.onJoin} className={PRIMARY}>
          {props.joined ? <CopyIcon copied tint={false} size={13} /> : <Icon icon={Video01Icon} size={13} />}
          Join
        </button>
      ) : null}
    </>
  );
}

/** The code in cells, grouped in threes; copying lights them one after another. */
function Digits({ code, copied }: { code: string; copied: boolean }) {
  const chars = [...code];
  return (
    <span className="flex shrink-0 items-center gap-[3px] px-0.5" aria-label={code}>
      {chars.map((char, index) => (
        <span
          key={index}
          aria-hidden
          style={{ transitionDelay: copied ? `${index * 30}ms` : "0ms" }}
          className={cn(
            "grid h-7 w-[19px] place-items-center rounded-md text-[15px] font-semibold tabular-nums transition-colors duration-150",
            copied ? "bg-accent-soft text-accent" : "bg-pane-2",
            index > 0 && index % 3 === 0 && chars.length > 4 && "ml-1.5",
          )}
        >
          {char}
        </span>
      ))}
    </span>
  );
}

/** What each of `choices` is, said after a pick (lib/codes.ts: first, second, whole). */
const PART_WORDS = ["first part", "second part", "whole code"];

function CodeRow(props: {
  code: DesktopCode;
  copied: string | null;
  picked: number | null;
  onCopy: () => void;
  /** Types it into the field you're in (desktop app only). */
  onFill: () => void;
  onPick: (index: number) => void;
  onOpen: () => void;
}) {
  const { code, copied, picked } = props;
  const choices = !code.code && code.choices?.length ? code.choices : null;
  const tile = (
    <Tile className="text-accent">
      <Icon icon={Key01Icon} size={16} />
    </Tile>
  );
  if (picked !== null && code.choices?.[picked]) {
    return (
      <>
        {tile}
        <Lines title={`Copied ${code.choices[picked]}`} under={`Next time Kite copies the ${PART_WORDS[picked] ?? "same part"}`} />
      </>
    );
  }
  const copiedCode = copied !== null && copied !== "fill" && copied !== "open";
  return (
    <>
      {tile}
      <Lines title={code.service} under={choices ? "Which part is the code?" : code.code ? "Sign-in code" : hostOf(code.link) || "Sign-in link"} />
      {choices ? (
        choices.map((value, index) => (
          <button key={value} onClick={() => props.onPick(index)} className={cn(BTN, "font-semibold tabular-nums")}>
            {copied === value ? <CopyIcon copied tint={false} size={13} /> : null}
            {value}
          </button>
        ))
      ) : code.code ? (
        <>
          <Digits code={code.code} copied={copiedCode} />
          {/* Fill types it where you are (the bar never takes the keyboard), in the desktop app. */}
          {inDesktopApp() ? (
            <button onClick={props.onFill} title="Type it into the field you're in" className={BTN}>
              {copied === "fill" ? <CopyIcon copied tint={false} size={13} /> : <Icon icon={KeyboardIcon} size={13} />}
              {copied === "fill" ? "Filled" : "Fill"}
            </button>
          ) : null}
          {code.link ? (
            <button onClick={props.onOpen} title={hostOf(code.link)} className={BTN}>
              {copied === "open" ? <CopyIcon copied tint={false} size={13} /> : <Icon icon={LinkSquare02Icon} size={13} />}
              Open
            </button>
          ) : null}
          <button onClick={props.onCopy} className={PRIMARY}>
            <CopyIcon copied={copiedCode} tint={false} size={13} />
            {copiedCode ? "Copied" : "Copy"}
          </button>
        </>
      ) : (
        <button onClick={props.onOpen} className={PRIMARY}>
          {copied !== null ? <CopyIcon copied tint={false} size={13} /> : <Icon icon={LinkSquare02Icon} size={13} />}
          Open link
        </button>
      )}
    </>
  );
}

const SAMPLES: { label: string; item: () => BarItem }[] = [
  { label: "Code", item: () => ({ kind: "code", id: "demo-code", service: "GitHub", code: "482193", receivedAt: "", threadId: "" }) },
  {
    label: "Code + link",
    item: () => ({
      kind: "code",
      id: "demo-both",
      service: "Microsoft account team",
      code: "584921",
      link: "https://login.live.com/oauth20_remoteconnect.srf",
      receivedAt: "",
      threadId: "",
    }),
  },
  { label: "Link", item: () => ({ kind: "code", id: "demo-link", service: "Linear", link: "https://linear.app/auth/magic?token=x", receivedAt: "", threadId: "" }) },
  { label: "Pick", item: () => ({ kind: "code", id: "demo-pick", service: "SARS eFiling", choices: ["6246", "160281", "6246-160281"], receivedAt: "", threadId: "" }) },
  {
    label: "Mail",
    item: () => ({
      kind: "mail",
      id: "demo-mail",
      accountId: "demo",
      threadId: "demo:t1",
      from: { name: "Alice Mokoena", email: "alice@example.com" },
      subject: "Contract approved",
      preview: "Everything is signed on our side. Can we start on the 1st, or would you rather wait for the board on Thursday?",
      count: 1,
    }),
  },
  {
    label: "Activity",
    item: () => ({
      kind: "activity",
      id: "demo:deploy",
      key: "deploy",
      source: { id: "demo", name: "Kite bar demo" },
      title: "Deploying kite-web",
      subtitle: "main · Running tests",
      icon: "deploy",
      tint: "accent",
      value: { type: "progress", progress: 0.4, label: "Step 2 of 5" },
      actions: [
        { type: "open_url", label: "View logs", url: "https://example.com" },
        { type: "callback", label: "Cancel", id: "cancel" },
      ],
      priority: "normal",
      duration: 120,
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    }),
  },
  {
    label: "Meeting",
    item: () => {
      const start = Date.now() + 2 * 60_000;
      return {
        kind: "meeting",
        id: "demo-meeting",
        title: "Product sync",
        start: new Date(start).toISOString(),
        end: new Date(start + 30 * 60_000).toISOString(),
        join: "https://meet.google.com/abc-defg-hij",
        place: "Google Meet",
      };
    },
  },
];

/** Dev only (/desktop/bar?demo): sample items, to work on the Kite bar in a browser. */
function DemoControls() {
  return (
    <div className="fixed inset-x-0 bottom-3 flex justify-center gap-2">
      {SAMPLES.map((sample) => (
        <button
          key={sample.label}
          onClick={() => {
            const item = sample.item();
            window.__kiteBarDemo?.({ ...item, id: `${item.id}-${Date.now()}` });
          }}
          className="h-8 rounded-full bg-frame px-3 text-[12px] text-frame-fg hover:bg-frame-hover"
        >
          {sample.label}
        </button>
      ))}
    </div>
  );
}
