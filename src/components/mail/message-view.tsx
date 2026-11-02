"use client";

import { useMemo, useState } from "react";
import { CornerDownRightIcon, Delete02Icon, Scissor01Icon, Camera01Icon, MoreHorizontalIcon, ArrowUp01Icon } from "@hugeicons/core-free-icons";
import { type Account, type Message, type Thread } from "@/lib/mail/types";
import { cn, formatFullDate, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { Avatar } from "./avatar";
import { Tooltip } from "../ui/tooltip";
import { EmailFrame } from "./email-frame";
import { PrivacyChip, useCleanHtml, useMessagePrivacy } from "./privacy-chip";
import { useMessageTranslation, type Translated } from "./translate";
import { type FileRef } from "../files/file-preview";
import { htmlToText, messagePreview, paragraphs, splitMessage, unwrap } from "@/lib/mail/quotes";
import { useFold } from "./fold";
import { CollapsedPart, ExpandedText, forkParent, replyingLabel, quoteLabel, shortDate, signatureLabel } from "./quote-card";
import { MessageFiles, messageFiles } from "./thread-files";
import { InviteCard } from "./invite-card";
import { threadKey } from "@/lib/mail/threads";
import { ThreadMenu } from "./thread-menu";
import { serviceName } from "@/lib/mail/providers";
import { BannerButton } from "./thread-banner";

export type Person = { name: string; email: string };

export const isSelf = (person: Person, account?: Account) => person.name === "You" || (!!account && person.email.toLowerCase() === account.email.toLowerCase());

export const firstName = (person: Person) => person.name.split(/\s+/)[0] || person.email.split("@")[0];

/** "to Sam, you · cc Lee", left out when it only went to you. The full addresses are in the tooltip. */
function recipients(message: Message, account?: Account) {
  const cc = message.cc ?? [];
  if (!cc.length && message.to.length === 1 && isSelf(message.to[0], account)) return null;
  const list = (people: Person[]) => {
    const names = people.map((p) => (isSelf(p, account) ? "you" : firstName(p)));
    return names.length > 3 ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more` : names.join(", ");
  };
  return {
    text: `to ${list(message.to)}${cc.length ? ` · cc ${list(cc)}` : ""}`,
    title: [...message.to, ...cc].map((p) => p.email).join(", "),
  };
}

/** Marks where the messages the user hasn't seen start. */
export function NewDivider({ count }: { count: number }) {
  return (
    <div className="blur-fade my-1 flex items-center gap-3 text-[11.5px] font-medium text-accent" role="separator" aria-label="New messages">
      <span className="h-px flex-1 bg-accent/40" />
      New{count > 1 ? ` · ${count}` : ""}
      <span className="h-px flex-1 bg-accent/40" />
    </div>
  );
}

export function MessageView({
  message,
  thread,
  account,
  open,
  onOpen,
  onClose,
  highlighted,
  onPreview,
  onSplit,
  onDelete,
  onScreenshot,
  later,
  onPerson,
  onJump,
}: {
  message: Message;
  thread: Thread;
  account?: Account;
  open: boolean;
  onOpen: () => void;
  /** Folds it back to one line (not offered for the newest message). */
  onClose?: () => void;
  highlighted: boolean;
  onPreview: (file: FileRef) => void;
  onSplit?: (following: boolean) => void;
  onDelete?: () => void;
  onScreenshot?: () => void;
  /** Messages after this one in the conversation. */
  later: number;
  onPerson?: (email: string) => void;
  onJump: (messageId: string) => void;
}) {
  const files = messageFiles(message, thread);
  const split = useMemo(() => splitMessage(message), [message]);
  const fork = forkParent(message, thread);
  const privacy = useMessagePrivacy(message);
  // Another language: a line offering to translate it here (components/mail/translate.tsx).
  const translation = useMessageTranslation(message, split, later === 0);
  const [splitting, setSplitting] = useState(false);

  const mine = isSelf(message.from, account);

  if (!open) {
    return (
      <button
        data-message-id={message.id}
        data-sensitive
        onClick={onOpen}
        className={cn(
          "flex w-full min-w-0 scroll-mt-4 items-center gap-3 rounded-xl border border-pane-border px-4 py-2.5 text-left transition-[background-color,box-shadow] duration-150 hover:bg-pane-hover hover:transition-none",
          highlighted && "ring-2 ring-accent/50",
        )}
      >
        <Avatar name={message.from.name} email={message.from.email} className="size-7 shrink-0 text-[10.5px]" />
        <span className="max-w-40 shrink-0 truncate text-[13px] font-medium">{mine ? "You" : message.from.name}</span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-pane-muted">{messagePreview(message)}</span>
        <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">{formatListDate(message.date)}</span>
      </button>
    );
  }

  const to = recipients(message, account);
  return (
    <article
      data-message-id={message.id}
      data-sensitive
      className={cn("email-grow scroll-mt-4 rounded-xl border border-pane-border transition-shadow duration-500", highlighted && "ring-2 ring-accent/50")}
    >
      {/*
        The header folds the message back to one line (its own buttons excepted); the newest message stays open.
        It sticks to the top while the message scrolls past, so who sent it (and from which address) stays in view.
      */}
      <div className="stuck-header sticky top-0 z-10">
      <div className="rounded-t-xl border-b border-pane-border bg-pane">
      <div
        onClick={(e) => {
          if (onClose && !(e.target as HTMLElement).closest("button, a, [role=menu]")) onClose();
        }}
        className={cn(
          "flex min-w-0 items-center gap-3 rounded-t-xl px-4 py-3",
          onClose && "cursor-pointer transition-colors duration-150 hover:bg-pane-hover/60 hover:transition-none",
        )}
        data-stuck-row
      >
        <span data-stuck-avatar className="shrink-0">
          <Avatar name={message.from.name} email={message.from.email} className="size-8 shrink-0 text-[11px]" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-baseline gap-2">
            {onPerson ? (
              <button onClick={() => onPerson(message.from.email)} className="min-w-0 max-w-[60%] shrink-0 truncate text-[14px] font-semibold hover:underline">
                {message.from.name}
              </button>
            ) : (
              <span className="min-w-0 max-w-[60%] shrink-0 truncate text-[14px] font-semibold">
                {mine ? "You" : message.from.name}
              </span>
            )}
            {/* The real address, always: a display name alone is how lookalike senders get through. */}
            {mine || !message.from.email ? null : (
              <span title={message.from.email} className="min-w-0 truncate text-[12.5px] text-pane-muted">
                {message.from.email}
              </span>
            )}
            {message.draft ? <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent">Draft</span> : null}
          </div>
          {to ? (
            <span data-stuck-hide title={to.title} className="min-w-0 truncate text-[12px] text-pane-muted">
              {to.text}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <span data-screenshot-hide className="contents">
            <PrivacyChip message={message} state={privacy} />
          </span>
          <Tooltip label={formatFullDate(message.date)}>
            <span className="px-1 text-[12px] tabular-nums text-pane-muted">{shortDate(message.date)}</span>
          </Tooltip>
          {onClose ? (
            <Tooltip label="Collapse">
              <button
                aria-label="Collapse"
                data-screenshot-hide
                onClick={onClose}
                className="grid size-7 place-items-center rounded-full text-pane-muted transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg hover:transition-none"
              >
                <Icon icon={ArrowUp01Icon} size={15} />
              </button>
            </Tooltip>
          ) : null}
          {onScreenshot || onSplit || onDelete ? (
            <ThreadMenu
              items={[
                ...(onScreenshot ? [{ id: "screenshot", icon: Camera01Icon, label: "Screenshot this message", onSelect: onScreenshot }] : []),
                ...(onSplit ? [{ id: "split", icon: Scissor01Icon, label: "Split into its own conversation", onSelect: () => setSplitting(true) }] : []),
                ...(onDelete ? [{ id: "delete", section: true, danger: true, icon: Delete02Icon, label: "Delete this message", onSelect: onDelete }] : []),
              ]}
              trigger={(menuOpen, toggle) => (
                <Tooltip label="Message actions">
                  <button
                    aria-label="Message actions"
                    data-screenshot-hide
                    onClick={toggle}
                    className={cn(
                      "grid size-7 place-items-center rounded-full text-pane-muted transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg hover:transition-none",
                      menuOpen && "bg-pane-hover text-pane-fg",
                    )}
                  >
                    <Icon icon={MoreHorizontalIcon} size={15} />
                  </button>
                </Tooltip>
              )}
            />
          ) : null}
        </div>
      </div>
      </div>
      </div>

      <div className="px-4 pb-4 pt-1">
      {fork ? (
        <button
          onClick={() => onJump(fork.id)}
          className="mt-2 flex min-w-0 max-w-full items-center gap-1.5 border-l-2 border-pane-border pl-2.5 text-left text-[12px] text-pane-muted transition-colors duration-150 hover:border-accent/50 hover:text-pane-fg hover:transition-none"
        >
          <Icon icon={CornerDownRightIcon} size={13} className="shrink-0" />
          <span className="truncate">{replyingLabel(fork, isSelf(fork.from, account))}</span>
        </button>
      ) : null}

      {splitting && onSplit ? (
        <div className="blur-fade-down mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-pane-2 px-3 py-2 text-[12.5px]">
          <Icon icon={Scissor01Icon} size={14} className="shrink-0 text-pane-muted" />
          <span className="mr-auto text-pane-muted">Move to a new conversation (only in Kite, {serviceName(account)} stays as it is)</span>
          <BannerButton onClick={() => setSplitting(false)}>Cancel</BannerButton>
          {later > 0 ? <BannerButton onClick={() => onSplit(true)}>This and {later} later</BannerButton> : null}
          <BannerButton primary onClick={() => onSplit(false)}>
            Just this message
          </BannerButton>
        </div>
      ) : null}

      {message.invite ? (
        <InviteCard
          key={`${message.invite.uid}:${message.invite.sequence}`}
          invite={message.invite}
          account={account}
          threadKey={threadKey(thread)}
          messageId={message.id}
          superseded={supersededInvite(message, thread)}
          demo={!thread.remoteId}
        />
      ) : null}

      {translation.line}

      <MessageBody message={message} thread={thread} split={split} loadRemote={privacy.loadRemote} translated={translation.translated} />

      {files.length ? <MessageFiles files={files} onPreview={onPreview} /> : null}
      </div>
    </article>
  );
}

/** A later message in the conversation updated or cancelled the same event. */
function supersededInvite(message: Message, thread: Thread) {
  const invite = message.invite;
  if (!invite) return false;
  const index = thread.messages.indexOf(message);
  return thread.messages
    .slice(index + 1)
    .some((m) => m.invite?.uid === invite.uid && m.invite.occurrence === invite.occurrence && m.invite.method !== "REPLY" && m.invite.sequence >= invite.sequence);
}

/**
 * The body with quoted history and the signature folded into cards that expand in place.
 * HTML parts are slices of the original, so expanding both shows the message exactly as sent.
 */
function MessageBody({
  message,
  thread,
  split,
  loadRemote,
  translated,
}: {
  message: Message;
  thread: Thread;
  split: ReturnType<typeof splitMessage>;
  loadRemote: boolean;
  /** The new text translated (shown instead of the original); the signature and quotes stay as written. */
  translated?: Translated | null;
}) {
  const fold = useFold();
  const [showQuoted, setShowQuoted] = useState(fold.quoted);
  const [showSignature, setShowSignature] = useState(fold.signatures);
  const fresh = translated && "html" in translated ? translated.html : split.html?.fresh;
  const html = useCleanHtml(split.html ? fresh + (showSignature ? split.html.signature : "") + (showQuoted ? split.html.quoted : "") : "");
  const text = split.text;
  const parts = split.html ?? text;
  const quoteCard = parts.quoted ? (
    <CollapsedPart kind="quote" label={quoteLabel(parts, message, thread)} open={showQuoted} onToggle={() => setShowQuoted((v) => !v)} />
  ) : null;
  const signatureCard = parts.signature ? (
    <CollapsedPart
      kind="signature"
      label={signatureLabel(split.html ? htmlToText(parts.signature) : parts.signature)}
      open={showSignature}
      onToggle={() => setShowSignature((v) => !v)}
    />
  ) : null;

  if (split.html) {
    return (
      <div className="pt-3">
        <EmailFrame html={html} loadRemote={loadRemote} />
        {signatureCard || quoteCard ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {signatureCard}
            {quoteCard}
          </div>
        ) : null}
      </div>
    );
  }

  if (!message.body.length) {
    return (
      <div className="space-y-2.5 pt-3">
        {message.snippet ? <p className="text-[14.5px] leading-relaxed text-pane-fg/60">{message.snippet}</p> : null}
        {[90, 75, 82].map((w, i) => (
          <div key={i} className="h-3 animate-pulse rounded bg-pane-hover" style={{ width: `${w}%` }} />
        ))}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div className="font-reading flex flex-col gap-3 whitespace-pre-line text-[14.5px] leading-relaxed text-pane-fg/90">
        {(translated && "paragraphs" in translated ? translated.paragraphs : paragraphs(text.fresh).map(unwrap)).map((paragraph, i) => (
          <p key={i}>{paragraph}</p>
        ))}
      </div>
      {signatureCard ? <div className="flex">{signatureCard}</div> : null}
      {showSignature ? <ExpandedText text={text.signature} /> : null}
      {quoteCard ? <div className="flex">{quoteCard}</div> : null}
      {showQuoted ? <ExpandedText text={text.quoted} quote /> : null}
    </div>
  );
}
