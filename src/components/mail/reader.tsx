"use client";

import { Fragment, forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { AiMagicIcon, ArrowLeft01Icon, Delete02Icon, Mail01Icon, GitMergeIcon, Scissor01Icon, Note01Icon, PencilEdit01Icon, Cancel01Icon, Settings02Icon } from "@hugeicons/core-free-icons";
import { accountName, type Account, type Message, type Regroup, type Thread } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Avatar } from "./avatar";
import { Tooltip } from "../ui/tooltip";
import { CircleButton } from "./circle-button";
import { usePaneBack } from "./mail-panes";
import { useWidthStep } from "@/lib/layout";
import { SearchQuery, useSearchHighlight } from "./search-highlight";
import { type SendOptions } from "./send-menu";
import type { Design } from "@/lib/design/spec";
import { FilePreview, type FileRef } from "../files/file-preview";
import { ChatThread } from "./chat-view";
import { FilesDrawer, messageFiles } from "./thread-files";
import { type ButtonPrefs } from "@/lib/buttons";
import { ContextMenu, type MenuPoint } from "../ui/context-menu";
import type { Snippet } from "@/lib/settings";
import { RichEditor, type RichEditorHandle } from "./rich-editor";
import { ThreadMenu } from "./thread-menu";
import { LabelChip } from "./labels";
import { accountSpec, type MailLabel } from "@/lib/mail/providers";
import { type PreparedReply } from "@/lib/rules/prepared";
import type { SummaryState } from "@/lib/ai-mail";
import { Thinking } from "../ui/thinking";
import { AnimatePresence, motion } from "motion/react";
import { blurFade } from "@/lib/motion";
import { FirstSyncState, useFirstSync } from "./first-sync";
import { AiErrorText } from "../ai-usage-link";
import { TOOLBAR_STEP, ToolbarGroup, moreItems, readerActions, toolbarFor } from "./reader-toolbar";
import { QuickReply } from "./quick-reply";
import { MessageView, NewDivider, type Person, firstName, isSelf } from "./message-view";
import { ThreadBanner } from "./thread-banner";

