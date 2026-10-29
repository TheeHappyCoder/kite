"use client";

import { Fragment, forwardRef, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  AiMagicIcon,
  ArrowLeft01Icon,
  Tag01Icon,
  BubbleChatIcon,
  CornerDownRightIcon,
  Archive02Icon,
  Clock01Icon,
  Delete02Icon,
  Forward01Icon,
  Mail01Icon,
  MailOpen01Icon,
  MailReplyAll01Icon,
  SpamIcon,
  StarIcon,
  AlarmClockIcon,
  FileEditIcon,
  SquareArrowExpand01Icon,
  TimeScheduleIcon,
  UserCheck01Icon,
  GitMergeIcon,
  CalendarAdd01Icon,
  Scissor01Icon,
  Camera01Icon,
  PinIcon,
  NotificationOff02Icon,
  Notification02Icon,
  Note01Icon,
  PencilEdit01Icon,
  Cancel01Icon,
  UserCircleIcon,
  FlowIcon,
  MoreHorizontalIcon,
  ArrowUp01Icon,
  Attachment01Icon,
  ArrowDown01Icon,
} from "@hugeicons/core-free-icons";
import { differenceInCalendarDays, format } from "date-fns";
import { accountName, type Account, type Message, type Regroup, type Thread } from "@/lib/mail/types";
import { comboFromEvent, useShortcuts } from "@/lib/shortcuts";
import { cn, formatFullDate, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { Avatar } from "./avatar";
import { Tooltip } from "../ui/tooltip";
import { CircleButton } from "./circle-button";
import { usePaneBack } from "./mail-panes";
import { useNarrowerThan } from "@/lib/layout";
import { SearchQuery, useSearchHighlight } from "./search-highlight";
import { EmailFrame } from "./email-frame";
import { PrivacyChip, useCleanHtml, useMessagePrivacy } from "./privacy-chip";
import { useMessageTranslation, type Translated } from "./translate";
import { SendMenu, type SendOptions } from "./send-menu";
import type { Design } from "@/lib/design/spec";
import { SignatureSlot } from "../design/signature-slot";
import { FilePreview, type FileRef } from "../files/file-preview";
import { htmlToText, messagePreview, paragraphs, splitMessage, unwrap } from "@/lib/mail/quotes";
import { CollapsedPart, ExpandedText, forkParent, replyingLabel, quoteLabel, shortDate, signatureLabel } from "./quote-card";
import { ChatThread } from "./chat-view";
import { AttachmentChip, ThreadFiles, messageFiles } from "./thread-files";
import { InviteCard } from "./invite-card";
import { threadKey } from "@/lib/mail/threads";
import type { Snippet } from "@/lib/settings";
import { expandSnippet } from "@/lib/mail/snippets";
import type { Recipient } from "@/lib/mail/compose";
import { RichEditor, type RichEditorHandle } from "./rich-editor";
import { ThreadMenu, type ThreadMenuItem } from "./thread-menu";
import { LabelChip } from "./labels";
import { accountSpec, serviceName, type MailLabel } from "@/lib/mail/providers";
import { describeMissing, type PreparedReply } from "@/lib/rules/prepared";
import type { SummaryState } from "@/lib/ai-mail";
import { Thinking } from "../ui/thinking";
import { AnimatePresence, motion } from "motion/react";
import { blurFade } from "@/lib/motion";
import { FirstSyncState, useFirstSync } from "./first-sync";
import { AiErrorText } from "../ai-usage-link";
import { capitalise } from "@/lib/format";

type Props = {
  thread: Thread | null;
  searchQuery?: string;
  /** Ids of messages that were unread when the thread was opened. */
  unseen?: string[];
  /** Show the conversation as chat bubbles (per-thread choice or the Settings default). */
  chat: boolean;
  onToggleChat: () => void;
  account?: Account;
  /** Added under replies from this account. */
  signature?: Design;
  onArchive: () => void;
  onDelete: () => void;
  onSpam: () => void;
  onStar: () => void;
  onToggleRead: () => void;
  onSnooze: () => void;
  /** Quick reply: markup body. */
  onSend: (text: string, options: SendOptions, signature: boolean) => void;
  /** Opens the full compose window to reply, reply to all or forward (with any quick-reply text). */
  onCompose: (mode: "reply" | "replyAll" | "forward", body?: string) => void;
  onScheduled: (action: "send-now" | "edit") => void;
  onDraft: (action: "edit" | "discard") => void;
  snippets: Snippet[];
  onManageSnippets: () => void;
  onSender: (action: "allow" | "block") => void;
  /** Local split: this message (and, with `following`, the later ones) becomes its own conversation. */
  onSplit: (messageId: string, following: boolean) => void;
  /** Opens the "Merge with…" picker. */
  onMerge: () => void;
  onAddToCalendar: () => void;
  /** Opens the screenshot editor on the conversation, or on one message. */
  onScreenshot: (messageId?: string) => void;
  /** Puts back the split or merge that made this conversation. */
  onUndoRegroup: (regroup: Regroup) => void;
  onPin: () => void;
  onMute: () => void;
  /** Saves the private note (markup; empty removes it). */
  onNote: (markup: string) => void;
  /** Local subject; null goes back to the original. */
  onRename: (subject: string | null) => void;
  /** Opens the note or the subject editor (shortcut, menu or palette); `n` grows with every request. */
  edit?: { kind: "note" | "rename"; n: number };
  onRequestEdit: (kind: "note" | "rename") => void;
  /** The People panel beside the conversation (rendered by the app, opening files in this reader's preview), or null when closed. */
  people: ((onPreview: (file: FileRef) => void) => React.ReactNode) | null;
  onTogglePeople: () => void;
  /** Shows one person in the People panel (clicking a sender's name). */
  onPerson: (email: string) => void;
  /** The conversation's own labels/folders, resolved. */
  labels: MailLabel[];
  /** Opens the label picker for this conversation. */
  onLabels: () => void;
  /** Shows everything with that label. */
  onOpenLabel: (id: string) => void;
  /** A reply a rule prepared for this conversation: it waits in the quick-reply box, never sent by itself. */
  prepared: PreparedReply | null;
  onDiscardPrepared: () => void;
  /** The AI summary of this conversation, once asked for (Summarise). */
  summary?: SummaryState;
  onSummarise: () => void;
  onCloseSummary: () => void;
  /** Draft with AI: a reply to this conversation, steered by what's typed. Null when it didn't work. */
  onDraftAi: (notes: string) => Promise<string | null>;
};

export const Reader = forwardRef<RichEditorHandle, Props>(function Reader(props, replyRef) {
  const firstSync = useFirstSync();
  const { thread } = props;
  const [preview, setPreview] = useState<FileRef | null>(null);
  // One pane at a time: Back returns to the list. A narrow reader moves reply all, forward, chat
  // view and People into More.
  const back = usePaneBack();
  const [sectionRef, narrowReader] = useNarrowerThan<HTMLElement>(NARROW_READER);
  const highlightRef = useRef<HTMLElement | null>(null);
  const readerRef = useCallback((node: HTMLElement | null) => { highlightRef.current = node; sectionRef(node); }, [sectionRef]);
  useSearchHighlight(highlightRef, props.searchQuery ?? "", thread?.id ?? "");
  const narrow = narrowReader === true;
  // Once the subject scrolls out of view it shows in the toolbar instead (kept per conversation, so a new one starts at the top).
  const [titleGone, setTitleGone] = useState<string | null>(null);
  const subjectInBar = !!thread && titleGone === thread.id;
  // With the subject up there the toolbar keeps only triage, Star and More (the rest moves into More), so the subject has room.
  const compact = narrow || subjectInBar;

  if (!thread) {
    return (
      <section className="relative grid h-full place-items-center bg-pane text-pane-muted">
        {back ? (
          <div className="absolute left-3 top-3">
            <CircleButton icon={ArrowLeft01Icon} label="Back to the list" shortcut="back" onClick={back} />
          </div>
        ) : null}
        {firstSync ? (
          <FirstSyncState progress={firstSync} note="Pick a conversation from the list any time; the rest keeps coming in." />
        ) : (
        <div className="blur-fade text-center">
          <Icon icon={Mail01Icon} size={28} className="mx-auto mb-3 opacity-50" />
          <p className="text-[13px]">Select a conversation</p>
          <p className="mt-1 text-[12px] opacity-70">
            <Kbd>j</Kbd> <Kbd>k</Kbd> to move · <Kbd>?</Kbd> for shortcuts
          </p>
        </div>
        )}
      </section>
    );
  }

  return (
    <SearchQuery.Provider value={props.searchQuery ?? ""}><section ref={readerRef} className="@container flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      {/*
        One row, three groups: triage (what you do to most mail), writing (reply is the box
        below, so only reply all and forward), and how you see it. Everything else is in More,
        grouped, each with its shortcut.
      */}
      <header className="flex items-center gap-1.5 border-b border-pane-border px-4 py-3 @max-[520px]:px-3">
        {back ? (
          <>
            <CircleButton icon={ArrowLeft01Icon} label="Back to the list" shortcut="back" onClick={back} />
            <span className="mx-1 h-5 w-px shrink-0 bg-pane-border" />
          </>
        ) : null}
        <CircleButton icon={Archive02Icon} label={thread.mailbox === "trash" ? "Move to inbox" : "Archive"} shortcut="archive" onClick={props.onArchive} />
        {thread.mailbox !== "trash" ? <CircleButton icon={Clock01Icon} label="Snooze until tomorrow" shortcut="snooze" onClick={props.onSnooze} /> : null}
        <CircleButton icon={Delete02Icon} label={thread.mailbox === "trash" ? "Delete permanently…" : "Delete"} shortcut="delete" onClick={props.onDelete} />
        {thread.scheduled || compact ? null : (
          <span className="blur-fade flex items-center gap-1.5">
            <span className="mx-1.5 h-5 w-px shrink-0 bg-pane-border" />
            <CircleButton icon={MailReplyAll01Icon} label="Reply all" shortcut="replyAll" onClick={() => props.onCompose("replyAll")} />
            <CircleButton icon={Forward01Icon} label="Forward" shortcut="forward" onClick={() => props.onCompose("forward")} />
          </span>
        )}
        <div className="flex min-w-0 flex-1 items-center">
          {subjectInBar ? (
            <>
              <span className="mx-1.5 h-5 w-px shrink-0 bg-pane-border" />
              <p key={thread.id} data-sensitive title={thread.subject} className="blur-fade-up min-w-0 truncate px-1.5 text-[14px] font-semibold tracking-tight">
                {thread.subject}
              </p>
            </>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5">
          <CircleButton
            icon={StarIcon}
            label={thread.starred ? "Unstar" : "Star"}
            shortcut="star"
            onClick={props.onStar}
            iconClassName={cn(thread.starred && "fill-warning text-warning")}
          />
          {compact ? null : (
            <span className="blur-fade flex items-center gap-1.5">
              <CircleButton
                icon={BubbleChatIcon}
                label={props.chat ? "Show as email" : "Show as chat"}
                shortcut="chatView"
                onClick={props.onToggleChat}
                active={props.chat}
              />
              <CircleButton icon={UserCircleIcon} label={props.people ? "Hide people" : "People in this conversation"} shortcut="people" onClick={props.onTogglePeople} active={!!props.people} />
              <CircleButton icon={Camera01Icon} label="Screenshot" shortcut="screenshot" onClick={() => props.onScreenshot()} />
            </span>
          )}
          {thread.scheduled ? null : <ThreadMenu items={menuItems(props, compact)} />}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div
          // No elastic bounce past any edge: it stretched the whole conversation and slid the stuck header under the toolbar.
          className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-none"
          onScroll={(e) => {
            const top = e.currentTarget.getBoundingClientRect().top;
            const title = e.currentTarget.querySelector("[data-thread-title]");
            const gone = !!title && title.getBoundingClientRect().bottom < top;
            if (gone !== subjectInBar) setTitleGone(gone ? thread.id : null);
            // A message header is stuck while its message has scrolled up under it (styled in globals.css).
            // Stuck, it slims to one line; its box keeps the full height (the rest is see-through) so the message doesn't jump.
            // Every read first, then the writes: a write between reads would force a layout per header.
            const changes = [...e.currentTarget.querySelectorAll<HTMLElement>(".stuck-header")].flatMap((header) => {
              const stuck = header.parentElement!.getBoundingClientRect().top < top - 0.5;
              return stuck === header.hasAttribute("data-stuck") ? [] : [{ header, stuck, height: stuck ? header.offsetHeight : 0 }];
            });
            for (const { header, stuck, height } of changes) {
              header.style.minHeight = stuck ? `${height}px` : "";
              header.toggleAttribute("data-stuck", stuck);
            }
          }}
        >
          <Conversation key={thread.id} {...props} thread={thread} onPreview={setPreview} />
        </div>
        {props.people?.(setPreview)}
      </div>

      <FilePreview file={preview} onClose={() => setPreview(null)} />

      {thread.scheduled || thread.messages.every((m) => m.draft) ? null : (
      <QuickReply
        key={thread.id}
        ref={replyRef}
        to={thread.messages.find((m) => m.from.name !== "You")?.from.name ?? "recipient"}
        recipient={thread.messages.findLast((m) => !m.draft && !isSelf(m.from, props.account))?.from}
        signature={props.signature}
        onSend={props.onSend}
        onExpand={(body) => props.onCompose("reply", body)}
        alwaysShowExpand={props.chat}
        snippets={props.snippets}
        onManageSnippets={props.onManageSnippets}
        prepared={props.prepared}
        onDiscardPrepared={props.onDiscardPrepared}
        onDraftAi={props.onDraftAi}
      />
      )}
    </section></SearchQuery.Provider>
  );
});

/** Below this width the reader's toolbar keeps triage only; the rest moves into More. */
const NARROW_READER = 520;

/** The "More" menu: conversation actions without a toolbar button of their own (`narrow`: the toolbar's writing and view buttons too). */
function menuItems(props: Props, narrow: boolean): ThreadMenuItem[] {
  const thread = props.thread!;
  if (thread.mailbox === "trash") return [
    { id: "restore", icon: Mail01Icon, label: "Move to inbox", onSelect: props.onArchive },
    { id: "delete", icon: Delete02Icon, label: "Delete permanently…", danger: true, onSelect: props.onDelete },
  ];
  const moved: ThreadMenuItem[] = narrow
    ? [
        { id: "replyAll", icon: MailReplyAll01Icon, label: "Reply all", shortcut: "replyAll", onSelect: () => props.onCompose("replyAll") },
        { id: "forward", icon: Forward01Icon, label: "Forward", shortcut: "forward", onSelect: () => props.onCompose("forward") },
        { id: "chat", icon: BubbleChatIcon, label: props.chat ? "Show as email" : "Show as chat", shortcut: "chatView", onSelect: props.onToggleChat },
        { id: "people", icon: UserCircleIcon, label: props.people ? "Hide people" : "People in this conversation", shortcut: "people", onSelect: props.onTogglePeople },
        { id: "screenshot", icon: Camera01Icon, label: "Screenshot", shortcut: "screenshot", onSelect: () => props.onScreenshot() },
      ]
    : [];
  return [
    ...moved,
    // Organise
    {
      id: "read",
      section: narrow,
      icon: thread.unread ? MailOpen01Icon : Mail01Icon,
      label: thread.unread ? "Mark as read" : "Mark as unread",
      shortcut: "toggleRead",
      onSelect: props.onToggleRead,
    },
    { id: "pin", icon: PinIcon, label: thread.pinned ? "Unpin" : "Pin to the top", shortcut: "pin", onSelect: props.onPin },
    {
      id: "labels",
      icon: Tag01Icon,
      label: `${capitalise(accountSpec(props.account).organise.plural)}…`,
      shortcut: "label",
      onSelect: props.onLabels,
    },
    {
      id: "mute",
      icon: thread.muted ? Notification02Icon : NotificationOff02Icon,
      label: thread.muted ? "Unmute" : "Mute conversation",
      shortcut: "mute",
      onSelect: props.onMute,
    },
    // Your AI, on this conversation only
    { id: "summarise", section: true, icon: AiMagicIcon, label: "Summarise with AI", shortcut: "summarise", onSelect: props.onSummarise },
    // Only in Kite
    { id: "note", section: true, icon: Note01Icon, label: thread.note ? "Edit private note" : "Add a private note", shortcut: "note", onSelect: () => props.onRequestEdit("note") },
    { id: "rename", icon: PencilEdit01Icon, label: "Rename subject", onSelect: () => props.onRequestEdit("rename") },
    { id: "merge", icon: GitMergeIcon, label: "Merge with…", shortcut: "merge", onSelect: props.onMerge },
    { id: "calendar", icon: CalendarAdd01Icon, label: "Add to calendar…", shortcut: "addToCalendar", onSelect: props.onAddToCalendar },
    // Set apart, so it isn't hit by accident
    { id: "spam", section: true, danger: true, icon: SpamIcon, label: "Report spam", shortcut: "spam", onSelect: props.onSpam },
  ];
}


/** The conversation's labels under the subject; each opens its list, and one more pick opens the picker. */
function LabelRow({ labels, account, onOpen, onEdit }: { labels: MailLabel[]; account?: Account; onOpen: (id: string) => void; onEdit: () => void }) {
  const spec = accountSpec(account);
  if (!labels.length) return null;
  return (
    <div className="blur-fade mt-2 flex flex-wrap items-center gap-1">
      {labels.map((label) => (
        <LabelChip key={label.id} label={label} spec={spec} onClick={() => onOpen(label.id)} className="py-0.5 text-[11px]" />
      ))}
      <button data-screenshot-hide onClick={onEdit} className="rounded-full px-1.5 py-0.5 text-[11px] font-medium text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
        Change {spec.organise.plural}
      </button>
    </div>
  );
}

/** The subject, renamed in place (only in Kite), with the original one step away. */
function Title({ thread, editing, onEdit, onDone, onRename }: { thread: Thread; editing: boolean; onEdit: () => void; onDone: () => void; onRename: (subject: string | null) => void }) {
  const original = thread.originalSubject ?? thread.subject;
  const commit = (value: string) => {
    const next = value.trim();
    onDone();
    if (!next || next === original) {
      if (thread.originalSubject) onRename(null);
    } else if (next !== thread.subject) onRename(next);
  };
  return (
    <>
      {editing ? (
        <input
          autoFocus
          aria-label="Subject (only changed in Kite)"
          defaultValue={thread.subject}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => commit(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              e.preventDefault();
              e.currentTarget.value = thread.subject;
              e.currentTarget.blur();
            }
          }}
          className="-mx-2 w-[calc(100%+16px)] rounded-xl border border-accent/50 bg-pane px-2 py-0.5 text-[22px] font-semibold leading-tight tracking-tight outline-none"
        />
      ) : (
        <h2 data-sensitive data-thread-title className="group/title flex items-start gap-2 text-[22px] font-semibold leading-tight tracking-tight">
          <span className="min-w-0 break-words">{thread.subject}</span>
          <Tooltip label="Rename (only in Kite)">
            <button
              aria-label="Rename (only in Kite)"
              data-screenshot-hide
              onClick={onEdit}
              className="mt-1 grid size-6 shrink-0 place-items-center rounded-full text-pane-muted opacity-0 transition-opacity hover:bg-pane-hover hover:text-pane-fg focus-visible:opacity-100 group-hover/title:opacity-100"
            >
              <Icon icon={PencilEdit01Icon} size={14} />
            </button>
          </Tooltip>
        </h2>
      )}
      {thread.originalSubject ? (
        <div className="blur-fade mt-1 flex min-w-0 items-center gap-1.5 text-[12px] text-pane-muted">
          <span className="min-w-0 truncate">Original subject: “{thread.originalSubject}”</span>
          <button onClick={() => onRename(null)} className="shrink-0 rounded-full px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft">
            Reset
          </button>
        </div>
      ) : null}
    </>
  );
}

