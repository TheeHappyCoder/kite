"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Alert02Icon, Archive02Icon, Delete02Icon, LinkSquare02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { MailBatchJob, MailBatchPreview, MailBatchRequest, MailBatchResult } from "@/lib/mail/batch";
import { accountName, type Account } from "@/lib/mail/types";
import { blurFade, spring } from "@/lib/motion";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Segmented } from "../settings/settings-ui";
import { Dialog } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { AccountFace } from "./account-face";
import { postJson, type SetToast } from "./app/util";

// Bulk changes (Cleanup's Archive / Move to Trash, Trash's Delete forever and Empty Trash). Opening one
// counts the mail at once; the sheet says how many and where, then the run shows its progress. A run
// can be hidden and carries on as a pill in the corner; Stop ends it after the chunk under way, and
// what's done keeps its Undo. Archive skips the sheet: it's undone as easily as it's done.

type Stage = "review" | "confirm" | "run" | "done";
type Options = {
  /** Senders in the request that can be unsubscribed from: offers "Unsubscribe too". */
  unsubscribable?: number;
  /** Straight to the run, no sheet (archive). */
  quiet?: boolean;
};
type Flow = { request: MailBatchRequest; options: Options; stage: Stage; job: MailBatchJob | null; preview: MailBatchPreview | null; result: MailBatchResult | null; error: string };

const VERBS = {
  trash: { title: "Move to Trash", running: "Moving to Trash", done: "moved to Trash", icon: Delete02Icon },
  archive: { title: "Archive", running: "Archiving", done: "archived", icon: Archive02Icon },
  permanent: { title: "Delete forever", running: "Deleting", done: "deleted forever", icon: Delete02Icon },
} as const;

