"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Archive02Icon,
  Cancel01Icon,
  LinkSquare02Icon,
  Location01Icon,
  KeyboardIcon,
  MailReply01Icon,
  Video01Icon,
} from "@hugeicons/core-free-icons";
import { desktopInvoke, inDesktopApp, type DesktopCode, type DesktopMail, type DesktopMeeting, type BarItem } from "@/lib/desktop";
import { blurFade, exitFor, spring } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { CopyIcon } from "../ui/copy";
import { DropZone, QuickReply, ReplySent, useQuickReply } from "./bar-reply";
import { ActivityRow, ActivitySheet, activityLine, hasSheet, ticks } from "./bar-activity";

/*
 * The Kite bar: a strip of Kite's sky floating just below the top edge of the screen (the hour's
 * colours, white type, the kite mark), in a window the desktop shell keeps warm (src-tauri/src/bar.rs).
 * Its row is what's showing (a `BarItem`: a sign-in code, a meeting about to start, mail to notify
 * about, or another app's activity from the Kite bar API, docs/bar.md) with its one thing to do as
 * the white pill; everything else waiting sits beside it as frosted chips (click to bring forward).
 * Open while it has just arrived or the pointer is over it: more buttons, and a paper sheet hanging
 * under the sky for what needs room (the mail's text, the quick reply, a meeting's place, an
 * activity's words). A lime line along the bottom edge runs down a meeting's countdown or fills with
 * an activity's progress. It drops in with a blur fade and leaves the same way; the window never
 * resizes. The shell lets clicks in only over the box this page reports, and the window never takes
 * focus (but for a quick reply).
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
/** Chips beside what's showing; more than this become "+N". */
const MAX_CHIPS = 3;

