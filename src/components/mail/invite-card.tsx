"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Calendar03Icon, CalendarRemove01Icon, Location01Icon, RepeatIcon, UserGroupIcon, Video01Icon } from "@hugeicons/core-free-icons";
import { format, isSameDay } from "date-fns";
import { RESPONSE_LABEL, RESPONSES, STATUS_WORD, yourAnswer, type Invite, type InviteResponse } from "@/lib/calendar/invite";
import { calendarName, permissionHref } from "@/lib/mail/providers";
import type { Account } from "@/lib/mail/types";
import { blurFade, springSnappy } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";

// The card at the top of a message that carries a meeting invite (lib/calendar/invite.ts): when,
// where, who, the call link, and Yes / Maybe / No. Answering is the user's click only; it goes to
// the account's calendar (Google Calendar, Outlook) or, for IMAP, as an email to the organiser.

/** All-day dates are stored as UTC midnight: read them back as calendar days. */
function dayOf(iso: string) {
  const d = new Date(iso);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function describeWhen(invite: Pick<Invite, "start" | "end" | "allDay">) {
  if (invite.allDay) {
    const start = dayOf(invite.start);
    // DTEND of an all-day event is the day after the last one.
    const last = invite.end ? new Date(dayOf(invite.end).getTime() - 86400000) : start;
    return last > start ? `${format(start, "EEE d MMM")} – ${format(last, "EEE d MMM")} · All day` : `${format(start, "EEE d MMM yyyy")} · All day`;
  }
  const start = new Date(invite.start);
  const end = invite.end ? new Date(invite.end) : null;
  if (!end) return `${format(start, "EEE d MMM yyyy")} · ${format(start, "HH:mm")}`;
  if (isSameDay(start, end)) return `${format(start, "EEE d MMM yyyy")} · ${format(start, "HH:mm")}–${format(end, "HH:mm")}`;
  return `${format(start, "EEE d MMM, HH:mm")} – ${format(end, "EEE d MMM, HH:mm")}`;
}

/** "15:00 in London" when the organiser's zone (IANA) differs from yours at that moment. */
function theirTime(invite: Invite) {
  if (invite.allDay || !invite.timeZone) return null;
  try {
    const at = new Date(invite.start);
    const theirs = new Intl.DateTimeFormat("en-GB", { timeZone: invite.timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
    if (theirs === format(at, "HH:mm")) return null;
    return `${theirs} in ${invite.timeZone.split("/").pop()!.replace(/_/g, " ")}`;
  } catch {
    return null;
  }
}

/** Other guests (not the organiser, not you) with how many said yes or no. */
function guestLine(invite: Invite, me?: string) {
  const skip = new Set([invite.organizer?.email.toLowerCase(), me?.toLowerCase()]);
  const people = invite.attendees.filter((a) => !skip.has(a.email.toLowerCase()));
  if (!people.length) return null;
  const yes = people.filter((a) => a.status === "accepted").length;
  const no = people.filter((a) => a.status === "declined").length;
  const counts = [yes ? `${yes} yes` : null, no ? `${no} no` : null].filter(Boolean).join(", ");
  const names = people.slice(0, 3).map((a) => a.name.split(" ")[0]);
  const more = people.length > 3 ? ` and ${people.length - 3} more` : "";
  return `${names.join(", ")}${more}${counts ? ` · ${counts}` : ""}`;
}

function heading(invite: Invite, superseded: boolean) {
  if (invite.cancelled) return "Cancelled";
  if (invite.method === "REPLY") {
    const who = invite.attendees[0];
    return who ? `${who.name} ${STATUS_WORD[who.status]}` : "An answer to your invite";
  }
  if (invite.later) return invite.later.cancelled ? "Cancelled in a later email" : "Changed in a later email";
  if (superseded) return "Changed later in this conversation";
  if (invite.method === "REQUEST") return invite.sequence > 0 ? "Updated invitation" : "Invitation";
  return "Event";
}

/** What an invite says, without answering (the card's body; also the .ics preview). */
export function InviteSummary({ invite, me, superseded = false, children }: { invite: Invite; me?: string; superseded?: boolean; children?: React.ReactNode }) {
  const other = theirTime(invite);
  const guests = guestLine(invite, me);
  return (
    <div data-sensitive className={cn("rounded-xl border border-pane-border bg-pane-2/60 px-4 py-3.5", (invite.cancelled || superseded) && "opacity-80")}>
      <div className="flex min-w-0 items-center gap-2 text-[12px] font-medium text-pane-muted">
        <Icon icon={invite.cancelled ? CalendarRemove01Icon : Calendar03Icon} size={14} className={cn("shrink-0", !invite.cancelled && !superseded && "text-accent")} />
        <span className="truncate">{heading(invite, superseded)}</span>
      </div>
      <p className={cn("mt-1.5 text-[15px] font-semibold leading-snug", invite.cancelled && "line-through decoration-pane-muted/60")}>{invite.summary}</p>
      <p className="mt-0.5 text-[13px] tabular-nums text-pane-fg/85">
        {describeWhen(invite)}
        {other ? <span className="text-pane-muted"> ({other})</span> : null}
      </p>
      <div className="mt-2 flex min-w-0 flex-col gap-1 text-[12.5px] text-pane-muted">
        {invite.recurrence ? <Line icon={RepeatIcon}>{invite.recurrence}</Line> : null}
        {invite.location ? <Line icon={Location01Icon}>{invite.location}</Line> : null}
        {invite.organizer || guests ? (
          <Line icon={UserGroupIcon}>
            {invite.organizer ? `From ${invite.organizer.name}` : null}
            {invite.organizer && guests ? " · " : null}
            {guests}
          </Line>
        ) : null}
      </div>
      {invite.join && !invite.cancelled ? (
        <a
          href={invite.join}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-3 inline-flex h-8 max-w-full items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors duration-150 hover:bg-pane-hover hover:transition-none"
        >
          <Icon icon={Video01Icon} size={14} className="shrink-0" />
          <span className="truncate">Join {callName(invite.join)}</span>
        </a>
      ) : null}
      {children}
    </div>
  );
}

function callName(url: string) {
  if (url.includes("meet.google.com")) return "Google Meet";
  if (url.includes("teams.")) return "Teams";
  if (url.includes("zoom.us")) return "Zoom";
  if (url.includes("webex.com")) return "Webex";
  return "call";
}

function Line({ icon, children }: { icon: Parameters<typeof Icon>[0]["icon"]; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-start gap-1.5">
      <Icon icon={icon} size={13} className="mt-[2px] shrink-0" />
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

type Problem = { message: string; code?: "calendar_permission" | "not_in_calendar"; response: InviteResponse };

export function InviteCard({
  invite: initial,
  account,
  threadKey,
  messageId,
  superseded,
  demo,
}: {
  invite: Invite;
  account?: Account;
  threadKey: string;
  messageId: string;
  /** A later message in the conversation changed or cancelled this event: no answering here. */
  superseded: boolean;
  /** Demo mail: answers stay in this window. */
  demo: boolean;
}) {
  const [invite, setInvite] = useState(initial);
  const [sending, setSending] = useState<InviteResponse | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
  const answer = yourAnswer(invite);
  // Your own invite (you're the organiser) has nothing to answer.
  const mine = !!account && invite.organizer?.email.toLowerCase() === account.email.toLowerCase();
  const answerable = invite.method === "REQUEST" && !invite.cancelled && !invite.later && !superseded && !mine;

  const respond = async (response: InviteResponse, byEmail = false) => {
    if (sending) return;
    setProblem(null);
    if (demo || !account) {
      setInvite((i) => ({ ...i, replied: { response, at: new Date().toISOString(), via: "calendar", ...(note.trim() ? { note: note.trim() } : {}) } }));
      setNoteOpen(false);
      return;
    }
    setSending(response);
    try {
      const res = await fetch("/api/mail/invite", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ account: account.id, thread: threadKey, message: messageId, response, note: note.trim() || undefined, byEmail }),
      });
      const data = (await res.json().catch(() => ({}))) as { invite?: Invite; error?: string; code?: Problem["code"] };
      if (!res.ok || !data.invite) {
        const message = data.error === "reconnect" ? "Reconnect this account in Settings, then try again." : (data.error ?? "Kite couldn't send your answer.");
        setProblem({ message, code: data.code, response });
        return;
      }
      setInvite(data.invite);
      setNote("");
      setNoteOpen(false);
    } catch {
      setProblem({ message: "Kite couldn't reach the server. Try again.", response });
    } finally {
      setSending(null);
    }
  };

  const connect = async () => {
    // Asks for calendar permission at the next sign-in, then signs in again.
    await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ calendar: true }) }).catch(() => {});
    if (account) window.location.href = permissionHref(account);
  };

  return (
    <div className="mt-3">
      <InviteSummary invite={invite} me={account?.email} superseded={superseded || !!invite.later}>
        {answerable ? (
          <div className="mt-3.5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-pane-border pt-3">
            <span className="text-[12.5px] font-medium">Going?</span>
            <FluidList axis="x" tone="pill" className="flex items-center rounded-full bg-pane p-[2px] shadow-[inset_0_0_0_1px_var(--pane-border)]">
              {RESPONSES.map((r) => (
                <button
                  key={r}
                  {...FLUID_ITEM}
                  disabled={!!sending}
                  onClick={() => void respond(r)}
                  className={cn(
                    "relative h-7 rounded-full px-3.5 text-[12.5px] transition-[color,background-color,font-weight,opacity] duration-150",
                    (sending ?? answer) === r ? "font-semibold text-pane-fg" : "font-medium text-pane-muted data-[lit]:text-pane-fg",
                    sending === r && "opacity-60",
                  )}
                >
                  {(sending ?? answer) === r ? (
                    <motion.span
                      layoutId={`invite-${messageId}`}
                      transition={springSnappy}
                      className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
                    />
                  ) : null}
                  <span className="relative">{RESPONSE_LABEL[r]}</span>
                </button>
              ))}
            </FluidList>
            {!noteOpen ? (
              <button onClick={() => setNoteOpen(true)} className="text-[12px] text-pane-muted transition-colors duration-150 hover:text-pane-fg">
                Add a note
              </button>
            ) : null}
            <span className="ml-auto text-[12px] text-pane-muted">{status(invite, calendarName(account))}</span>
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {answerable && noteOpen ? (
            <motion.input
              key="note"
              {...blurFade({ y: -4 })}
              autoFocus
              value={note}
              onChange={(e) => setNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNoteOpen(false);
              }}
              maxLength={2000}
              placeholder="A note for the organiser, sent with your answer"
              className="mt-2.5 h-8 w-full rounded-full border border-pane-border bg-pane px-3.5 text-[12.5px] outline-none placeholder:text-pane-muted focus:border-accent/60"
            />
          ) : null}
          {problem ? (
            <motion.div key="problem" {...blurFade({ y: -4 })} className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg bg-pane px-3 py-2 text-[12px]">
              <span className="mr-auto min-w-0 text-pane-muted">{problem.message}</span>
              {problem.code === "calendar_permission" && account ? (
                <SmallButton primary onClick={() => void connect()}>
                  Connect {calendarName(account)?.replace(/^your /, "")}
                </SmallButton>
              ) : null}
              {problem.code && (account?.provider === "gmail" || account?.googleLink !== undefined) ? (
                <SmallButton onClick={() => void respond(problem.response, true)}>Answer by email instead</SmallButton>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </InviteSummary>
    </div>
  );
}

function status(invite: Invite, calendar: string | null) {
  if (invite.replied) {
    const at = format(new Date(invite.replied.at), "HH:mm");
    if (invite.replied.via === "calendar" && calendar) return `Answered in ${calendar} at ${at}`;
    return `Emailed ${invite.organizer?.name.split(" ")[0] ?? "the organiser"} at ${at}`;
  }
  return null;
}

function SmallButton({ children, primary, onClick }: { children: React.ReactNode; primary?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-7 rounded-full px-3 text-[12px] font-medium transition-opacity hover:opacity-90",
        primary ? "bg-pane-fg text-pane" : "border border-pane-border hover:bg-pane-hover",
      )}
    >
      {children}
    </button>
  );
}
