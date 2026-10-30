"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Alert02Icon, Archive02Icon, Delete02Icon, BrushCleaningIcon, Cancel01Icon, LinkSquare02Icon, MailRemove01Icon, ThumbsUpIcon, Tick02Icon, UserBlock01Icon, WorkflowSquare03Icon } from "@hugeicons/core-free-icons";
import { UNSUBSCRIBE_GRACE_DAYS, formatShare, perMonth, type SenderSummary } from "@/lib/mail/cleanup";
import { gmailFilterFor } from "@/lib/rules/gmail";
import type { Account } from "@/lib/mail/types";
import { blurFade, spring } from "@/lib/motion";
import { cn, formatListDate } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Avatar } from "./avatar";
import { CircleButton } from "./circle-button";
import { formatBytes, plural } from "@/lib/format";
import { type CleanupState, type Queue, type Run, nameOf } from "./use-cleanup";
import { SenderBadges } from "./cleanup-view";

// ---------------------------------------------------------------------------
// The right pane: the running queue, the ticked senders, or one sender
// ---------------------------------------------------------------------------

export function CleanupPane({ cleanup, live, accounts, onOpenRules }: { cleanup: CleanupState; live: boolean; accounts: Account[]; onOpenRules: () => void }) {
  const { queue, checked, senders } = cleanup;
  if (queue && queue.items.length > 1) return <QueuePanel cleanup={cleanup} queue={queue} />;
  const ticked = checked.flatMap((e) => senders.filter((s) => s.email === e));
  if (ticked.length) return <BulkPanel key={ticked.length > 1 ? "many" : ticked[0].email} cleanup={cleanup} senders={ticked} />;
  const sender = live ? senders.find((s) => s.email === cleanup.selected) ?? null : null;
  return <CleanupDetail key={sender?.email ?? "none"} cleanup={cleanup} sender={sender} accounts={accounts} onOpenRules={onOpenRules} />;
}