export type Props = {
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
  onCompose: (mode: "reply" | "replyAll" | "forward", body?: string, files?: File[]) => void;
  onScheduled: (action: "send-now" | "edit") => void;
  onDraft: (action: "edit" | "discard") => void;
  snippets: Snippet[];
  onManageSnippets: () => void;
  onSender: (action: "allow" | "block") => void;
  /** Local split: this message (and, with `following`, the later ones) becomes its own conversation. */
  onSplit: (messageId: string, following: boolean) => void;
  /** "Delete this message": just that message to Trash. */
  onDeleteMessage: (messageId: string) => void;
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
  /** Which actions sit on the toolbar (Settings → Buttons); the rest are in More. */
  buttons: ButtonPrefs;
  /** Opens Settings → Buttons (right-click on the toolbar). */
  onCustomiseButtons?: () => void;
  /** The files drawer over the reader's right side. */
  filesOpen: boolean;
  onToggleFiles: () => void;
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
  // One pane at a time: Back returns to the list. Buttons that don't fit the toolbar fold into More (toolbarFor).
  const back = usePaneBack();
  const highlightRef = useRef<HTMLElement | null>(null);
  const readerRef = useCallback((node: HTMLElement | null) => { highlightRef.current = node; }, []);
  useSearchHighlight(highlightRef, props.searchQuery ?? "", thread?.id ?? "");
  // Once the subject scrolls out of view it shows in the toolbar instead (kept per conversation, so a new one starts at the top).
  const [titleGone, setTitleGone] = useState<string | null>(null);
  const subjectInBar = !!thread && titleGone === thread.id;
  // The toolbar's own width, in steps: buttons fold into More only when they don't fit (fitToolbar).
  const [headerRef, headerWidth] = useWidthStep<HTMLElement>(TOOLBAR_STEP);
  // The files drawer jumps to a message through the conversation's own `jump`.
  const fileCount = thread ? thread.messages.reduce((n, m) => n + messageFiles(m, thread).length, 0) : 0;
  const jumpRef = useRef<((messageId: string) => void) | null>(null);
  const [customise, setCustomise] = useState<MenuPoint | null>(null);

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

  const acts = readerActions(props, thread, fileCount);
  // Every button the user placed while it fits; with the subject in the bar it keeps room for that too.
  const toolbar = toolbarFor(props.buttons.toolbar, acts, headerWidth, { back: !!back, subject: subjectInBar });
  const placed = new Set([...toolbar.left, ...toolbar.right]);
  const more = moreItems(acts, placed);

  return (
    <SearchQuery.Provider value={props.searchQuery ?? ""}><section ref={readerRef} className="@container flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      {/*
        One row: the left and right groups from Settings → Buttons (right-click for it), the subject
        between them once it scrolls away. Everything not placed is in More, grouped, each with its shortcut.
      */}
      <header
        onContextMenu={(e) => {
          if (!props.onCustomiseButtons) return;
          e.preventDefault();
          setCustomise({ x: e.clientX, y: e.clientY });
        }}
        ref={headerRef}
        className="flex items-center gap-1.5 border-b border-pane-border px-4 py-3 @max-[520px]:px-3"
      >
        {back ? (
          <>
            <CircleButton icon={ArrowLeft01Icon} label="Back to the list" shortcut="back" onClick={back} />
            <span className="mx-1 h-5 w-px shrink-0 bg-pane-border" />
          </>
        ) : null}
        <ToolbarGroup slots={toolbar.left} acts={acts} />
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
          <ToolbarGroup slots={toolbar.right} acts={acts} />
          {thread.scheduled || !more.length ? null : <ThreadMenu items={more} />}
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1 flex-col">
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
          <Conversation key={thread.id} {...props} thread={thread} onPreview={setPreview} jumpRef={jumpRef} />
        </div>
        {thread.scheduled || thread.messages.every((m) => m.draft) ? null : (
        <QuickReply
          key={thread.id}
          ref={replyRef}
          to={thread.messages.find((m) => m.from.name !== "You")?.from.name ?? "recipient"}
          recipient={thread.messages.findLast((m) => !m.draft && !isSelf(m.from, props.account))?.from}
          signature={props.signature}
          onSend={props.onSend}
          onExpand={(body, files) => props.onCompose("reply", body, files)}
          alwaysShowExpand={props.chat}
          snippets={props.snippets}
          onManageSnippets={props.onManageSnippets}
          prepared={props.prepared}
          onDiscardPrepared={props.onDiscardPrepared}
          onDraftAi={props.onDraftAi}
        />
        )}
        </div>
        <FilesDrawer thread={thread} open={props.filesOpen} onClose={props.onToggleFiles} onPreview={setPreview} onJump={(id) => jumpRef.current?.(id)} />
        {props.people?.(setPreview)}
      </div>

      <FilePreview file={preview} onClose={() => setPreview(null)} />
      <ContextMenu
        at={customise}
        label="Toolbar"
        items={[{ id: "customise", label: "Customise buttons…", icon: Settings02Icon, onSelect: props.onCustomiseButtons }]}
        onClose={() => setCustomise(null)}
      />

    </section></SearchQuery.Provider>
  );
});

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
function Conversation(props: Props & { thread: Thread; onPreview: (file: FileRef) => void; jumpRef: React.Ref<(messageId: string) => void> }) {
  const { thread } = props;
  const lastId = thread.messages[thread.messages.length - 1]?.id;
  // Fixed for this visit: marking the thread read must not move the divider.
  const [unseen] = useState(() => new Set(props.unseen ?? []));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set([...unseen, ...(lastId ? [lastId] : [])]));
  const firstNew = thread.messages.findIndex((m) => unseen.has(m.id));
  const [highlight, setHighlight] = useState<string | null>(null);
  const [unfolded, setUnfolded] = useState(false);
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
  useImperativeHandle(props.jumpRef, () => jump);

  return (
    // `data-screenshot-root`: what Screenshot draws (Kite's own cards and buttons are marked `data-screenshot-hide`).
    <div ref={container} data-screenshot-root className="blur-fade-up mx-auto max-w-[760px] px-8 pb-28 pt-7 @max-[520px]:px-4 @max-[520px]:pt-5">
      <Title
        thread={thread}
        editing={renaming || handled.rename < 0}
        onEdit={() => setHandled((h) => ({ ...h, rename: -1 }))}
        onDone={() => setHandled((h) => ({ ...h, rename: props.edit?.n ?? 0 }))}
        onRename={props.onRename}
      />
      <ThreadMeta thread={thread} account={props.account} onFiles={props.onToggleFiles} />

      <LabelRow labels={props.labels} account={props.account} onOpen={props.onOpenLabel} onEdit={props.onLabels} />
      {thread.regroup ? <RegroupNote regroup={thread.regroup} onUndo={() => props.onUndoRegroup(thread.regroup!)} /> : null}

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
                onDelete={thread.messages.length > 1 && !thread.scheduled && thread.mailbox !== "trash" ? () => props.onDeleteMessage(message.id) : undefined}
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

/** Under the subject: who's in it (their faces, then names), how many messages, and the account on the right. */
function ThreadMeta({ thread, account, onFiles }: { thread: Thread; account?: Account; onFiles: () => void }) {
  const { people, you } = participants(thread, account);
  const count = thread.messages.length;
  const files = thread.messages.reduce((n, m) => n + messageFiles(m, thread).length, 0);
  const faces = people.slice(0, 3);
  // "Rico, Ana and you", "Rico, Ana, 2 others and you": names bold, the rest muted.
  const names = people.map(firstName);
  const parts: { text: string; name: boolean }[] = [
    ...(names.length > 3 ? names.slice(0, 2) : names).map((text) => ({ text, name: true })),
    ...(names.length > 3 ? [{ text: `${names.length - 2} others`, name: false }] : []),
    ...(you ? [{ text: names.length ? "you" : "Just you", name: false }] : []),
  ];
  return (
    <div className="mt-3 flex min-w-0 items-center gap-2.5 text-[13px]">
      <span data-sensitive className="flex shrink-0">
        {faces.map((person, i) => (
          <Avatar key={person.email} name={person.name} email={person.email} className={cn("size-7 text-[10px] ring-2 ring-pane", i > 0 && "-ml-2")} />
        ))}
        {you && account ? <Avatar name={accountName(account)} email={account.email} className={cn("size-7 text-[10px] ring-2 ring-pane", faces.length && "-ml-2")} /> : null}
      </span>
      <span data-sensitive className="min-w-0 truncate">
        {parts.map((part, i) => (
          <Fragment key={i}>
            {i === 0 ? "" : <span className="text-pane-muted">{i === parts.length - 1 ? " and " : ", "}</span>}
            <span className={part.name ? "font-medium" : "text-pane-muted"}>{part.text}</span>
          </Fragment>
        ))}
        {count > 1 ? <span className="text-pane-muted"> · {count} messages</span> : null}
        {files ? (
          <>
            <span className="text-pane-muted"> · </span>
            <button onClick={onFiles} className="text-accent hover:underline">
              {files} file{files > 1 ? "s" : ""}
            </button>
          </>
        ) : null}
      </span>
      {account ? (
        <span className="ml-auto flex min-w-0 shrink items-center gap-1.5 pl-2 text-[12px] text-pane-muted @max-[420px]:hidden">
          <span className="size-1.5 shrink-0 rounded-full" style={{ background: account.color }} />
          <span className="truncate">{accountName(account)}</span>
        </span>
      ) : null}
    </div>
  );
}

/** Everyone in the conversation but you, the people who wrote first; `you`: whether you're in it. */
function participants(thread: Thread, account?: Account) {
  const writers = new Map<string, Person>();
  const others = new Map<string, Person>();
  let you = false;
  for (const m of thread.messages) {
    for (const [person, wrote] of [[m.from, true], ...[...m.to, ...(m.cc ?? [])].map((p) => [p, false] as const)] as const) {
      const key = person.email.toLowerCase();
      if (isSelf(person, account)) you = true;
      else if (wrote && !writers.has(key)) writers.set(key, person);
      else if (!wrote && !others.has(key)) others.set(key, person);
    }
  }
  return { people: [...writers.values(), ...[...others.values()].filter((p) => !writers.has(p.email.toLowerCase()))], you };
}

function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border border-pane-border px-1 tabular-nums text-[10.5px]">{children}</kbd>;
}