type Mode = "hidden" | "peek" | "expanded";
type Archived = "archived" | "restored" | "failed";
type Size = { w: number; h: number };

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
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
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
    const timer = setTimeout(() => leave(turn), turn ? TURN_MS : Math.max(left, 0));
    return () => clearTimeout(timer);
  }, [mode, hovered, copied, holding, item, waiting, leave]);

  // Countdowns (a meeting's, an activity's) tick while they show.
  const ticking = meeting !== null || (activity !== null && ticks(activity));
  useEffect(() => {
    if (!ticking || mode === "hidden") return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [ticking, mode]);

  // Where clicks may land: the bar's box, reported whenever it changes size.
  useEffect(() => {
    const bar = barRef.current;
    if (mode === "hidden" || !bar) return;
    const report = () => {
      const box = bar.getBoundingClientRect();
      act("shape", { shape: { x: box.left, y: box.top, w: box.width, h: box.height } });
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [mode]);

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

  // What hangs under the bar on paper: the mail's text or the reply, a meeting's place, an activity's words.
  const sheet: { key: string; node: ReactNode } | null = !item
    ? null
    : mail && mailView === "reply"
      ? { key: `reply:${mail.id}`, node: <QuickReply mail={mail} reply={reply} onClose={closeReply} onOpenInKite={openInKite} onSend={() => void sendReply()} /> }
      : mail && expanded && mailView === "expanded" && mail.preview
        ? { key: `mail:${mail.id}`, node: <MailSheet mail={mail} /> }
        : meeting && expanded && (meeting.place || meeting.end)
          ? { key: `meeting:${meeting.id}`, node: <MeetingSheet meeting={meeting} /> }
          : activity && expanded && hasSheet(activity)
            ? { key: `activity:${activity.id}`, node: <ActivitySheet activity={activity} /> }
            : null;
  // The lime line along the bar's bottom edge.
  const line = meeting ? meetingLine(meeting, now) : activity ? activityLine(activity, now) : null;
  const width = sheet ? Math.max(size.w, SHEET_WIDTH + SHEET_INSET * 2) : size.w;

  return (
    <div className="flex h-screen justify-center" style={{ background: "transparent", paddingTop: GAP }}>
      {/* The window is transparent: only the bar paints. */}
      <style>{"html,body{background:transparent!important;overflow:hidden}"}</style>
      <motion.div
        ref={barRef}
        data-sensitive
        className="relative flex h-max flex-col"
        initial={false}
        animate={shown ? { opacity: 1, y: 0, filter: "blur(0px)" } : { opacity: 0, y: -14, filter: "blur(8px)" }}
        transition={shown ? spring.slow : exitFor.slow}
        onAnimationComplete={() => {
          if (shown) return;
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
        {/* A strip of Kite's sky (the hour's colours, like the app behind its panes). */}
        <motion.div
          className="on-sky relative z-10 h-[52px] overflow-hidden rounded-[18px] text-frame-fg shadow-[0_18px_40px_-16px_rgb(10_30_70/0.6),inset_0_1px_0_rgb(255_255_255/0.28)]"
          style={{ backgroundImage: SKY }}
          initial={false}
          animate={{ width }}
          transition={spring.slow}
        >
          <AnimatePresence initial={false}>{dragging ? <DropZone key="drop" /> : null}</AnimatePresence>
          <Measure onSize={setSize}>
            <KiteMark />
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={`${item?.id}:${mailView}:${archived}:${picked}:${expanded}`}
                className="flex items-center gap-2"
                {...blurFade({ y: 4, blur: 6, speed: "moderate" })}
              >
                {!item ? null : mail && mailView === "sent" ? (
                  <ReplySent reply={reply} onUndo={undoReply} />
                ) : mail && archived ? (
                  <ArchivedRow state={archived} onUndo={undoArchive} />
                ) : mail ? (
                  <MailRow mail={mail} draft={hasDraft} open={expanded} replying={replying} onReply={startReply} onArchive={archive} onOpen={() => openMail(false)} />
                ) : meeting ? (
                  <MeetingRow meeting={meeting} now={now} joined={copied !== null} open={expanded} onJoin={join} />
                ) : code ? (
                  <CodeRow code={code} copied={copied} picked={picked} open={expanded} onCopy={() => copy()} onFill={fill} onPick={pick} onOpen={open} />
                ) : activity ? (
                  <ActivityRow activity={activity} now={now} open={expanded} onCopy={activityCopy} onOpen={activityOpen} onCallback={tellIntegration} />
                ) : null}
              </motion.div>
            </AnimatePresence>
            {chips.length ? (
              <span className="ml-1 flex items-center gap-1 border-l border-white/20 pl-2">
                {chips.map((waitingItem) => (
                  <Chip key={waitingItem.id} item={waitingItem} now={now} onClick={() => front(waitingItem.id)} />
                ))}
                {more > 0 ? <span className="px-1 text-[12px] tabular-nums text-frame-muted">+{more}</span> : null}
              </span>
            ) : null}
            {expanded && !replying && item ? (
              <button onClick={() => (activity ? dismissActivity() : leave())} aria-label="Dismiss" className={cn(FROST, "size-8 justify-center px-0")}>
                <Icon icon={Cancel01Icon} size={13} />
              </button>
            ) : null}
          </Measure>
          {line !== null ? (
            <span aria-hidden className="absolute inset-x-4 bottom-[5px] h-[2px] overflow-hidden rounded-full bg-white/20">
              <motion.span className="block h-full rounded-full bg-lime" initial={false} animate={{ width: `${line * 100}%` }} transition={{ duration: 0.6, ease: "easeOut" }} />
            </span>
          ) : null}
        </motion.div>
        {/* Paper under the sky, for what needs room. */}
        <AnimatePresence initial={false}>
          {sheet ? (
            <motion.div
              key={sheet.key}
              className="relative -mt-3 self-start overflow-hidden rounded-b-[18px] bg-pane text-pane-fg shadow-[0_22px_44px_-18px_rgb(10_30_70/0.5),0_0_0_1px_rgb(10_30_70/0.06)]"
              style={{ marginLeft: SHEET_INSET, marginRight: SHEET_INSET }}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0, transition: exitFor.moderate }}
              transition={spring.moderate}
            >
              <div className="px-4 pb-4 pt-6" style={{ width: SHEET_WIDTH }}>
                {sheet.node}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
      {demo ? <DemoControls /> : null}
    </div>
  );
}

/** The sky's colours across the bar, darkest first so white type holds at every hour, with light from the left. */
const SKY = "radial-gradient(120% 160% at 0% 0%, rgb(255 255 255 / 0.22), transparent 55%), linear-gradient(100deg, var(--sky-1), var(--sky-2) 70%, var(--sky-3) 140%)";

/** Frosted controls on the sky, and the solid white pill for the one thing to do. */
const FROST =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-white/[0.16] px-3 text-[13px] text-frame-fg transition-[background-color,transform] duration-150 hover:bg-white/[0.26] active:scale-95";
const SOLID =
  "flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-frame-active px-3.5 text-[13px] font-medium text-frame-active-fg shadow-[0_4px_12px_-4px_rgb(10_30_70/0.45)] transition-transform duration-150 active:scale-95";

/** The sheet's width, and how far in from the bar's ends it hangs. */
const SHEET_WIDTH = 420;
const SHEET_INSET = 14;

/** Kite's mark: the kite, white on the sky, with its lime tail. */
function KiteMark() {
  return (
    <svg viewBox="0 0 24 30" className="mr-0.5 h-[26px] w-[21px] shrink-0" aria-hidden>
      <path d="M12 2 20 10 12 22 4 10Z" fill="rgb(255 255 255 / 0.28)" stroke="#fff" strokeWidth={1.6} strokeLinejoin="round" />
      <path d="M4 10h16M12 2v20" stroke="#fff" strokeOpacity={0.8} strokeWidth={1.1} />
      <path d="M12 22c-1.5 2.2 1.5 3.4 0 5.6" fill="none" stroke="var(--lime)" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}

/** The bar's row at its own width (the sky animates to it). */
function Measure({ onSize, children }: { onSize: (size: Size) => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => onSize({ w: element.offsetWidth, h: element.offsetHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [onSize]);
  return (
    <div ref={ref} className="absolute left-0 top-0 flex h-[52px] w-max items-center gap-2 pl-3.5 pr-2.5">
      {children}
    </div>
  );
}

/** A name, then a word or two in the serif. */
function Says({ name, accent, max = 200 }: { name: string; accent?: ReactNode; max?: number }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5 whitespace-nowrap">
      <span className="truncate text-[13.5px] font-medium" style={{ maxWidth: max }}>
        {name}
      </span>
      {accent ? <span className="font-accent text-[15.5px] leading-none text-frame-fg/85">{accent}</span> : null}
    </span>
  );
}

/** Something waiting, as one short line on the sky: click to bring it forward. */
function Chip({ item, now, onClick }: { item: BarItem; now: number; onClick: () => void }) {
  const label =
    item.kind === "code" ? (item.code ?? item.service) : item.kind === "meeting" ? `${item.title} ${untilLabel(item.start, now)}` : item.kind === "mail" ? senderOf(item) : item.title;
  return (
    <button onClick={onClick} title="Show this" className={cn(FROST, "h-7 max-w-[170px] gap-1.5 px-2.5 text-[12px]")}>
      {item.kind === "mail" ? <Face mail={item} size={16} /> : <span className="size-1.5 shrink-0 rounded-full bg-lime" />}
      <span className={item.kind === "code" && item.code ? "truncate font-semibold tabular-nums tracking-[0.04em]" : "truncate"}>{label}</span>
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
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-white/25 font-medium text-frame-fg ring-1 ring-white/40"
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

function MailRow(props: { mail: DesktopMail; draft: boolean; open: boolean; replying: boolean; onReply: () => void; onArchive: () => void; onOpen: () => void }) {
  const { mail } = props;
  return (
    <>
      <Face mail={mail} size={26} />
      <Says name={senderOf(mail)} accent={mail.count > 1 ? `${mail.count} new` : undefined} max={150} />
      <span className="max-w-[220px] truncate text-[13px] text-frame-muted">{props.draft ? "Your reply is waiting" : mail.subject}</span>
      {props.replying ? null : (
        <>
          <button onClick={props.onReply} className={SOLID}>
            <Icon icon={MailReply01Icon} size={14} />
            {props.draft ? "Your reply" : "Reply"}
          </button>
          {props.open ? (
            <>
              <button onClick={props.onArchive} className={FROST}>
                <Icon icon={Archive02Icon} size={14} />
                Archive
              </button>
              <button onClick={props.onOpen} className={FROST}>
                Open
              </button>
            </>
          ) : null}
        </>
      )}
    </>
  );
}

/** The mail's first lines, on paper in the reading font. */
function MailSheet({ mail }: { mail: DesktopMail }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="truncate text-[12px] text-pane-muted">{mail.subject}</div>
      <p className="line-clamp-4 font-reading text-[14px] leading-relaxed">{mail.preview}</p>
    </div>
  );
}

/** After Archive: done (with Undo), put back, or it didn't work. */
function ArchivedRow({ state, onUndo }: { state: Archived; onUndo: () => void }) {
  return (
    <>
      <Says name={state === "archived" ? "Archived" : state === "restored" ? "Back in your Inbox" : "Couldn't do that."} accent={state === "failed" ? "Try it in Kite" : undefined} />
      {state === "archived" ? (
        <button onClick={onUndo} className={FROST}>
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

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** How much of the last ten minutes before a meeting is left: the lime line drains to its start. */
function meetingLine(meeting: DesktopMeeting, now: number) {
  const left = new Date(meeting.start).getTime() - now;
  return Math.min(1, Math.max(0, left / (10 * 60_000)));
}

function MeetingRow(props: { meeting: DesktopMeeting; now: number; joined: boolean; open: boolean; onJoin: () => void }) {
  const { meeting } = props;
  return (
    <>
      <Says name={meeting.title} accent={untilLabel(meeting.start, props.now)} max={240} />
      {meeting.join ? (
        <button onClick={props.onJoin} className={SOLID}>
          {props.joined ? <CopyIcon copied tint={false} /> : <Icon icon={Video01Icon} size={14} />}
          Join
        </button>
      ) : null}
    </>
  );
}

function MeetingSheet({ meeting }: { meeting: DesktopMeeting }) {
  return (
    <div className="flex items-center gap-3 text-[13px]">
      <span className="tabular-nums">
        {timeOf(meeting.start)}
        {meeting.end ? ` – ${timeOf(meeting.end)}` : ""}
      </span>
      {meeting.place ? (
        <span className="flex min-w-0 items-center gap-1 text-pane-muted">
          <Icon icon={Location01Icon} size={13} className="shrink-0" />
          <span className="truncate">{meeting.place}</span>
        </span>
      ) : null}
    </div>
  );
}

/** What each of `choices` is, said after a pick (lib/codes.ts: first, second, whole). */
const PART_WORDS = ["first part", "second part", "whole code"];

function CodeRow(props: {
  code: DesktopCode;
  copied: string | null;
  picked: number | null;
  open: boolean;
  onCopy: () => void;
  /** Types it into the field you're in (desktop app only). */
  onFill: () => void;
  onPick: (index: number) => void;
  onOpen: () => void;
}) {
  const { code, copied, picked } = props;
  const choices = !code.code && code.choices?.length ? code.choices : null;
  if (picked !== null && code.choices?.[picked]) {
    return (
      <>
        <span className="text-[17px] font-semibold tabular-nums tracking-[0.06em]">{code.choices[picked]}</span>
        <Says name="Copied." accent={`Next time, the ${PART_WORDS[picked] ?? "same part"}`} />
      </>
    );
  }
  return (
    <>
      <Says name={code.service} accent={code.code || choices ? "sign-in code" : "sign-in link"} max={170} />
      {choices ? (
        <>
          <span className="text-[12.5px] text-frame-muted">Which part?</span>
          {choices.map((value, index) => (
            <button key={value} onClick={() => props.onPick(index)} className={cn(FROST, "font-semibold tabular-nums tracking-[0.04em]")}>
              {copied === value ? <CopyIcon copied tint={false} /> : null}
              {value}
            </button>
          ))}
        </>
      ) : code.code ? (
        <>
          <span className="px-1 text-[20px] font-semibold leading-none tabular-nums tracking-[0.06em]">{code.code}</span>
          {/* Fill types it where you are (the bar never takes the keyboard); offered while it's open, in the desktop app. */}
          {props.open && inDesktopApp() ? (
            <button onClick={props.onFill} title="Type it into the field you're in" className={FROST}>
              {copied === "fill" ? <CopyIcon copied tint={false} /> : <Icon icon={KeyboardIcon} size={14} />}
              {copied === "fill" ? "Filled" : "Fill"}
            </button>
          ) : null}
          <button onClick={props.onCopy} className={SOLID}>
            <CopyIcon copied={copied !== null && copied !== "fill"} tint={false} />
            {copied !== null && copied !== "fill" ? "Copied" : "Copy"}
          </button>
          {code.link && props.open ? (
            <button onClick={props.onOpen} className={FROST}>
              Open link
            </button>
          ) : null}
        </>
      ) : (
        <>
          <span className="max-w-[180px] truncate text-[13px] text-frame-muted">{hostOf(code.link)}</span>
          <button onClick={props.onOpen} className={SOLID}>
            {copied !== null ? <CopyIcon copied tint={false} /> : <Icon icon={LinkSquare02Icon} size={14} />}
            Open link
          </button>
        </>
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