const getJob = async (id: string) => {
  const res = await fetch(`/api/mail/batch?job=${id}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? "Lost track of that change. Refresh to see where it got to.");
  return data as MailBatchJob;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useMailBatch({ accounts, onToast, onChanged }: { accounts: Account[]; onToast: SetToast; onChanged: () => void }) {
  const [flow, setFlow] = useState<Flow | null>(null);
  const [shown, setShown] = useState(false);
  // Each review / run gets a number; a newer one (or Cancel) makes an older loop stop reporting.
  const turn = useRef(0);
  const patch = (mine: number, change: Partial<Flow>) => {
    if (turn.current === mine) setFlow((f) => (f ? { ...f, ...change } : f));
  };

  /** Follows a job until it finishes, keeping `flow.job` current. Null when it was cancelled meanwhile. */
  const follow = async (mine: number, started: MailBatchJob) => {
    let job = started;
    patch(mine, { job });
    while (!job.finished) {
      await wait(job.kind === "review" ? 200 : 400);
      if (turn.current !== mine) return null;
      job = await getJob(job.id);
      patch(mine, { job });
    }
    if (job.error) throw new Error(job.error);
    return turn.current === mine ? job : null;
  };

  const review = async (request: MailBatchRequest, options: Options) => {
    const mine = ++turn.current;
    setFlow({ request, options, stage: "review", job: null, preview: null, result: null, error: "" });
    try {
      const job = await follow(mine, await postJson<MailBatchJob>("/api/mail/batch", { kind: "preview", ...request }));
      if (!job?.preview) return;
      if (options.quiet && job.preview.count) return void execute(mine, request, job.preview);
      if (options.quiet) {
        setFlow(null);
        onToast({ message: "Nothing left to archive" });
        return;
      }
      patch(mine, { stage: "confirm", preview: job.preview });
    } catch (e) {
      if (options.quiet) {
        setFlow(null);
        onToast({ message: e instanceof Error ? e.message : "Couldn't count that mail." });
      } else patch(mine, { stage: "confirm", error: e instanceof Error ? e.message : "Couldn't count that mail." });
    }
  };

  const execute = async (mine: number, request: MailBatchRequest, preview: MailBatchPreview) => {
    patch(mine, { stage: "run", job: null, error: "" });
    const verb = VERBS[request.action];
    try {
      const job = await follow(mine, await postJson<MailBatchJob>("/api/mail/batch", { kind: "execute", token: preview.token }));
      const result = job?.result;
      if (!result) return;
      const extra = [result.failed ? `${result.failed} failed` : "", result.skipped ? `${result.skipped} had already moved` : ""].filter(Boolean).join(", ");
      const message = `${result.stopped ? "Stopped: " : ""}${plural(result.done, "email")} ${verb.done}${extra ? ` (${extra})` : ""}`;
      onToast({ message, onUndo: result.undo ? () => void undo(result.undo!) : undefined });
      // Pages to open or failures are worth a look; otherwise the toast says it all.
      if (result.subscriptions?.some((s) => s.url || s.note !== "Unsubscribed") || result.failed) patch(mine, { stage: "done", result });
      else {
        setFlow(null);
        setShown(false);
      }
    } catch (e) {
      patch(mine, { stage: "done", error: e instanceof Error ? e.message : "Couldn't change that mail." });
      setShown(true);
    } finally {
      onChanged();
    }
  };

  /** Undo runs in the background with its progress in the toast. */
  const undo = async (token: string) => {
    try {
      let job = await postJson<MailBatchJob>("/api/mail/batch", { kind: "undo", token });
      while (!job.finished) {
        onToast({ message: job.total ? `Putting back ${job.done} of ${job.total}` : "Putting mail back", busy: true });
        await wait(400);
        job = await getJob(job.id);
      }
      if (job.error) throw new Error(job.error);
      const result = job.result!;
      onToast({
        message: result.failed ? `${plural(result.failed, "email")} couldn't be put back. Try Undo again.` : `${plural(result.done, "email")} put back`,
        onUndo: result.undo ? () => void undo(result.undo!) : undefined,
      });
    } catch (e) {
      onToast({ message: e instanceof Error ? e.message : "Couldn't put that mail back." });
    } finally {
      onChanged();
    }
  };

  const open = (request: MailBatchRequest, options: Options = {}) => {
    if (flow?.stage === "run") {
      setShown(true);
      return;
    }
    setShown(!options.quiet);
    void review({ ...request, inboxOnly: request.senders ? (request.inboxOnly ?? true) : false }, options);
  };
  const cancel = () => {
    turn.current++;
    setFlow(null);
    setShown(false);
  };
  const stop = () => {
    if (flow?.job && flow.stage === "run") void postJson("/api/mail/batch", { kind: "stop", job: flow.job.id }).catch(() => {});
  };
  /** Esc and the backdrop: a run keeps going in the corner, anything else is a Cancel. */
  const dismiss = () => (flow?.stage === "run" ? setShown(false) : cancel());

  const sheet = (
    <BatchSheet
      flow={shown ? flow : null}
      accounts={accounts}
      onDismiss={dismiss}
      onCancel={cancel}
      onConfirm={() => flow?.preview && void execute(turn.current, flow.request, flow.preview)}
      onChange={(change) => flow && void review({ ...flow.request, ...change }, flow.options)}
      onHide={() => setShown(false)}
      onStop={stop}
    />
  );
  const pill = <BatchPill flow={!shown && flow && (flow.stage === "run" || flow.stage === "done") ? flow : null} onOpen={() => setShown(true)} onClose={cancel} />;
  /** What's being worked on, for the buttons that started it (they show a spinner). */
  const working = flow && (flow.stage === "review" || flow.stage === "run") ? flow.request : null;
  return { open, sheet, pill, working };
}

const BUTTON = "flex h-10 min-w-0 items-center justify-center gap-2 rounded-full px-5 text-[13px] font-medium transition-[opacity,transform,background-color] duration-150 active:scale-[0.97] disabled:pointer-events-none";
const PLAIN = cn(BUTTON, "text-pane-muted hover:bg-pane-hover hover:text-pane-fg");
const OUTLINED = cn(BUTTON, "border border-pane-border hover:bg-pane-hover");