/** The private note: markup like a message body, saved as you type, never sent. */
function NoteCard({ note, autoFocus, onSave, onClose }: { note: string; autoFocus: boolean; onSave: (markup: string) => void; onClose: () => void }) {
  const [saved, setSaved] = useState(true);
  const pending = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  }, [onSave]);
  // Leaving the conversation saves whatever is still waiting.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (pending.current !== null) save.current(pending.current);
    },
    [],
  );
  return (
    <div className="blur-fade-up mt-5 rounded-2xl border border-warning/30 bg-warning/10 px-4 pb-2 pt-3">
      <div className="flex items-center gap-2 text-[11.5px] text-pane-muted">
        <Icon icon={Note01Icon} size={14} className="text-warning" />
        <span className="flex-1">Private note · only in Kite, never sent{saved ? "" : " · saving…"}</span>
        <Tooltip label={note ? "Delete note" : "Close"}>
          <button
            aria-label={note ? "Delete note" : "Close"}
            onClick={() => {
              clearTimeout(timer.current);
              pending.current = null;
              if (note) onSave("");
              onClose();
            }}
            className="grid size-6 place-items-center rounded-full hover:bg-pane-hover hover:text-pane-fg"
          >
            <Icon icon={note ? Delete02Icon : Cancel01Icon} size={13} />
          </button>
        </Tooltip>
      </div>
      <RichEditor
        initial={note}
        autoFocus={autoFocus}
        ariaLabel="Private note"
        placeholder="Write a note to yourself about this conversation…"
        className="min-h-12 py-1.5 text-[13.5px] leading-6"
        onChange={(markup) => {
          pending.current = markup;
          setSaved(false);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            pending.current = null;
            setSaved(true);
            save.current(markup);
          }, 700);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.defaultPrevented) (e.target as HTMLElement).blur();
        }}
      />
    </div>
  );
}