function CleanupDetail({
  cleanup,
  sender,
  accounts,
  onOpenRules,
}: {
  cleanup: CleanupState;
  sender: SenderSummary | null;
  accounts: Account[];
  onOpenRules: () => void;
}) {
  // Rendered with key={sender.email}, so these reset per sender.
  const [confirmBlock, setConfirmBlock] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [gmail, setGmail] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!sender) {
    return (
      <section className="grid h-full place-items-center bg-pane text-pane-muted">
        <div className="blur-fade max-w-xs px-6 text-center">
          <Icon icon={BrushCleaningIcon} size={28} className="mx-auto mb-3 opacity-50" />
          <p className="text-[13px]">Pick a sender to see how much they send and clear them out. Tick several to clean up in one go.</p>
        </div>
      </section>
    );
  }

  const { detail, queue, now } = cleanup;
  const running = queue && !queue.finished ? queue.run : null;
  const name = nameOf(sender);
  const stillSending = sender.sinceUnsubscribe > 0 && sender.status !== "blocked";
  const gmailAccounts = accounts.filter((a) => a.provider === "gmail" && sender.accountIds.includes(a.id));
  const gmailCheck = gmailFilterFor({ query: `from:${sender.email}`, conditions: [], actions: [{ verb: "archive" }], stop: false });
  const gmailOk = gmailCheck.ok;
  const stats = [
    { label: "Emails", value: sender.emails },
    { label: "In your inbox", value: sender.inInbox },
    { label: "Per month", value: perMonth(sender, now).toFixed(1) },
    { label: "Unread", value: formatShare(sender.unread, sender.emails) },
    { label: "Archived unread", value: formatShare(sender.archivedUnread, sender.emails) },
    { label: "Last read", value: sender.lastRead ? formatListDate(sender.lastRead) : "Never" },
  ];
  const unsubscribe = sender.canUnsubscribe && !sender.unsubscribedAt;

  const confirmPanel = (key: string, text: React.ReactNode, action: string, onConfirm: () => void, onCancel: () => void, extra?: React.ReactNode, saving = false) => (
    <motion.div key={key} {...blurFade({ y: 4 })} className="mt-3 rounded-2xl border border-pane-border bg-pane-2 p-3.5 text-[12.5px]">
      <p className="text-pane-fg/85">{text}</p>
      {extra}
      <div className="mt-3 flex gap-2">
        <button
          disabled={saving}
          onClick={onConfirm}
          className="flex h-8 items-center gap-2 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {saving ? <Spinner size={13} /> : null}
          {action}
        </button>
        <button onClick={onCancel} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted transition-colors duration-150 hover:text-pane-fg">
          Cancel
        </button>
      </div>
    </motion.div>
  );

  return (
    <section className="flex h-full flex-col overflow-y-auto bg-pane text-pane-fg scroll-fade">
      <div key={sender.email} className="@container blur-fade-up mx-auto w-full max-w-[600px] px-5 pb-10 pt-6 sm:px-8">
        <header className="flex items-start gap-3.5">
          <span data-sensitive className="shrink-0">
            <Avatar name={name} email={sender.email} className="size-12 text-[15px]" />
          </span>
          <div className="min-w-0 flex-1 pt-0.5" data-sensitive>
            <h2 className="flex min-w-0 items-center gap-2 text-[19px] font-semibold leading-tight tracking-tight">
              <span className="min-w-0 truncate">{name}</span>
              <SenderBadges sender={sender} />
            </h2>
            <p className="mt-0.5 truncate text-[12.5px] text-pane-muted">
              {sender.email !== name ? `${sender.email} · ` : ""}since {formatListDate(sender.firstDate)}
              {sender.fileBytes ? ` · ${formatBytes(sender.fileBytes)} of files` : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <CircleButton
              icon={ThumbsUpIcon}
              label={sender.keptAt ? "Kept: show in Cleanup again" : "Keep: stop suggesting them"}
              active={!!sender.keptAt}
              onClick={() => {
                if (!running) cleanup.keep([sender.email], !sender.keptAt);
              }}
            />
          </div>
        </header>

        <div className="mt-5">
          <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-2xl bg-pane-border shadow-[0_0_0_1px_var(--pane-border)] @[22rem]:grid-cols-3">
            {stats.map((stat) => (
              <div key={stat.label} className="flex min-w-0 flex-col-reverse bg-pane-2 px-3.5 py-2.5">
                <dt className="truncate text-[11.5px] text-pane-muted">{stat.label}</dt>
                <dd className="truncate text-[17px] font-semibold tabular-nums tracking-tight">{stat.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <ActionGroup title="Their emails">
          <div className="grid grid-cols-1 gap-2 @[26rem]:grid-cols-2">
            <ActionTile
              icon={Archive02Icon}
              title={sender.inInbox ? `Archive ${plural(sender.inInbox, "email")}` : "Inbox is clear"}
              detail={sender.inInbox ? "Out of your inbox, kept in All mail" : "Nothing of theirs is in your inbox"}
              busy={cleanup.working("archive", [sender.email])}
              disabled={!sender.inInbox || !!running}
              onClick={() => cleanup.archiveMail([sender.email])}
            />
            <ActionTile
              icon={Delete02Icon}
              title="Move to Trash"
              detail="Pick inbox or everything next; restore any time"
              busy={cleanup.working("trash", [sender.email])}
              disabled={!!running}
              onClick={() => cleanup.deleteMail([sender.email])}
            />
          </div>
        </ActionGroup>

        <ActionGroup title="From now on">
          <ul className="overflow-hidden rounded-2xl border border-pane-border">
            {sender.canUnsubscribe || sender.unsubscribedAt ? (
              <ChoiceRow
                icon={MailRemove01Icon}
                title="Unsubscribe"
                detail={sender.unsubscribedAt ? `You unsubscribed on ${formatListDate(sender.unsubscribedAt)}` : "Ask them to stop sending"}
              >
                {unsubscribe ? (
                  <RowButton busy={running === "unsubscribe"} disabled={!!running} onClick={() => void cleanup.run("unsubscribe", [sender.email])}>
                    Unsubscribe
                  </RowButton>
                ) : (
                  <Done>Done</Done>
                )}
              </ChoiceRow>
            ) : null}
            <ChoiceRow
              icon={WorkflowSquare03Icon}
              title="Skip the inbox"
              detail={
                detail?.archiveRule
                  ? `Automation “${detail.archiveRule.name}”${detail.archiveRule.enabled ? "" : " (paused)"}`
                  : "New mail from them goes straight to All mail"
              }
            >
              {detail?.archiveRule ? (
                <RowButton onClick={onOpenRules}>Edit</RowButton>
              ) : (
                <RowButton disabled={ruleOpen} onClick={() => setRuleOpen(true)}>
                  Set up
                </RowButton>
              )}
            </ChoiceRow>
            <ChoiceRow icon={UserBlock01Icon} title="Block" detail="Everything they send is archived, now and as it arrives">
              {sender.status === "blocked" ? (
                <Done>Blocked</Done>
              ) : (
                <RowButton busy={running === "block"} disabled={!!running || confirmBlock} onClick={() => setConfirmBlock(true)}>
                  Block
                </RowButton>
              )}
            </ChoiceRow>
          </ul>

          <AnimatePresence mode="popLayout" initial={false}>
            {confirmBlock
              ? confirmPanel(
                  "block",
                  <>Block {name}? Everything they&apos;ve sent leaves your inbox, and future mail is archived as it arrives.</>,
                  "Block sender",
                  () => {
                    setConfirmBlock(false);
                    void cleanup.run("block", [sender.email]);
                  },
                  () => setConfirmBlock(false),
                )
              : ruleOpen && !detail?.archiveRule
                ? confirmPanel(
                    "rule",
                    <>New mail from {name} skips your inbox. Kite adds an automation you can change or remove in Automations.</>,
                    "Add automation",
                    () => {
                      setSaving(true);
                      void cleanup.archiveFuture(sender, gmail && gmailOk && gmailAccounts.length > 0).finally(() => {
                        setSaving(false);
                        setRuleOpen(false);
                      });
                    },
                    () => setRuleOpen(false),
                    gmailAccounts.length ? (
                      <div className="mt-3 flex items-center gap-3">
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">Also run in Gmail</span>
                          <span className="block text-pane-muted">{gmailCheck.ok ? "A Gmail filter archives their mail even while Kite is closed." : gmailCheck.reason}</span>
                        </span>
                        <Switch value={gmail && gmailOk} onChange={setGmail} disabled={!gmailOk} label="Also run in Gmail" size="sm" />
                      </div>
                    ) : null,
                    saving,
                  )
                : null}
          </AnimatePresence>

          {stillSending ? (
            <div className="mt-3 flex items-start gap-2.5 rounded-2xl bg-warning/10 px-3.5 py-3 text-[12.5px]">
              <Icon icon={Alert02Icon} size={15} className="mt-px shrink-0 text-warning" />
              <p className="min-w-0 flex-1 text-pane-fg/85">
                <span className="font-medium text-pane-fg">Still sending.</span> {plural(sender.sinceUnsubscribe, "email")} arrived more than {UNSUBSCRIBE_GRACE_DAYS} days
                after you unsubscribed. Blocking them stops it.
              </p>
            </div>
          ) : null}
        </ActionGroup>
        {detail?.recent.length ? (
          <section className="mt-7" data-sensitive>
            <h3 className="pb-1.5 text-[11px] font-medium uppercase tracking-wider text-pane-muted">Recent</h3>
            <FluidList tone="pane" role="list" className="-mx-2">
              {detail.recent.map((m, i) => (
                <li
                  key={i}
                  {...FLUID_ITEM}
                  style={{ "--i": i } as React.CSSProperties}
                  className="blur-fade-up relative flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[13px] transition-[background-color] duration-150"
                >
                  <span className={cn("size-1.5 shrink-0 rounded-full", m.unread ? "bg-accent" : "bg-transparent")} />
                  <span className={cn("min-w-0 flex-1 truncate", m.unread ? "font-medium" : "text-pane-fg/75")}>{m.subject}</span>
                  {m.inInbox ? <span className="shrink-0 text-[11px] text-pane-muted">Inbox</span> : null}
                  <span className="w-14 shrink-0 text-right text-[11.5px] tabular-nums text-pane-muted">{formatListDate(m.date)}</span>
                </li>
              ))}
            </FluidList>
          </section>
        ) : null}
      </div>
    </section>
  );
}

/** A heading over one kind of choice: what's here now, or what happens from now on. */
function ActionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-6">
      <h3 className="pb-2 text-[11px] font-medium uppercase tracking-wider text-pane-muted">{title}</h3>
      {children}
    </section>
  );
}

/** A big choice for mail that's already here: icon, what it does, and one line on what that means. */
function ActionTile({ icon, title, detail, busy, disabled, onClick }: { icon: IconData; title: string; detail: string; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={cn(
        "flex min-w-0 items-center gap-3 rounded-2xl border border-pane-border p-3 text-left transition-[opacity,transform,background-color] duration-150 hover:bg-pane-hover active:scale-[0.98] disabled:pointer-events-none touch:p-3.5",
        disabled && !busy && "opacity-50",
      )}
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-pane-2">{busy ? <Spinner size={16} /> : <Icon icon={icon} size={18} />}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium leading-snug">{title}</span>
        <span className="block text-[12px] leading-snug text-pane-muted">{detail}</span>
      </span>
    </button>
  );
}

/** One row of "From now on": what it is on the left, its button on the right. */
function ChoiceRow({ icon, title, detail, children }: { icon: IconData; title: string; detail: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center gap-3 px-3.5 py-3 [&+&]:border-t [&+&]:border-pane-border">
      <Icon icon={icon} size={18} className="shrink-0 text-pane-muted" />
      <span className="min-w-0 flex-1">
        <span className="block text-[13.5px] font-medium leading-snug">{title}</span>
        <span className="block text-[12px] leading-snug text-pane-muted">{detail}</span>
      </span>
      {children}
    </li>
  );
}

function RowButton({ children, busy, disabled, onClick }: { children: React.ReactNode; busy?: boolean; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      disabled={busy || disabled}
      aria-busy={busy || undefined}
      className={cn(
        "flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-[opacity,transform,background-color] duration-150 hover:bg-pane-hover active:scale-[0.97] disabled:pointer-events-none touch:h-10",
        disabled && !busy && "opacity-50",
      )}
    >
      {busy ? <Spinner size={13} /> : null}
      {children}
    </button>
  );
}

/** A choice already made, where its button would be. */
function Done({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex shrink-0 items-center gap-1 px-1 text-[12.5px] font-medium text-success">
      <Icon icon={Tick02Icon} size={14} />
      {children}
    </span>
  );
}

/** Several ticked senders: one confirm for anything that can't be taken back, then the queue. */
function BulkPanel({ cleanup, senders }: { cleanup: CleanupState; senders: SenderSummary[] }) {
  const [confirm, setConfirm] = useState<"block" | null>(null);
  const emails = senders.map((s) => s.email);
  const inInbox = senders.reduce((n, s) => n + s.inInbox, 0);
  const total = senders.reduce((n, s) => n + s.emails, 0);
  const canUnsubscribe = senders.filter((s) => s.canUnsubscribe && !s.unsubscribedAt).length;
  const faces = senders.slice(0, 5);
  const shown = senders.slice(0, 6);

  return (
    <section className="grid h-full place-items-center overflow-y-auto bg-pane p-6 text-pane-fg sm:p-8">
      <div className="w-full max-w-sm">
        <div className="blur-fade-up flex justify-center" style={{ "--i": 0 } as React.CSSProperties} data-sensitive>
          {faces.map((s, i) => (
            <span key={s.email} className={cn("flex rounded-full bg-pane ring-4 ring-pane", i > 0 && "-ml-3")}>
              <Avatar name={nameOf(s)} email={s.email} className="size-10" />
            </span>
          ))}
        </div>
        <h2 className="blur-fade-up mt-4 text-center text-[17px] font-semibold tracking-tight" style={{ "--i": 1 } as React.CSSProperties}>
          {plural(senders.length, "sender")} selected
        </h2>
        <p className="blur-fade-up mt-1 text-center text-[12.5px] text-pane-muted" style={{ "--i": 1 } as React.CSSProperties}>
          {plural(total, "email")} · {inInbox} in your inbox · {canUnsubscribe} can unsubscribe
        </p>

        <ul className="blur-fade-up mt-4 overflow-hidden rounded-xl border border-pane-border" style={{ "--i": 2 } as React.CSSProperties} data-sensitive>
          {shown.map((s) => (
            <li key={s.email} className="flex items-baseline gap-2 border-b border-pane-border px-3 py-2 text-[12.5px] last:border-b-0">
              <span className="min-w-0 flex-1 truncate font-medium">{nameOf(s)}</span>
              <span className="shrink-0 tabular-nums text-pane-muted">{s.inInbox} in inbox</span>
            </li>
          ))}
          {senders.length > shown.length ? <li className="px-3 py-2 text-[12px] text-pane-muted">and {senders.length - shown.length} more</li> : null}
        </ul>

        <div className="@container blur-fade-up" style={{ "--i": 3 } as React.CSSProperties}>
          <ActionGroup title="Their emails">
            <div className="grid grid-cols-1 gap-2">
              <ActionTile
                icon={Archive02Icon}
                title={inInbox ? `Archive ${plural(inInbox, "email")}` : "Inbox is clear"}
                detail={inInbox ? "Out of your inbox, kept in All mail" : "Nothing of theirs is in your inbox"}
                busy={cleanup.working("archive", emails)}
                disabled={!inInbox}
                onClick={() => cleanup.archiveMail(emails)}
              />
              <ActionTile
                icon={Delete02Icon}
                title="Move to Trash"
                detail="Pick inbox or everything next; restore any time"
                busy={cleanup.working("trash", emails)}
                onClick={() => cleanup.deleteMail(emails)}
              />
            </div>
          </ActionGroup>

          <ActionGroup title="From now on">
            <ul className="overflow-hidden rounded-2xl border border-pane-border">
              {canUnsubscribe ? (
                <ChoiceRow icon={MailRemove01Icon} title="Unsubscribe" detail={`Ask ${plural(canUnsubscribe, "sender")} to stop`}>
                  <RowButton onClick={() => void cleanup.run("unsubscribe", emails)}>Unsubscribe</RowButton>
                </ChoiceRow>
              ) : null}
              <ChoiceRow icon={UserBlock01Icon} title="Block" detail="Their mail is archived, now and as it arrives">
                <RowButton disabled={!!confirm} onClick={() => setConfirm("block")}>
                  Block
                </RowButton>
              </ChoiceRow>
              <ChoiceRow icon={ThumbsUpIcon} title="Keep" detail="Stop suggesting them in Cleanup">
                <RowButton onClick={() => cleanup.keep(emails, true)}>Keep</RowButton>
              </ChoiceRow>
            </ul>
            <AnimatePresence mode="popLayout" initial={false}>
              {confirm ? (
                <motion.div key={confirm} {...blurFade({ y: 4 })} className="mt-3 rounded-2xl border border-pane-border bg-pane-2 p-3.5 text-[12.5px]">
                  <p className="text-pane-fg/85">
                    Block {plural(senders.length, "sender")}? Their {plural(inInbox, "email")} leave your inbox, and future mail is archived as it arrives.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button
                      onClick={() => {
                        setConfirm(null);
                        void cleanup.run("block", emails);
                      }}
                      className="h-8 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane transition-opacity duration-150 hover:opacity-90"
                    >
                      Block senders
                    </button>
                    <button onClick={() => setConfirm(null)} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted transition-colors duration-150 hover:text-pane-fg">
                      Cancel
                    </button>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </ActionGroup>
        </div>

        <button
          onClick={() => cleanup.setChecked([])}
          className="blur-fade-up mx-auto mt-4 flex items-center gap-1.5 text-[12px] text-pane-muted hover:text-pane-fg"
          style={{ "--i": 4 } as React.CSSProperties}
        >
          Clear selection
        </button>
      </div>
    </section>
  );
}

const RUN_TITLES: Record<Run, [string, string]> = {
  unsubscribe: ["Unsubscribing", "Unsubscribed"],
  block: ["Blocking", "Blocked"],
};

/** The queue at work: one sender at a time, each with what happened; unsubscribe pages to finish are links. */
function QueuePanel({ cleanup, queue }: { cleanup: CleanupState; queue: Queue }) {
  const settled = queue.items.filter((i) => i.state !== "waiting" && i.state !== "running").length;
  const pages = queue.items.filter((i) => i.url);
  return (
    <section className="flex h-full flex-col overflow-y-auto bg-pane text-pane-fg scroll-fade">
      <div className="mx-auto w-full max-w-[480px] px-6 pb-10 pt-10 sm:px-8">
        <h2 className="text-[17px] font-semibold tracking-tight">
          {queue.finished ? RUN_TITLES[queue.run][1] : RUN_TITLES[queue.run][0]} · {settled} of {queue.items.length}
        </h2>
        <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-pane-2 shadow-[inset_0_0_0_1px_var(--pane-border)]">
          <motion.div className="h-full rounded-full bg-accent" initial={false} animate={{ width: `${(settled / queue.items.length) * 100}%` }} transition={spring.moderate} />
        </div>
        {pages.length && queue.finished ? (
          <p className="mt-4 text-[12.5px] text-pane-muted">
            {plural(pages.length, "sender")} {pages.length === 1 ? "takes" : "take"} unsubscribes only on their own page. Open each to finish; Kite doesn&apos;t visit them for you.
          </p>
        ) : null}
        <ul className="mt-4 overflow-hidden rounded-xl border border-pane-border" data-sensitive>
          {queue.items.map((item) => (
            <li key={item.email} className="flex items-center gap-2.5 border-b border-pane-border px-3 py-2.5 text-[12.5px] last:border-b-0">
              <span className="grid size-4 shrink-0 place-items-center text-pane-muted">
                {item.state === "running" ? (
                  <Spinner size={14} />
                ) : item.state === "done" ? (
                  <Icon icon={Tick02Icon} size={15} className="text-success" />
                ) : item.state === "failed" ? (
                  <Icon icon={Alert02Icon} size={14} className="text-warning" />
                ) : item.state === "skipped" ? (
                  <Icon icon={Cancel01Icon} size={13} />
                ) : (
                  <span className="size-1.5 rounded-full bg-pane-muted/50" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.name}</span>
                {item.note ? <span className="block truncate text-pane-muted">{item.note}</span> : null}
              </span>
              {item.url ? (
                <a
                  href={item.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex shrink-0 items-center gap-1 rounded-full border border-pane-border px-2.5 py-1 text-[12px] font-medium hover:bg-pane-hover"
                >
                  Open page
                  <Icon icon={LinkSquare02Icon} size={12} />
                </a>
              ) : null}
            </li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end">
          {queue.finished ? (
            <button onClick={cleanup.closeQueue} className="h-9 rounded-full bg-pane-fg px-5 text-[13px] font-medium text-pane hover:opacity-90">
              Done
            </button>
          ) : (
            <button onClick={cleanup.stopQueue} className="h-9 rounded-full border border-pane-border px-5 text-[13px] font-medium hover:bg-pane-hover">
              Stop after this one
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