function titleOf(flow: Flow) {
  const { request, preview, stage, result } = flow;
  const verb = VERBS[request.action];
  if (stage === "done") return result ? "Finished with a few to check" : "That didn't go through";
  const emptying = request.action === "permanent" && !request.threads && !request.senders;
  if (stage === "run") return `${verb.running} ${preview ? plural(preview.count, "email") : ""}`.trim();
  if (emptying) return "Empty Trash";
  if (!preview) return verb.title;
  if (request.action === "trash") return `Move ${plural(preview.count, "email")} to Trash`;
  if (request.action === "permanent") return `Delete ${plural(preview.count, "email")} forever`;
  return `Archive ${plural(preview.count, "email")}`;
}

function lineOf(flow: Flow, senders: number) {
  const { request, stage } = flow;
  if (stage === "run") return "This keeps going if you hide it. Stop finishes the batch under way.";
  if (stage === "done") return "";
  const from = senders ? ` from ${plural(senders, "sender")}` : "";
  if (request.action === "permanent") return "They're gone for good: not even Undo brings them back. Only mail still in Trash is deleted.";
  if (request.action === "trash") return `Mail${from} goes to Trash, where you can restore it. Undo puts it all back.`;
  return `Mail${from} leaves your inbox. Undo puts it back.`;
}

function BatchSheet({
  flow,
  accounts,
  onDismiss,
  onCancel,
  onConfirm,
  onChange,
  onHide,
  onStop,
}: {
  flow: Flow | null;
  accounts: Account[];
  onDismiss: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onChange: (change: Partial<MailBatchRequest>) => void;
  onHide: () => void;
  onStop: () => void;
}) {
  // Keep the last flow while the dialog animates out.
  const [shown, setShown] = useState(flow);
  if (flow && flow !== shown) setShown(flow);
  const current = flow ?? shown;
  if (!current) return null;
  return <SheetBody open={!!flow} flow={current} accounts={accounts} onDismiss={onDismiss} onCancel={onCancel} onConfirm={onConfirm} onChange={onChange} onHide={onHide} onStop={onStop} />;
}