/** "Split from …" / "Merged with …" under the subject, with the way back. */
function RegroupNote({ regroup, onUndo }: { regroup: Regroup; onUndo: () => void }) {
  const split = regroup.kind === "split";
  return (
    <div className="blur-fade mt-2 flex min-w-0 items-center gap-1.5 text-[12px] text-pane-muted">
      <Icon icon={split ? Scissor01Icon : GitMergeIcon} size={13} className="shrink-0" />
      <span className="min-w-0 truncate">
        {split ? "Split from" : "Merged with"} “{regroup.sourceSubject}” · only in Kite
      </span>
      <button onClick={onUndo} className="shrink-0 rounded-full px-1.5 py-0.5 font-medium text-accent hover:bg-accent-soft">
        {split ? "Undo split" : "Restore"}
      </button>
    </div>
  );
}

/** The scrolling body of one conversation; keyed by thread so its open/highlight state resets per thread. */
function Conversation(props: Props & { thread: Thread; onPreview: (file: FileRef) => void }) {
  const { thread } = props;
  const lastId = thread.messages[thread.messages.length - 1]?.id;
  // Fixed for this visit: marking the thread read must not move the divider.
  const [unseen] = useState(() => new Set(props.unseen ?? []));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([...unseen, ...(lastId ? [lastId] : [])]));
  const firstNew = thread.messages.findIndex((m) => unseen.has(m.id));
  const [highlight, setHighlight] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const isOpen = (m: Message) => expanded.has(m.id) || m.id === lastId;
  const items = unfolded ? thread.messages.map((message) => ({ message })) : foldRuns(thread.messages, isOpen);
  const highlightTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const container = useRef<HTMLDivElement>(null);
  // Requests already dealt with in this visit (the request number is kept by the reader).
  const [handled, setHandled] = useState(() => ({ rename: props.edit?.n ?? 0, note: props.edit?.n ?? 0 }));
  const [noteClosed, setNoteClosed] = useState(false);
  const renaming = props.edit?.kind === "rename" && props.edit.n > handled.rename;
  const noteRequested = props.edit?.kind === "note" && props.edit.n > handled.note;
  const showNote = noteRequested || (!!thread.note && !noteClosed);

  const jump = (messageId: string) => {
    flushSync(() => {
      setUnfolded(true);
      setExpanded((current) => new Set(current).add(messageId));
      setHighlight(messageId);
    });
    container.current
      ?.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlight(null), 1800);
  };

  return (
    // `data-screenshot-root`: what Screenshot draws (Kite's own cards and buttons are marked `data-screenshot-hide`).
    <div ref={container} data-screenshot-root className="blur-fade-up mx-auto max-w-[760px] px-8 pb-10 pt-7 @max-[520px]:px-4 @max-[520px]:pt-5">
      <Title
        thread={thread}
        editing={renaming || handled.rename < 0}
        onEdit={() => setHandled((h) => ({ ...h, rename: -1 }))}
        onDone={() => setHandled((h) => ({ ...h, rename: props.edit?.n ?? 0 }))}
        onRename={props.onRename}
      />
      <ThreadMeta thread={thread} account={props.account} filesOpen={filesOpen} onFiles={() => setFilesOpen((v) => !v)} />

      <LabelRow labels={props.labels} account={props.account} onOpen={props.onOpenLabel} onEdit={props.onLabels} />
      {thread.regroup ? <RegroupNote regroup={thread.regroup} onUndo={() => props.onUndoRegroup(thread.regroup!)} /> : null}

      <ThreadFiles thread={thread} open={filesOpen} onPreview={props.onPreview} onJump={jump} />
      <div data-screenshot-hide className="contents">
      <ThreadBanner thread={thread} onScheduled={props.onScheduled} onSender={props.onSender} onDraft={props.onDraft} onUnmute={props.onMute} />
      {props.summary ? (
        <SummaryCard
          state={props.summary}
          newer={!!lastId && props.summary.lastId !== lastId}
          onRefresh={props.onSummarise}
          onClose={props.onCloseSummary}
        />
      ) : null}
      {showNote ? (
        <NoteCard
          key={props.edit?.kind === "note" ? props.edit.n : 0}
          note={thread.note ?? ""}
          autoFocus={noteRequested}
          onSave={props.onNote}
          onClose={() => {
            setNoteClosed(true);
            setHandled((h) => ({ ...h, note: props.edit?.n ?? 0 }));
          }}
        />
      ) : null}
      </div>

      {props.chat ? (
        <ChatThread thread={thread} account={props.account} unseen={unseen} highlight={highlight} onPreview={props.onPreview} />
      ) : (
      // Each message is its own bordered block, open or folded to one line, so replies are easy to tell apart.
      <div className="mt-6">
        <div className="flex flex-col gap-2">
        {items.map((item) => {
          if (!("message" in item)) {
            return <FoldRow key={`fold:${item.ids[0]}`} count={item.ids.length} onClick={() => setUnfolded(true)} />;
          }
          const { message } = item;
          const index = thread.messages.indexOf(message);
          return (
            <Fragment key={message.id}>
              {index === firstNew && index > 0 ? <NewDivider count={thread.messages.length - index} /> : null}
              <MessageView
                message={message}
                thread={thread}
                account={props.account}
                open={isOpen(message)}
                onOpen={() => setExpanded((current) => new Set(current).add(message.id))}
                onClose={
                  message.id === lastId
                    ? undefined
                    : () =>
                        setExpanded((current) => {
                          const next = new Set(current);
                          next.delete(message.id);
                          return next;
                        })
                }
                highlighted={highlight === message.id}
                onPreview={props.onPreview}
                onSplit={thread.messages.length > 1 && !thread.scheduled ? (following) => props.onSplit(message.id, following) : undefined}
                onScreenshot={() => props.onScreenshot(message.id)}
                later={thread.messages.length - index - 1}
                onPerson={props.account && message.from.email.toLowerCase() !== props.account.email.toLowerCase() && message.from.name !== "You" ? props.onPerson : undefined}
                onJump={jump}
              />
            </Fragment>
          );
        })}
        </div>
      </div>
      )}
    </div>
  );
}

