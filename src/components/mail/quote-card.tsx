"use client";

import { ArrowDown01Icon, LeftToRightBlockQuoteIcon, SignatureIcon } from "@hugeicons/core-free-icons";
import { format, isThisWeek, isToday } from "date-fns";
import { messagePreview, normaliseMessageId, parentMessageId, paragraphs, unwrap, type SplitText } from "@/lib/mail/quotes";
import type { Message, Thread } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";

/** The message this one answers: In-Reply-To / References, else the one before it. */
function parentMessage(message: Message, thread: Thread, fallbackToPrevious = true): Message | undefined {
  const parentId = parentMessageId(message);
  if (parentId) {
    const found = thread.messages.find((m) => normaliseMessageId(m.messageIdHeader) === parentId);
    if (found) return found;
  }
  if (!fallbackToPrevious) return undefined;
  const index = thread.messages.findIndex((m) => m.id === message.id);
  return index > 0 ? thread.messages[index - 1] : undefined;
}

/**
 * Reply-all forks: the message answers one other than the message right above it.
 * Only a real In-Reply-To/References match counts; no guessing from order.
 */
export function forkParent(message: Message, thread: Thread): Message | undefined {
  const index = thread.messages.findIndex((m) => m.id === message.id);
  if (index <= 0) return undefined;
  const parent = parentMessage(message, thread, false);
  return parent && parent.id !== thread.messages[index - 1].id ? parent : undefined;
}

/** "Replying to Sarah: …", or "Replying to Sarah's message, Tue 14:02" when it had no text. */
export function replyingLabel(parent: Message, mine: boolean) {
  const name = mine ? "you" : parent.from.name.split(/\s+/)[0] || parent.from.name;
  const text = messagePreview(parent).slice(0, 120);
  return text ? `Replying to ${name}: ${text}` : `Replying to ${mine ? "your" : possessive(parent.from.name)} message, ${shortDate(parent.date)}`;
}

export function shortDate(iso: string) {
  const date = new Date(iso);
  if (isToday(date)) return format(date, "HH:mm");
  if (isThisWeek(date, { weekStartsOn: 1 })) return format(date, "EEE HH:mm");
  return format(date, "d MMM, HH:mm");
}

function possessive(name: string) {
  if (name === "You") return "your";
  const first = name.split(/\s+/)[0] || name;
  return first.endsWith("s") ? `${first}'` : `${first}'s`;
}

/** "Quoted from Sarah's message, Tue 14:02", "Forwarded message" or the attribution line itself. */
export function quoteLabel(split: SplitText, message: Message, thread: Thread) {
  if (split.kind === "forward") return "Forwarded message";
  const parent = parentMessage(message, thread);
  if (parent) return `Quoted from ${possessive(parent.from.name)} message, ${shortDate(parent.date)}`;
  return split.attribution ? `Quoted: ${split.attribution.slice(0, 90)}` : "Quoted text";
}

/** A collapsed, clickable stand-in for quoted text or a signature; never hides it silently. */
export function CollapsedPart({
  kind,
  label,
  open,
  onToggle,
  className,
}: {
  kind: "quote" | "signature";
  label: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "flex max-w-full items-center gap-2 rounded-full border border-pane-border px-3 py-1 text-left text-[12px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg",
        className,
      )}
    >
      <Icon icon={kind === "quote" ? LeftToRightBlockQuoteIcon : SignatureIcon} size={14} className="shrink-0" />
      <span className="min-w-0 truncate">{label}</span>
      <Icon icon={ArrowDown01Icon} size={12} className={cn("shrink-0 transition-transform", open && "rotate-180")} />
    </button>
  );
}

/** Quoted or signature text shown in place (plain-text mail). */
export function ExpandedText({ text, quote }: { text: string; quote?: boolean }) {
  return (
    <div
      className={cn(
        "blur-fade-down font-reading flex flex-col gap-2 whitespace-pre-line text-[13.5px] leading-relaxed text-pane-muted",
        quote && "border-l-2 border-pane-border pl-3",
      )}
    >
      {paragraphs(text).map((p, i) => (
        <p key={i}>{unwrap(p.replace(/^> ?/gm, ""))}</p>
      ))}
    </div>
  );
}

/** "Signature" or, for a one-liner like "Sent from my iPhone", the line itself. */
export function signatureLabel(signature: string) {
  const lines = signature.split("\n").map((l) => l.trim()).filter((l) => l && !/^--\s*$/.test(l));
  return lines.length === 1 && lines[0].length <= 40 ? lines[0] : "Signature";
}