function SheetBody({
  open,
  flow,
  accounts,
  onDismiss,
  onCancel,
  onConfirm,
  onChange,
  onHide,
  onStop,
}: {
  open: boolean;
  flow: Flow;
  accounts: Account[];
  onDismiss: () => void;
  onCancel: () => void;
  onConfirm: () => void;
  onChange: (change: Partial<MailBatchRequest>) => void;
  onHide: () => void;
  onStop: () => void;
}) {
  const { request, options, stage, job, preview, result, error } = flow;
  const permanent = request.action === "permanent";
  const verb = VERBS[request.action];
  const senders = request.senders?.length ?? 0;
  const counting = stage === "review";
  const empty = stage === "confirm" && preview?.count === 0;
  const progress = job && job.total ? job.done / job.total : 0;
  const rows = preview?.accounts.map((a) => ({ ...a, account: accounts.find((x) => x.id === a.id) })) ?? [];
  const footer =
    stage === "run" ? (
      <>
        <button onClick={onStop} className={cn(PLAIN, "mr-auto")}>
          Stop
        </button>
        <button onClick={onHide} className={cn(BUTTON, "bg-pane-fg text-pane hover:opacity-90")}>
          Hide
        </button>
      </>
    ) : stage === "done" ? (
      <button onClick={onCancel} className={cn(BUTTON, "ml-auto bg-pane-fg text-pane hover:opacity-90")}>
        Done
      </button>
    ) : (
      <>
        <button onClick={onCancel} className={cn(PLAIN, "ml-auto")}>
          Cancel
        </button>
        <button
          disabled={counting || empty || !!error}
          onClick={onConfirm}
          className={cn(BUTTON, "disabled:opacity-50", permanent ? "bg-danger text-white hover:opacity-90" : "bg-pane-fg text-pane hover:opacity-90")}
        >
          {counting ? <Spinner size={14} /> : <Icon icon={verb.icon} size={15} />}
          {request.unsubscribe && !counting ? `Unsubscribe and ${verb.title.toLowerCase()}` : verb.title}
        </button>
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={onDismiss}
      title={titleOf(flow)}
      description={lineOf(flow, senders) || undefined}
      icon={
        <span className={cn("grid size-9 shrink-0 place-items-center rounded-full", stage === "done" ? "bg-warning/10 text-warning" : permanent ? "bg-danger/10 text-danger" : "bg-pane-2 text-pane-fg")}>
          <Icon icon={stage === "done" ? Alert02Icon : verb.icon} size={18} />
        </span>
      }
      className="w-[440px]"
      footer={footer}
    >
      <div className="px-5 pb-2">
        {request.senders && (stage === "review" || stage === "confirm") && request.action !== "archive" ? (
          <div className="mt-5 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <span className="text-[13px] font-medium">Which mail</span>
            <Segmented
              label="Which mail"
              value={request.inboxOnly ? "inbox" : "all"}
              onChange={(v) => onChange({ inboxOnly: v === "inbox" })}
              options={[
                { id: "inbox", label: "In your inbox" },
                { id: "all", label: "Everything they sent" },
              ]}
            />
          </div>
        ) : null}

        {options.unsubscribable && (stage === "review" || stage === "confirm") ? (
          <div className="mt-3 flex items-center gap-3 rounded-2xl bg-pane-2 px-3.5 py-3">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-medium">Unsubscribe too</span>
              <span className="block text-[12px] text-pane-muted">
                Asks {options.unsubscribable === 1 ? "them" : `${options.unsubscribable} senders`} to stop. This can&apos;t be taken back.
              </span>
            </span>
            <Switch value={!!request.unsubscribe} onChange={(v) => onChange({ unsubscribe: v })} label="Unsubscribe too" size="sm" />
          </div>
        ) : null}

        <div className="mt-3">
          {counting ? (
            <p className="flex items-center gap-2.5 text-[13px] text-pane-muted">
              <Spinner size={14} />
              {job?.total ? <span className="tabular-nums">Checking {job.done.toLocaleString()} of {job.total.toLocaleString()}</span> : "Counting emails"}
            </p>
          ) : stage === "run" ? (
            <div>
              <div className="h-1.5 overflow-hidden rounded-full bg-pane-2 shadow-[inset_0_0_0_1px_var(--pane-border)]">
                <motion.div className={cn("h-full rounded-full", permanent ? "bg-danger" : "bg-accent")} initial={false} animate={{ width: `${Math.max(progress, 0.02) * 100}%` }} transition={spring.moderate} />
              </div>
              <p className="mt-2 flex items-center gap-2 text-[12.5px] tabular-nums text-pane-muted">
                <Spinner size={12} />
                {job?.total ? `${job.done.toLocaleString()} of ${job.total.toLocaleString()}` : request.unsubscribe ? "Unsubscribing" : "Starting"}
              </p>
            </div>
          ) : stage === "done" ? (
            <DoneList result={result} error={error} />
          ) : empty ? (
            <p className="rounded-2xl bg-pane-2 px-3.5 py-3 text-[13px] text-pane-muted">Nothing matches: it&apos;s already gone, or somewhere else.</p>
          ) : rows.length > 1 || (rows.length === 1 && accounts.length > 1) ? (
            <ul className="overflow-hidden rounded-2xl bg-pane-2" data-sensitive>
              {rows.map((r) => (
                <li key={r.id} className="flex items-center gap-2.5 px-3.5 py-2.5 text-[13px] [&+&]:border-t [&+&]:border-pane-border">
                  {r.account ? <AccountFace account={r.account} marked={false} className="size-6" /> : null}
                  <span className="min-w-0 flex-1 truncate">{r.account ? accountName(r.account) : r.email}</span>
                  <span className="shrink-0 tabular-nums text-pane-muted">{r.count.toLocaleString()}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {error && stage === "confirm" ? (
            <p role="alert" className="mt-3 text-[12.5px] text-danger">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

function DoneList({ result, error }: { result: MailBatchResult | null; error: string }) {
  if (!result) return <p className="text-[13px] text-danger">{error}</p>;
  return (
    <ul className="overflow-hidden rounded-2xl bg-pane-2 text-[13px]" data-sensitive>
      {result.failed ? (
        <li className="flex items-center gap-2.5 px-3.5 py-2.5">
          <Icon icon={Alert02Icon} size={14} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{plural(result.failed, "email")} couldn&apos;t be changed. Try them again in a moment.</span>
        </li>
      ) : null}
      {result.subscriptions?.map((s) => (
        <li key={s.email} className="flex items-center gap-2.5 px-3.5 py-2.5 [&+&]:border-t [&+&]:border-pane-border">
          <Icon icon={s.note === "Unsubscribed" ? Tick02Icon : Alert02Icon} size={14} className={cn("shrink-0", s.note === "Unsubscribed" ? "text-success" : "text-warning")} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-medium">{s.email}</span>
            <span className="block truncate text-[12px] text-pane-muted">{s.note}</span>
          </span>
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer" className={cn(OUTLINED, "h-8 shrink-0 gap-1 px-3 text-[12px]")}>
              Open page
              <Icon icon={LinkSquare02Icon} size={12} />
            </a>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** A hidden run in the corner: its progress, a click brings the sheet back. */
function BatchPill({ flow, onOpen, onClose }: { flow: Flow | null; onOpen: () => void; onClose: () => void }) {
  const job = flow?.job;
  const progress = job && job.total ? job.done / job.total : 0;
  const r = 7;
  const around = 2 * Math.PI * r;
  return (
    <AnimatePresence>
      {flow ? (
        <motion.div key="batch-pill" {...blurFade({ y: 10, blur: 8 })} className="fixed bottom-5 right-5 z-40 max-sm:bottom-20 max-sm:right-1/2 max-sm:translate-x-1/2">
          <div className="ink-chrome flex items-center rounded-full border border-frame-border bg-frame/95 text-[13px] text-frame-fg shadow-[0_18px_40px_-14px_rgb(10_20_40/0.55)] backdrop-blur-xl">
            <button onClick={onOpen} className="flex items-center gap-2.5 rounded-full py-2 pl-3 pr-4 hover:bg-frame-hover">
              {flow.stage === "done" ? (
                <Icon icon={Alert02Icon} size={16} className="text-warning" />
              ) : (
                <svg width={18} height={18} viewBox="0 0 18 18" fill="none" aria-hidden className="-rotate-90 text-accent">
                  <circle cx={9} cy={9} r={r} stroke="currentColor" strokeWidth={2.5} opacity={0.25} />
                  <motion.circle cx={9} cy={9} r={r} stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeDasharray={around} initial={false} animate={{ strokeDashoffset: around * (1 - Math.max(progress, 0.04)) }} transition={spring.moderate} />
                </svg>
              )}
              <span className="whitespace-nowrap">
                {flow.stage === "done" ? "Finished: a few to check" : VERBS[flow.request.action].running}
                {flow.stage === "run" && job?.total ? <span className="ml-1.5 tabular-nums text-frame-muted">{job.done.toLocaleString()} of {job.total.toLocaleString()}</span> : null}
              </span>
            </button>
            {flow.stage === "done" ? (
              <button onClick={onClose} className="mr-1 rounded-full px-2.5 py-1.5 text-frame-muted hover:bg-frame-hover hover:text-frame-fg">
                Dismiss
              </button>
            ) : null}
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