const SUMMARY_STEPS = ["Reading the conversation", "Picking out what matters", "Writing the summary"];

/** Summarise: what your AI made of this conversation, with what's asked of you. Kept until closed or Kite reloads. */
function SummaryCard({ state, newer, onRefresh, onClose }: { state: SummaryState; newer: boolean; onRefresh: () => void; onClose: () => void }) {
  return (
    <div className="blur-fade-up mt-5 rounded-2xl border border-pane-border bg-pane-2 px-4 pb-3.5 pt-3">
      <div className="flex min-w-0 items-center gap-2 text-[11.5px] text-pane-muted">
        {state.status === "loading" ? (
          <Thinking steps={SUMMARY_STEPS} className="min-w-0 flex-1 text-[12px] text-pane-fg" />
        ) : (
          <>
            <Icon icon={AiMagicIcon} size={14} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate">Summary by your AI · from this conversation only</span>
            {newer || state.status === "error" ? (
              <button onClick={onRefresh} className="shrink-0 rounded-full px-2 py-0.5 font-medium text-accent hover:bg-accent-soft">
                {state.status === "error" ? "Try again" : "New messages · Refresh"}
              </button>
            ) : null}
          </>
        )}
        <Tooltip label="Close summary">
          <button aria-label="Close summary" onClick={onClose} className="grid size-6 shrink-0 place-items-center rounded-full hover:bg-pane-hover hover:text-pane-fg">
            <Icon icon={Cancel01Icon} size={13} />
          </button>
        </Tooltip>
      </div>
      <AnimatePresence mode="popLayout" initial={false}>
        {state.status === "done" ? (
          <motion.div key="done" {...blurFade({ y: 4, blur: 4, speed: "moderate" })} data-sensitive className="mt-2 flex flex-col gap-2 text-[13.5px] leading-relaxed">
            <p>{state.summary.summary}</p>
            {state.summary.points.length ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-pane-fg/85">
                {state.summary.points.map((point, i) => (
                  <li key={i}>{point}</li>
                ))}
              </ul>
            ) : null}
            {state.summary.asks.length ? (
              <div className="rounded-xl bg-pane px-3 py-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-pane-muted">For you</p>
                <ul className="mt-0.5 flex flex-col gap-0.5">
                  {state.summary.asks.map((ask, i) => (
                    <li key={i}>{ask}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </motion.div>
        ) : state.status === "error" ? (
          <motion.p key="error" {...blurFade({ y: 4, blur: 4 })} className="mt-2 text-[12.5px] text-warning">
            <AiErrorText message={state.message} />
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** Runs of collapsed messages at least this long fold into one "N older messages" row. */
const FOLD_MIN = 4;

/** Keeps the first and last row of each long run of collapsed messages and folds the middle. */
function foldRuns(messages: Message[], isOpen: (m: Message) => boolean): ({ message: Message } | { ids: string[] })[] {
  const out: ({ message: Message } | { ids: string[] })[] = [];
  let run: Message[] = [];
  const flush = () => {
    if (run.length >= FOLD_MIN) {
      out.push({ message: run[0] }, { ids: run.slice(1, -1).map((m) => m.id) }, { message: run[run.length - 1] });
    } else run.forEach((message) => out.push({ message }));
    run = [];
  };
  for (const message of messages) {
    if (isOpen(message)) {
      flush();
      out.push({ message });
    } else run.push(message);
  }
  flush();
  return out;
}

/** The folded middle of a long conversation. */
function FoldRow({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <div className="blur-fade flex justify-center py-0.5">
      <button
        onClick={onClick}
        className="rounded-full border border-pane-border px-3 py-1 text-[12px] text-pane-muted transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg hover:transition-none"
      >
        {count} earlier message{count > 1 ? "s" : ""}
      </button>
    </div>
  );
}

/** Under the subject: the account, how many messages, who's in it, and the files pill. */
function ThreadMeta({ thread, account, filesOpen, onFiles }: { thread: Thread; account?: Account; filesOpen: boolean; onFiles: () => void }) {
  const fileCount = thread.messages.reduce((n, m) => n + messageFiles(m, thread).length, 0);
  const count = thread.messages.length;
  return (
    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[12px] text-pane-muted">
      {account ? (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: account.color }} />
          <span className="truncate">{accountName(account)}</span>
          <span aria-hidden>·</span>
        </span>
      ) : null}
      <span data-sensitive className="min-w-0 truncate">
        {count} message{count > 1 ? "s" : ""} · {participants(thread, account)}
      </span>
      {fileCount ? (
        <button
          onClick={onFiles}
          aria-expanded={filesOpen}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 font-medium transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg hover:transition-none",
            filesOpen ? "border-accent/40 text-pane-fg" : "border-pane-border",
          )}
        >
          <Icon icon={Attachment01Icon} size={12} />
          {fileCount} file{fileCount > 1 ? "s" : ""}
          <Icon icon={ArrowDown01Icon} size={12} className={cn("transition-transform duration-200", filesOpen && "rotate-180")} />
        </button>
      ) : null}
    </div>
  );
}

type Person = { name: string; email: string };
const isSelf = (person: Person, account?: Account) => person.name === "You" || (!!account && person.email.toLowerCase() === account.email.toLowerCase());
const firstName = (person: Person) => person.name.split(/\s+/)[0] || person.email.split("@")[0];

/** "Ada, Sam and you": everyone in the conversation by first name, you last. */
function participants(thread: Thread, account?: Account) {
  const seen = new Map<string, Person>();
  let you = false;
  for (const m of thread.messages) {
    for (const person of [m.from, ...m.to, ...(m.cc ?? [])]) {
      if (isSelf(person, account)) you = true;
      else if (!seen.has(person.email.toLowerCase())) seen.set(person.email.toLowerCase(), person);
    }
  }
  const names = [...seen.values()].map(firstName);
  const shown = names.length > 3 ? [...names.slice(0, 3), `${names.length - 3} other${names.length > 4 ? "s" : ""}`] : names;
  if (you) shown.push("you");
  if (shown.length === 1 && you) return "just you";
  return shown.length > 1 ? `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}` : (shown[0] ?? "");
}

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
function NewDivider({ count }: { count: number }) {
  return (
    <div className="blur-fade my-1 flex items-center gap-3 text-[11.5px] font-medium text-accent" role="separator" aria-label="New messages">
      <span className="h-px flex-1 bg-accent/40" />
      New{count > 1 ? ` · ${count}` : ""}
      <span className="h-px flex-1 bg-accent/40" />
    </div>
  );
}

function MessageView({
  message,
  thread,
  account,
  open,
  onOpen,
  onClose,
  highlighted,
  onPreview,
  onSplit,
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
      className={cn("scroll-mt-4 rounded-xl border border-pane-border transition-shadow duration-500", highlighted && "ring-2 ring-accent/50")}
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
          {onScreenshot || onSplit ? (
            <ThreadMenu
              items={[
                ...(onScreenshot ? [{ id: "screenshot", icon: Camera01Icon, label: "Screenshot this message", onSelect: onScreenshot }] : []),
                ...(onSplit ? [{ id: "split", icon: Scissor01Icon, label: "Split into its own conversation", onSelect: () => setSplitting(true) }] : []),
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

      {files.length ? (
        <div className="mt-4 flex flex-wrap gap-2">
          {files.map((file, i) => (
            <AttachmentChip key={`${file.attachment.partId ?? ""}:${file.attachment.name}`} file={file} index={i} onPreview={onPreview} />
          ))}
        </div>
      ) : null}
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
  const [showQuoted, setShowQuoted] = useState(false);
  const [showSignature, setShowSignature] = useState(false);
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

const DRAFT_STEPS = ["Reading the conversation", "Drafting a reply", "Matching the tone"];

const QuickReply = forwardRef<
  RichEditorHandle,
  {
    to: string;
    recipient?: Recipient;
    signature?: Design;
    onSend: (text: string, options: SendOptions, signature: boolean) => void;
    onExpand: (body: string) => void;
    /** Chat view keeps "Open in full compose" visible before typing. */
    alwaysShowExpand?: boolean;
    snippets: Snippet[];
    onManageSnippets: () => void;
    prepared: PreparedReply | null;
    onDiscardPrepared: () => void;
    onDraftAi: (notes: string) => Promise<string | null>;
  }
>(function QuickReply({ to, recipient, signature, onSend, onExpand, alwaysShowExpand, snippets, onManageSnippets, prepared, onDiscardPrepared, onDraftAi }, ref) {
  const [text, setText] = useState("");
  const [focused, setFocused] = useState(false);
  const [withSignature, setWithSignature] = useState(true);
  // Remounts the editor to clear it after sending (or to put a prepared reply in).
  const [round, setRound] = useState(0);
  // The prepared reply in the box. It arrives with the conversation and only moves in while the box is empty: never over your typing.
  const [seen, setSeen] = useState<string | null>(null);
  const [shown, setShown] = useState<PreparedReply | null>(null);
  // What the editor starts with when it remounts (a prepared reply, an AI draft, or the text before it).
  const [seed, setSeed] = useState<string | undefined>(undefined);
  // Draft with AI: waiting for it, then the text it replaced (Undo puts that back).
  const [drafting, setDrafting] = useState(false);
  const [aiDraft, setAiDraft] = useState<{ before: string; shown: PreparedReply | null } | null>(null);
  const fill = (body: string) => {
    setSeed(body);
    setText(body);
    setRound((r) => r + 1);
  };
  if ((prepared?.id ?? null) !== seen) {
    setSeen(prepared?.id ?? null);
    if (prepared && !text.trim()) {
      setShown(prepared);
      fill(prepared.body);
    } else if (!prepared) setShown(null);
  }
  const shortcuts = useShortcuts();
  const expanded = focused || text.trim().length > 0;

  const clear = () => {
    setShown(null);
    setAiDraft(null);
    fill("");
  };

  /** Draft with AI: what's typed (or prepared) steers it; the draft replaces it, with Undo. */
  const draftAi = async () => {
    if (drafting) return;
    const before = text;
    setDrafting(true);
    const body = await onDraftAi(before.trim());
    setDrafting(false);
    if (body === null) return;
    setAiDraft({ before, shown });
    setShown(null);
    fill(body);
  };

  const send = (options: SendOptions = {}) => {
    if (!text.trim()) return;
    onSend(text.trim(), options, withSignature && !!signature);
    clear();
  };

  return (
    <div className="px-4 pb-4 pt-2">
      <div
        className={cn(
          // A real radius (not rounded-full's 9999px) so the pill eases into the card instead of snapping.
          "flex items-end gap-2 border border-pane-border bg-pane px-4 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[border-radius,border-color] duration-200 ease-out focus-within:border-accent/50",
          expanded ? "rounded-2xl" : "rounded-[25px]",
        )}
      >
        <div className="flex min-w-0 flex-1 flex-col" data-sensitive={shown || aiDraft ? true : undefined}>
          {drafting ? (
            <div className="blur-fade-down flex min-w-0 items-center pb-0.5 pt-1 text-[11.5px] text-pane-fg">
              <Thinking steps={DRAFT_STEPS} />
            </div>
          ) : aiDraft ? (
            <div className="blur-fade-down flex min-w-0 items-center gap-1.5 pb-0.5 pt-1 text-[11.5px] text-pane-muted" onMouseDown={(e) => e.preventDefault()}>
              <Icon icon={AiMagicIcon} size={12} className="shrink-0 text-accent" />
              <span className="min-w-0 truncate">Drafted by your AI · check it before you send</span>
              <button
                onClick={() => {
                  const { before, shown: was } = aiDraft;
                  setAiDraft(null);
                  setShown(was);
                  fill(before);
                }}
                className="ml-auto shrink-0 rounded-full px-2 py-0.5 font-medium hover:bg-pane-hover hover:text-pane-fg"
              >
                Undo
              </button>
            </div>
          ) : shown ? (
            <div className="blur-fade-down flex min-w-0 items-center gap-1.5 pb-0.5 pt-1 text-[11.5px] text-pane-muted" onMouseDown={(e) => e.preventDefault()}>
              <Icon icon={shown.ai ? AiMagicIcon : FlowIcon} size={12} className={cn("shrink-0", shown.ai && "text-accent")} />
              <span className="min-w-0 truncate">
                {shown.ai ? "Drafted by your AI for " : "Prepared by "}
                <span className="font-medium text-pane-fg/80">{shown.ruleName}</span>
                {shown.missing.length ? ` · ${describeMissing(shown.missing)}` : " · not sent until you send it"}
              </span>
              <button
                onClick={() => {
                  clear();
                  onDiscardPrepared();
                }}
                className="ml-auto shrink-0 rounded-full px-2 py-0.5 font-medium hover:bg-pane-hover hover:text-pane-fg"
              >
                Discard
              </button>
            </div>
          ) : null}
          <RichEditor
            key={round}
            ref={ref}
            initial={seed}
            onChange={setText}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onKeyDown={(e) => {
              const combo = comboFromEvent(e);
              const action = combo ? shortcuts.actionFor(combo) : undefined;
              if (action === "send" || action === "sendArchive") {
                e.preventDefault();
                send({ archive: action === "sendArchive" || undefined });
              }
              if (e.key === "Escape" && !e.defaultPrevented) (e.target as HTMLElement).blur();
            }}
            snippets={snippets.map((snippet) => ({ ...snippet, body: expandSnippet(snippet.body, recipient ? [recipient] : []) }))}
            onManageSnippets={onManageSnippets}
            placeholder={`Quick reply to ${to}…`}
            ariaLabel={`Quick reply to ${to}`}
            className={cn(
              "py-1 text-[13.5px] leading-6 transition-[min-height,max-height] duration-200 ease-out",
              // Collapsed it shows one line (24px plus padding) and never scrolls.
              expanded ? "max-h-48 min-h-24 overflow-y-auto" : "max-h-8 min-h-8 overflow-hidden",
            )}
          />
          {expanded && signature && withSignature ? (
            <div className="blur-fade-up pb-1.5" onMouseDown={(e) => e.preventDefault()}>
              <SignatureSlot design={signature} onRemove={() => setWithSignature(false)} />
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-1 pb-0.5">
          {expanded || alwaysShowExpand ? (
            <>
              <Tooltip label="Open in full compose" side="top" className="blur-fade inline-flex">
                <button
                  aria-label="Open in full compose"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    onExpand(text);
                    clear();
                  }}
                  className="grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                >
                  <Icon icon={SquareArrowExpand01Icon} size={16} />
                </button>
              </Tooltip>
              {expanded ? (
                <Tooltip label={text.trim() ? "Draft with AI from what you wrote" : "Draft with AI"} side="top" className="blur-fade inline-flex">
                  <button
                    aria-label="Draft with AI"
                    disabled={drafting}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => void draftAi()}
                    className="grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-accent disabled:opacity-50"
                  >
                    <Icon icon={AiMagicIcon} size={16} />
                  </button>
                </Tooltip>
              ) : null}
            </>
          ) : null}
          <SendMenu compact archive disabled={!text.trim()} why={text.trim() ? undefined : "Write a reply first"} onSend={send} />
        </div>
      </div>
    </div>
  );
});

function ThreadBanner({
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

function BannerButton({ children, primary, onClick }: { children: React.ReactNode; primary?: boolean; onClick: () => void }) {
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

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-pane-border px-1 tabular-nums text-[10.5px]">{children}</kbd>;
}
