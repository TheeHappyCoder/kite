"use client";

import { useState } from "react";
import { AlarmClockIcon, FileEditIcon, TimeScheduleIcon, UserCheck01Icon, NotificationOff02Icon } from "@hugeicons/core-free-icons";
import { differenceInCalendarDays, format } from "date-fns";
import { type Thread } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";

export function ThreadBanner({
  thread,
  onScheduled,
  onSender,
  onDraft,
  onUnmute,
}: {
  thread: Thread;
  onScheduled: (action: "send-now" | "edit") => void;
  onSender: (action: "allow" | "block") => void;
  onDraft: (action: "edit" | "discard") => void;
  onUnmute: () => void;
}) {
  const sender = thread.messages.find((m) => m.from.name !== "You")?.from;
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const hasDraft = thread.messages.some((m) => m.draft) || (thread.mailbox === "drafts" && !!thread.remoteId);
  let content: React.ReactNode = null;
  if (thread.scheduled) {
    content = (
      <>
        <Icon icon={TimeScheduleIcon} size={17} className="shrink-0 text-accent" />
        <span className="flex-1">
          Sends {format(new Date(thread.scheduled.sendAt), "EEEE d MMM 'at' HH:mm")}
          {thread.scheduled.remindDays ? `, then nudges you if no reply in ${thread.scheduled.remindDays}d` : ""}
        </span>
        <BannerButton onClick={() => onScheduled("edit")}>Cancel & edit</BannerButton>
        <BannerButton primary onClick={() => onScheduled("send-now")}>Send now</BannerButton>
      </>
    );
  } else if (hasDraft) {
    content = confirmDiscard ? (
      <>
        <Icon icon={FileEditIcon} size={17} className="shrink-0 text-accent" />
        <span className="flex-1">Discard this draft? It&apos;s removed from Gmail too.</span>
        <BannerButton onClick={() => setConfirmDiscard(false)}>Keep</BannerButton>
        <BannerButton
          primary
          onClick={() => {
            setConfirmDiscard(false);
            onDraft("discard");
          }}
        >
          Discard
        </BannerButton>
      </>
    ) : (
      <>
        <Icon icon={FileEditIcon} size={17} className="shrink-0 text-accent" />
        <span className="flex-1">You have an unsent draft in this conversation.</span>
        <BannerButton onClick={() => setConfirmDiscard(true)}>Discard</BannerButton>
        <BannerButton primary onClick={() => onDraft("edit")}>
          Continue editing
        </BannerButton>
      </>
    );
  } else if (thread.reminder) {
    const days = Math.max(1, differenceInCalendarDays(new Date(), new Date(thread.reminder.sentAt)));
    content = (
      <>
        <Icon icon={AlarmClockIcon} size={17} className="shrink-0 text-warning" />
        <span className="flex-1">
          You sent this {days} day{days > 1 ? "s" : ""} ago and nobody has replied. Worth a nudge?
        </span>
      </>
    );
  } else if (thread.muted) {
    content = (
      <>
        <Icon icon={NotificationOff02Icon} size={17} className="shrink-0 text-pane-muted" />
        <span className="flex-1">Muted. New replies skip your inbox and won&apos;t notify you.</span>
        <BannerButton onClick={onUnmute}>Unmute</BannerButton>
      </>
    );
  } else if (thread.mailbox === "screener" && sender) {
    content = (
      <>
        <Icon icon={UserCheck01Icon} size={17} className="shrink-0 text-accent" />
        <span className="flex-1">First time {sender.name} has emailed you. Want their mail in your inbox?</span>
        <BannerButton onClick={() => onSender("block")}>Block</BannerButton>
        <BannerButton primary onClick={() => onSender("allow")}>Allow</BannerButton>
      </>
    );
  }
  if (!content) return null;
  return (
    <div className="blur-fade-up mt-5 flex flex-wrap items-center gap-3 rounded-2xl border border-pane-border bg-pane-2 px-4 py-3 text-[13px]">
      {content}
    </div>
  );
}

export function BannerButton({ children, primary, onClick }: { children: React.ReactNode; primary?: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-8 rounded-full px-3.5 text-[12.5px] font-medium transition-opacity hover:opacity-90",
        primary ? "bg-pane-fg text-pane" : "border border-pane-border hover:bg-pane-hover",
      )}
    >
      {children}
    </button>
  );
}
