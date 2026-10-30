"use client";

import { forwardRef, useState } from "react";
import { AiMagicIcon, SquareArrowExpand01Icon, FlowIcon } from "@hugeicons/core-free-icons";
import { comboFromEvent, useShortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { SendMenu, type SendOptions } from "./send-menu";
import type { Design } from "@/lib/design/spec";
import { SignatureSlot } from "../design/signature-slot";
import type { Snippet } from "@/lib/settings";
import { expandSnippet } from "@/lib/mail/snippets";
import type { Recipient } from "@/lib/mail/compose";
import { RichEditor, type RichEditorHandle } from "./rich-editor";
import { describeMissing, type PreparedReply } from "@/lib/rules/prepared";
import { Thinking } from "../ui/thinking";

const DRAFT_STEPS = ["Reading the conversation", "Drafting a reply", "Matching the tone"];

export const QuickReply = forwardRef<
  RichEditorHandle,
  {
    to: string;
    recipient?: Recipient;
    signature?: Design;
    onSend: (text: string, options: SendOptions, signature: boolean) => void;
    /** Opens the full reply; `files` were dropped on the box (they attach there). */
    onExpand: (body: string, files?: File[]) => void;
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
    // Floats over the end of the conversation (the text scrolls on underneath and fades out behind it), so it takes no row of its own.
    // The fade leaves the scrollbar alone (`right-3`); only the box itself takes the pointer.
    <div data-quick-reply className="pointer-events-none absolute bottom-0 left-0 right-3 z-10 bg-linear-to-b from-transparent to-pane to-70% px-4 pb-4 pt-5">
      <div
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "copy";
        }}
        onDrop={(e) => {
          if (!e.dataTransfer.files.length) return;
          e.preventDefault();
          onExpand(text, [...e.dataTransfer.files]);
        }}
        className={cn(
          // A real radius (not rounded-full's 9999px) so the pill eases into the card instead of snapping.
          "pointer-events-auto mx-auto flex w-full max-w-[728px] items-end gap-2 border border-pane-border bg-pane px-4 py-2 shadow-[0_6px_20px_rgba(0,0,0,0.08)] transition-[border-radius,border-color] duration-200 ease-out focus-within:border-accent/50",
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
