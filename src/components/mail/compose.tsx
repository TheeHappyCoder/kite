"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import {
  AiMagicIcon,
  ArrowRight01Icon,
  ArrowShrink02Icon,
  Attachment01Icon,
  Briefcase01Icon,
  Cancel01Icon,
  Delete02Icon,
  EraserIcon,
  Forward01Icon,
  HappyIcon,
  MinusSignIcon,
  QuoteDownIcon,
  SpellCheckIcon,
} from "@hugeicons/core-free-icons";
import { REWRITE_INSTRUCTION_MAX, REWRITE_LABELS, type RewriteHow, type RewriteStyle } from "@/lib/ai-mail";
import { Thinking } from "../ui/thinking";
import { ThreadMenu, type ThreadMenuItem } from "./thread-menu";
import { AccountFace } from "./account-face";
import { Select } from "../ui/select";
import {
  attachmentLimitError,
  emptyDraft,
  isBlank,
  type AttachmentRef,
  type ComposeDraft,
  type Recipient,
} from "@/lib/mail/compose";
import { attachmentKind, inferMimeType } from "@/lib/mail/attachments";
import { uploadAsset } from "../design/assets";
import { expandSnippet } from "@/lib/mail/snippets";
import { uploadFile } from "@/lib/mail/upload";
import { accountName, type Account, type FileItem, type Thread } from "@/lib/mail/types";
import { serviceName } from "@/lib/mail/providers";
import type { Design } from "@/lib/design/spec";
import { blurFade, springSnappy } from "@/lib/motion";
import type { Snippet } from "@/lib/settings";
import { comboFromEvent, useShortcuts } from "@/lib/shortcuts";
import { bodyToText } from "@/lib/mail/body";
import { cn, formatFullDate } from "@/lib/utils";
import { SignatureSlot } from "../design/signature-slot";
import { AttachPicker, fileKey, type AttachContext } from "../files/attach-picker";
import { FileThumb } from "../files/file-preview";
import { Icon, type IconData } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { ComposeWindow, type ComposeDock } from "./compose-window";
import { RecipientField } from "./recipient-field";
import { Switch } from "../ui/switch";
import { FormatBar, RichEditor, type FormatState, type RichEditorHandle } from "./rich-editor";
import { SendMenu, type SendOptions } from "./send-menu";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { formatBytes, plural } from "@/lib/format";
import { hasRedactions, redactText } from "@/lib/mail/redact";

// Design mode (block editor, brand kit) loads when a draft switches to it.
const DesignedBody = dynamic(() => import("./designed-body").then((m) => m.DesignedBody), { ssr: false });
// Forward with parts removed: loads when it opens.
const RedactDialog = dynamic(() => import("./redact-dialog").then((m) => m.RedactDialog), { ssr: false });

type ComposeFile = {
  key: string;
  name: string;
  bytes: number;
  mimeType: string;
  status: "uploading" | "ready";
  ref?: AttachmentRef;
};

export type CloseResult = { saved: boolean; failed: boolean };

const AUTOSAVE_MS = 1500;

const REWRITE_ICONS: Record<RewriteStyle, IconData> = { shorter: ArrowShrink02Icon, friendlier: HappyIcon, formal: Briefcase01Icon, fix: SpellCheckIcon };

const refKey = (ref: AttachmentRef) => (ref.type === "upload" ? ref.id : `${ref.accountId ?? ""}:${ref.messageId}:${ref.partId}:${ref.name}`);

function fromRef(ref: AttachmentRef): ComposeFile {
  return { key: refKey(ref), name: ref.name, bytes: ref.bytes, mimeType: ref.mimeType, status: "ready", ref };
}

/** "84 KB" -> bytes, for demo files that only carry a readable size. */
function parseSize(size: string) {
  const match = size.match(/^([\d.]+)\s*(B|KB|MB|GB)$/i);
  if (!match) return 0;
  return Math.round(parseFloat(match[1]) * 1024 ** ["B", "KB", "MB", "GB"].indexOf(match[2].toUpperCase()));
}

/** A file Kite already has, attached by reference (bytes are read from the local copy when sending). */
function refFromFile(file: FileItem): AttachmentRef {
  return {
    type: "message",
    accountId: file.accountId,
    messageId: file.messageId,
    // Demo files have no part id; demo mail never leaves the browser.
    partId: file.partId ?? "0",
    name: file.name,
    mimeType: inferMimeType(file.name, file.mimeType),
    bytes: file.bytes ?? parseSize(file.size),
  };
}

export function Compose({
  accounts,
  defaultAccountId,
  initial,
  signatures,
  snippets,
  searchContacts,
  onClose,
  onSend,
  onSaveDraft,
  onDiscardDraft,
  onManageSnippets,
  onDraftAi,
  onRewrite,
  live,
  demoThreads,
  context,
  win,
}: {
  /** This window among the open composers. */
  win: {
    id: number;
    slot: number;
    z: number;
    minimized: boolean;
    dock: ComposeDock;
    onFront: () => void;
    onMinimize: () => void;
    onRestore: () => void;
  };
  live: boolean;
  /** Sample threads for the file picker in demo mode. */
  demoThreads: Thread[];
  /** The conversation being answered, for ordering the file picker. */
  context?: AttachContext;
  accounts: Account[];
  defaultAccountId: string;
  initial?: Partial<ComposeDraft>;
  /** Signature per account id, added to new drafts. */
  signatures: Record<string, Design>;
  snippets: Snippet[];
  searchContacts: (query: string) => Promise<Recipient[]>;
  /** The window closes at once; `pending` settles when a last draft save finishes. */
  onClose: (pending: Promise<CloseResult>) => void;
  /**
   * Resolves when sent or queued (the parent closes the window); rejects with a message to show.
   * Called at once: `draftId` settles when a draft save still under way finishes.
   */
  onSend: (draft: ComposeDraft, options: SendOptions, draftId: Promise<string | undefined>) => Promise<void>;
  /** Live accounts: saves to Gmail drafts. Absent in demo mode. */
  onSaveDraft?: (draft: ComposeDraft) => Promise<{ draftId: string }>;
  onDiscardDraft?: (ref: { accountId: string; draftId: string }) => Promise<void>;
  onManageSnippets?: () => void;
  /** Draft with AI for a reply (the body so far steers it). Null when it didn't work (already explained). */
  onDraftAi: (thread: { accountId: string; key: string }, notes: string) => Promise<string | null>;
  /** Rewrite: only the text given goes to the AI, with a style or the user's own instruction. */
  onRewrite: (text: string, how: RewriteHow) => Promise<string | null>;
}) {
  const [draft, setDraft] = useState<ComposeDraft>(() => ({ ...emptyDraft(defaultAccountId), ...initial }));
  const [files, setFiles] = useState<ComposeFile[]>(() => (initial?.attachments ?? []).map(fromRef));
  const [showCc, setShowCc] = useState(() => !!(initial?.cc?.length || initial?.bcc?.length));
  const [pendingInvalid, setPendingInvalid] = useState<Record<string, boolean>>({});
  const [format, setFormat] = useState<FormatState>({ bold: false, italic: false, bulletList: false, numberList: false });
  const [saveState, setSaveState] = useState<"idle" | "saving" | "saved" | "error">(initial?.draftId ? "saved" : "idle");
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [version, setVersion] = useState(0);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [redacting, setRedacting] = useState(false);
  const [picking, setPicking] = useState(false);
  // Your AI at work on the body: what it's doing, for the Thinking line.
  const [aiBusy, setAiBusy] = useState<string[] | null>(null);
  // The text the AI menu acts on, taken when it opens (clicking the menu would lose the selection).
  const [aiTarget, setAiTarget] = useState<ReturnType<RichEditorHandle["takeSelection"]>>(null);
  /** Design mode: the body is a design document. Switching back to Write keeps it here for this window. */
  const [designMode, setDesignMode] = useState(() => !!initial?.design);
  const [parkedDesign, setParkedDesign] = useState<Design | undefined>(undefined);

  const editorRef = useRef<RichEditorHandle>(null);
  const ccRef = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const shortcuts = useShortcuts();

  const ready = files.filter((f) => f.status === "ready" && f.ref).map((f) => f.ref!);
  const full: ComposeDraft = { ...draft, attachments: ready };
  const draftRef = useRef(full);
  const dirtyRef = useRef(false);
  const savedRef = useRef<{ accountId: string; draftId: string } | null>(
    initial?.draftId ? { accountId: initial.accountId ?? defaultAccountId, draftId: initial.draftId } : null,
  );
  const chainRef = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    draftRef.current = full;
  });

  const signature = draft.signature ? signatures[draft.accountId] : undefined;
  const uploading = files.some((f) => f.status === "uploading");
  const hasRecipients = draft.to.length + draft.cc.length + draft.bcc.length > 0;
  const hasContent = (designMode ? !!draft.design : !!draft.body.trim()) || ready.length > 0 || draft.quote?.mode === "forward";
  const invalid = Object.values(pendingInvalid).some(Boolean);
  const canSend = hasRecipients && hasContent && !uploading && !invalid && !sending;
  /** Why Send is off, said on its tooltip. */
  const whyNot = sending
    ? undefined
    : !hasRecipients
      ? "Add someone to send it to"
      : invalid
        ? "Fix the address that isn't valid"
        : !hasContent
          ? "Write something first"
          : uploading
            ? "Waiting for files to finish uploading"
            : undefined;
  const title = draft.quote?.mode === "forward" ? "Forward" : draft.inReplyTo ? "Reply" : "New message";
  /** A reply or forward from a conversation in Kite: "Send and archive" puts that conversation away. */
  const answers = !!context?.threadId;

  const touch = () => {
    dirtyRef.current = true;
    setVersion((v) => v + 1);
  };
  const update = (patch: Partial<ComposeDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    touch();
  };

  /** Draft with AI (replies only; what's written so far steers it), then Rewrite for the selection or the whole body. */
  const replyTo = draft.threadId && draft.inReplyTo && draft.quote?.mode !== "forward" ? draft.threadId : null;
  const aiItems: ThreadMenuItem[] = [
    ...(replyTo ? [{ id: "draft", icon: AiMagicIcon, label: draft.body.trim() ? "Draft a reply from this" : "Draft a reply", onSelect: () => void draftAi(replyTo) }] : []),
    ...(Object.keys(REWRITE_LABELS) as RewriteStyle[]).map((style, i) => ({
      id: style,
      section: i === 0 && !!replyTo,
      icon: REWRITE_ICONS[style],
      label: REWRITE_LABELS[style],
      onSelect: () => void rewrite(style),
    })),
  ];

  const draftAi = (key: string) =>
    runAi(["Reading the conversation", "Drafting a reply", "Matching the tone"], async () => {
      const body = await onDraftAi({ accountId: draft.accountId, key }, draft.body);
      if (body === null) return;
      editorRef.current?.replaceAll(body);
      setNotice("Drafted by your AI. Check it before you send; Ctrl+Z brings back what was there.");
    });

  /** Your own instruction for Rewrite, typed at the foot of the AI menu. */
  const [instruction, setInstruction] = useState("");
  const rewrite = (how: RewriteHow) => {
    const target = aiTarget;
    if (!target) return setNotice("Write something first, then pick how to rewrite it.");
    return runAi(["Reading your text", typeof how === "string" ? "Rewriting" : "Following your instruction"], async () => {
      const text = await onRewrite(target.markup, how);
      if (text === null) return;
      target.replace(text);
      setNotice(`Your AI rewrote ${target.whole ? "the message" : "the selection"}. Ctrl+Z puts it back.`);
    });
  };

  const runAi = async (steps: string[], work: () => Promise<void>) => {
    setNotice(null);
    setAiBusy(steps);
    try {
      await work();
    } finally {
      setAiBusy(null);
    }
  };

  const switchMode = (design: boolean) => {
    if (design === designMode) return;
    setDesignMode(design);
    if (design) {
      if (parkedDesign) update({ design: parkedDesign });
    } else {
      setParkedDesign(draft.design);
      if (draft.design) update({ design: undefined });
    }
  };

  const save = useCallback(() => {
    const run = async () => {
      if (!dirtyRef.current || !onSaveDraft) return;
      dirtyRef.current = false;
      const snapshot = draftRef.current;
      try {
        const saved = savedRef.current;
        if (saved && (saved.accountId !== snapshot.accountId || isBlank(snapshot))) {
          // Moved to another account, or emptied: the old draft goes.
          setSaveState("saving");
          await onDiscardDraft?.(saved);
          savedRef.current = null;
        }
        if (isBlank(snapshot)) {
          setSaveState("idle");
          return;
        }
        setSaveState("saving");
        const result = await onSaveDraft({ ...snapshot, draftId: savedRef.current?.draftId });
        savedRef.current = { accountId: snapshot.accountId, draftId: result.draftId };
        setSaveState("saved");
      } catch {
        dirtyRef.current = true;
        setSaveState("error");
      }
    };
    chainRef.current = chainRef.current.then(run, run);
    return chainRef.current;
  }, [onSaveDraft, onDiscardDraft]);

  // Autosave a moment after typing stops.
  useEffect(() => {
    if (!version || !onSaveDraft) return;
    const timer = setTimeout(() => void save(), AUTOSAVE_MS);
    return () => clearTimeout(timer);
  }, [version, onSaveDraft, save]);

  const close = () => {
    const pending = (async (): Promise<CloseResult> => {
      if (dirtyRef.current && onSaveDraft) await save();
      else await chainRef.current;
      return { saved: !!savedRef.current, failed: dirtyRef.current && !!onSaveDraft };
    })();
    onClose(pending);
  };

  const discard = async () => {
    dirtyRef.current = false;
    await chainRef.current;
    const saved = savedRef.current;
    files.forEach((f) => {
      if (f.ref?.type === "upload" && !saved) void fetch(`/api/uploads?id=${f.ref.id}`, { method: "DELETE" }).catch(() => {});
    });
    if (saved) await onDiscardDraft?.(saved).catch(() => {});
    savedRef.current = null;
    onClose(Promise.resolve({ saved: false, failed: false }));
  };

  const send = async (options: SendOptions) => {
    if (!canSend) return;
    setSending(true);
    setNotice(null);
    dirtyRef.current = false;
    const draftId = chainRef.current.catch(() => {}).then(() => savedRef.current?.draftId);
    try {
      await onSend(draftRef.current, options, draftId);
    } catch (error) {
      setSending(false);
      dirtyRef.current = true;
      setNotice(error instanceof Error ? error.message : "Message couldn't be sent. Try again.");
    }
  };

  const addFiles = (list: File[]) => {
    let total = files.reduce((n, f) => n + f.bytes, 0);
    for (const file of list) {
      const problem = attachmentLimitError(file.name, file.size, total);
      if (problem) {
        setNotice(problem);
        continue;
      }
      total += file.size;
      const key = crypto.randomUUID();
      setFiles((current) => [...current, { key, name: file.name, bytes: file.size, mimeType: file.type, status: "uploading" }]);
      uploadFile(file)
        .then((ref) => {
          setFiles((current) => current.map((f) => (f.key === key ? { ...f, status: "ready", ref } : f)));
          touch();
        })
        .catch((error: Error) => {
          setFiles((current) => current.filter((f) => f.key !== key));
          setNotice(error.message);
        });
    }
  };

  const attachFiles = (picked: FileItem[]) => {
    let total = files.reduce((n, f) => n + f.bytes, 0);
    const added: ComposeFile[] = [];
    for (const file of picked) {
      const ref = refFromFile(file);
      const problem = attachmentLimitError(ref.name, ref.bytes, total);
      if (problem) {
        setNotice(problem);
        continue;
      }
      total += ref.bytes;
      added.push(fromRef(ref));
    }
    if (!added.length) return;
    setFiles((current) => [...current, ...added.filter((a) => !current.some((f) => f.key === a.key))]);
    touch();
  };
  const attachedKeys = new Set(
    files.flatMap((f) => (f.ref?.type === "message" ? [fileKey({ accountId: f.ref.accountId ?? draft.accountId, messageId: f.ref.messageId, partId: live ? f.ref.partId : undefined, name: f.name })] : [])),
  );
  const closePicker = useCallback(() => {
    setPicking(false);
    // Keep the keyboard in the message (the picker's search field goes away).
    setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) editorRef.current?.focus();
    });
  }, []);

  const removeFile = (file: ComposeFile) => {
    setFiles((current) => current.filter((f) => f.key !== file.key));
    touch();
  };

  // The minimised tab: the subject, else the start of the message, else who it's to.
  const recipients = [...draft.to, ...draft.cc, ...draft.bcc];
  const tabDetail = !win.minimized
    ? ""
    : draft.subject.trim() ||
      (!designMode && bodyToText(draft.body).replace(/\s+/g, " ").trim().slice(0, 80)) ||
      (recipients.length ? `To ${recipients.map((r) => r.name || r.email).join(", ")}` : "");

  return (
    <ComposeWindow
      id={win.id}
      slot={win.slot}
      z={win.z}
      minimized={win.minimized}
      away={sending}
      dock={win.dock}
      tab={{ title, detail: tabDetail }}
      onFront={win.onFront}
      onRestore={win.onRestore}
      onClose={close}
      className={cn(
        "rounded-2xl border bg-pane text-pane-fg shadow-2xl transition-colors max-sm:rounded-none max-sm:border-0",
        dragging ? "border-accent" : "border-pane-border",
      )}
      onKeyDown={(e) => {
        // Keys in the design editor dialog (a portal) are its own.
        if (!e.currentTarget.contains(e.target as Node)) return;
        if (e.key === "Escape" && !e.defaultPrevented) {
          if (confirmDiscard) setConfirmDiscard(false);
          else close();
          return;
        }
        const combo = comboFromEvent(e);
        const action = combo ? shortcuts.actionFor(combo) : undefined;
        if (action === "send") {
          e.preventDefault();
          void send({});
        } else if (action === "sendArchive" && answers) {
          e.preventDefault();
          void send({ archive: true });
        } else if (action === "ccBcc") {
          e.preventDefault();
          setShowCc(true);
          setTimeout(() => ccRef.current?.focus());
        } else if (action === "attach") {
          e.preventDefault();
          fileInput.current?.click();
        } else if (action === "attachFromFiles") {
          e.preventDefault();
          setPicking((p) => !p);
        }
      }}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes("Files") || !e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.files.length || !e.currentTarget.contains(e.target as Node)) return;
        e.preventDefault();
        setDragging(false);
        addFiles([...e.dataTransfer.files]);
      }}
    >
      <div data-window-drag="" className="flex shrink-0 cursor-grab touch-none select-none items-center gap-3 rounded-t-2xl bg-pane-2 px-4 py-2.5 active:cursor-grabbing max-sm:cursor-default max-sm:touch-auto max-sm:rounded-none max-sm:px-3">
        <span className="min-w-0 truncate text-[13px] font-medium">{title}</span>
        <AnimatePresence mode="popLayout" initial={false}>
          {saveState !== "idle" ? (
            <motion.span key={saveState} {...blurFade({ y: 3, blur: 3 })} className={cn("text-[11.5px]", saveState === "error" ? "text-warning" : "text-pane-muted")}>
              {saveState === "saving" ? "Saving…" : saveState === "saved" ? "Draft saved" : "Draft not saved · retrying"}
            </motion.span>
          ) : null}
        </AnimatePresence>
        <ModeSwitch design={designMode} onChange={switchMode} />
        <Tooltip label="Minimise" shortcut="minimizeCompose" side="top" className="inline-flex">
          <button aria-label="Minimise" onClick={win.onMinimize} className="-mr-2 grid size-7 place-items-center rounded-full text-pane-muted touch:size-10 hover:bg-pane-hover hover:text-pane-fg">
            <Icon icon={MinusSignIcon} size={15} />
          </button>
        </Tooltip>
        <Tooltip label="Close and keep draft" side="left" className="inline-flex">
          <button aria-label="Close" onClick={close} className="grid size-7 place-items-center rounded-full text-pane-muted touch:size-10 hover:bg-pane-hover hover:text-pane-fg">
            <Icon icon={Cancel01Icon} size={15} />
          </button>
        </Tooltip>
      </div>

      {accounts.length > 1 ? (
        <div className="flex min-w-0 items-center gap-3 border-b border-pane-border px-4 py-1.5">
          <span className="w-14 shrink-0 text-[12.5px] text-pane-muted">From</span>
          <Select
            label="From"
            value={draft.accountId}
            options={accounts.map((a) => ({
              value: a.id,
              label: accountName(a),
              detail: `${a.email} · ${serviceName(a)}`,
              icon: <AccountFace account={a} className="size-5 text-[8px]" />,
            }))}
            onChange={(accountId) => update({ accountId })}
            className="h-8 min-w-0 pl-1.5 text-[13px]"
          />
        </div>
      ) : null}
      <RecipientField
        label="To"
        value={draft.to}
        onChange={(to) => update({ to })}
        search={searchContacts}
        onPendingInvalid={(bad) => setPendingInvalid((p) => ({ ...p, to: bad }))}
        autoFocus={!draft.to.length}
        trailing={
          showCc ? null : (
            <Tooltip label="Add Cc and Bcc" shortcut="ccBcc">
              <button
                onClick={() => {
                  setShowCc(true);
                  setTimeout(() => ccRef.current?.focus());
                }}
                className="shrink-0 rounded-full px-2 py-0.5 text-[12px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
              >
                Cc Bcc
              </button>
            </Tooltip>
          )
        }
      />
      {draft.to.length > 1 && !draft.inReplyTo ? (
        <label className="blur-fade-down flex items-center gap-3 border-b border-pane-border px-4 py-1.5">
          <span className="min-w-0 flex-1 text-[12px] text-pane-muted">
            {draft.separately
              ? `Each of the ${draft.to.length} gets their own copy${draft.cc.length || draft.bcc.length ? " (Cc and Bcc are left off)" : ""}. Write {first_name} where their name goes.`
              : "Send separately: one copy each, with their own name"}
          </span>
          <Switch value={!!draft.separately} label="Send separately" size="sm" onChange={(separately) => update({ separately })} />
        </label>
      ) : null}
      {showCc ? (
        <div className="blur-fade-down">
          <RecipientField
            ref={ccRef}
            label="Cc"
            value={draft.cc}
            onChange={(cc) => update({ cc })}
            search={searchContacts}
            onPendingInvalid={(bad) => setPendingInvalid((p) => ({ ...p, cc: bad }))}
          />
          <RecipientField
            label="Bcc"
            value={draft.bcc}
            onChange={(bcc) => update({ bcc })}
            search={searchContacts}
            onPendingInvalid={(bad) => setPendingInvalid((p) => ({ ...p, bcc: bad }))}
          />
        </div>
      ) : null}
      <label className="flex items-center gap-3 border-b border-pane-border px-4 py-2">
        <span className="w-14 text-[12.5px] text-pane-muted">Subject</span>
        <input
          value={draft.subject}
          onChange={(e) => update({ subject: e.target.value.replace(/[\r\n]/g, " ") })}
          className="flex-1 bg-transparent text-[13px] outline-none"
        />
      </label>

      <div className="min-h-24 flex-1 overflow-y-auto px-4 py-3" onClick={(e) => e.target === e.currentTarget && editorRef.current?.focus()}>
        {designMode ? (
          <DesignedBody
            design={draft.design}
            body={draft.body}
            subject={draft.subject}
            recipients={{ to: draft.to, cc: draft.cc, bcc: draft.bcc }}
            sender={accounts.find((a) => a.id === draft.accountId) ?? { name: "", email: "" }}
            onDesign={(design) => update({ design })}
            onTemplate={(template) => update({ design: template.design, subject: draft.subject.trim() ? draft.subject : template.subject, ...(template.recipients ? { to: template.recipients.to, cc: template.recipients.cc, bcc: template.recipients.bcc } : {}) })}
          />
        ) : (
          <RichEditor
            ref={editorRef}
            initial={draft.body}
            autoFocus={draft.to.length > 0}
            onChange={(body) => {
              if (body !== draftRef.current.body) update({ body });
            }}
            onFormat={setFormat}
            onFiles={addFiles}
            snippets={snippets.map((s) => ({ ...s, body: expandSnippet(s.body, draft.to) }))}
            onManageSnippets={onManageSnippets}
            placeholder="Write something… type ; for snippets"
            className="min-h-[140px] text-[13.5px] leading-6"
          />
        )}

        {draft.quote ? (
          <QuoteCard draft={draft} open={quoteOpen} onToggle={() => setQuoteOpen((o) => !o)} onRemove={() => update({ quote: undefined })} onRedact={() => setRedacting(true)} />
        ) : null}
        {draft.quote?.mode === "forward" && redacting ? (
          <RedactDialog
            open
            onClose={() => setRedacting(false)}
            accountId={draft.accountId}
            threadId={draft.threadId}
            quote={draft.quote}
            subject={draft.subject}
            live={live}
            demoThreads={demoThreads}
            demoThreadId={context?.threadId}
            onChange={(redact) => {
              setDraft((d) => (d.quote ? { ...d, quote: { ...d.quote, redact: hasRedactions(redact) ? redact : undefined } } : d));
              touch();
            }}
            onSubject={(subject) => update({ subject })}
          />
        ) : null}

        {files.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {files.map((file, i) => (
              <div
                key={file.key}
                className="blur-fade-up flex items-center gap-2 rounded-xl border border-pane-border py-1.5 pl-1.5 pr-1"
                style={{ "--i": i } as React.CSSProperties}
              >
                <FileThumb
                  file={{ accountId: draft.accountId, messageId: null, subject: "", attachment: { name: file.name, size: formatBytes(file.bytes), kind: attachmentKind(file.name, file.mimeType), mimeType: file.mimeType } }}
                  size={15}
                  className="size-7 shrink-0 overflow-hidden rounded-lg"
                />
                <span className="min-w-0">
                  <span className="block max-w-44 truncate text-[12px] font-medium">{file.name}</span>
                  <span className="block text-[11px] text-pane-muted">{file.status === "uploading" ? "Attaching…" : formatBytes(file.bytes)}</span>
                </span>
                <Tooltip label="Remove file">
                  <button
                    aria-label={`Remove ${file.name}`}
                    onClick={() => removeFile(file)}
                    className="grid size-6 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                  >
                    <Icon icon={Cancel01Icon} size={12} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </div>
        ) : null}

        {signature ? (
          <div key={draft.accountId} className="mt-3">
            <SignatureSlot design={signature} onRemove={() => update({ signature: false })} />
          </div>
        ) : null}
      </div>

      <AnimatePresence>
        {aiBusy ? (
          <motion.div key="ai" {...blurFade({ y: 4, blur: 4 })} className="mx-3 mb-2 flex items-center rounded-xl bg-pane-2 px-3 py-2 text-[12px] text-pane-fg">
            <Thinking steps={aiBusy} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      <AnimatePresence>
        {notice ? (
          <motion.div
            {...blurFade({ y: 4, blur: 4 })}
            className="mx-3 mb-2 flex items-start gap-2 rounded-xl bg-pane-2 px-3 py-2 text-[12px] leading-snug text-pane-fg"
          >
            <span className="flex-1">{notice}</span>
            <button onClick={() => setNotice(null)} className="font-medium text-accent hover:opacity-80">
              OK
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="relative flex flex-wrap items-center gap-1 gap-y-1.5 border-t border-pane-border px-3 py-2">
        {!designMode ? <label className="cursor-pointer rounded-full px-2 py-1 text-xs hover:bg-pane-hover">Insert image<input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void uploadAsset(file, { private: true }).then((a) => editorRef.current?.insertImage(a.id)).catch((error: Error) => setNotice(error.message)); }} /></label> : null}
        {picking ? (
          <AttachPicker
            live={live}
            accounts={accounts}
            draftAccountId={draft.accountId}
            demoThreads={demoThreads}
            context={context ?? (draft.threadId ? { accountId: draft.accountId, remoteThreadId: draft.threadId } : undefined)}
            // Your own addresses would match every message.
            people={[...draft.to, ...draft.cc, ...draft.bcc].map((r) => r.email).filter((e) => !accounts.some((a) => a.email.toLowerCase() === e.toLowerCase()))}
            attached={attachedKeys}
            onAttach={attachFiles}
            onUpload={() => fileInput.current?.click()}
            onClose={closePicker}
          />
        ) : null}
        {designMode ? null : (
          <>
            <FormatBar editor={editorRef} state={format} />
            <span className="mx-1 h-5 w-px bg-pane-border" />
          </>
        )}
        <Tooltip label="Attach from your files" shortcut="attachFromFiles" side="top">
          <button
            aria-label="Attach from your files"
            aria-expanded={picking}
            onMouseDown={(e) => picking && e.stopPropagation()}
            onClick={() => setPicking((p) => !p)}
            className={cn("grid size-8 place-items-center rounded-full text-pane-muted touch:size-10 hover:bg-pane-hover hover:text-pane-fg", picking && "bg-pane-hover text-pane-fg")}
          >
            <Icon icon={Attachment01Icon} size={15} />
          </button>
        </Tooltip>
        {designMode ? null : (
          <ThreadMenu
            up
            items={aiItems}
            footer={(close) => (
              <form
                className="mt-1 border-t border-pane-border px-1 pb-0.5 pt-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  const own = instruction.trim();
                  if (!own) return;
                  close();
                  setInstruction("");
                  void rewrite({ instruction: own });
                }}
              >
                <label className="flex h-9 items-center gap-2 rounded-xl bg-pane-2 pl-2.5 pr-1 text-[12.5px] focus-within:ring-1 focus-within:ring-accent/40 touch:h-11">
                  <Icon icon={AiMagicIcon} size={14} className="shrink-0 text-pane-muted" />
                  <input
                    value={instruction}
                    maxLength={REWRITE_INSTRUCTION_MAX}
                    onChange={(e) => setInstruction(e.target.value)}
                    onKeyDown={(e) => {
                      // Escape closes the menu, not the message.
                      if (e.key === "Escape") {
                        e.preventDefault();
                        e.stopPropagation();
                        close();
                      }
                    }}
                    placeholder={aiTarget && !aiTarget.whole ? "Or say how to rewrite the selection" : "Or say how to rewrite it"}
                    aria-label="Your own rewrite instruction"
                    className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
                  />
                  <Tooltip label="Rewrite this way" side="top">
                    <button
                      type="submit"
                      aria-label="Rewrite this way"
                      disabled={!instruction.trim()}
                      className="grid size-7 shrink-0 place-items-center rounded-lg text-accent transition-opacity disabled:opacity-40 touch:size-9"
                    >
                      <Icon icon={ArrowRight01Icon} size={14} />
                    </button>
                  </Tooltip>
                </label>
              </form>
            )}
            trigger={(open, toggle) => (
              <Tooltip label="Draft or rewrite with AI" side="top">
                <button
                  aria-label="Draft or rewrite with AI"
                  aria-expanded={open}
                  disabled={!!aiBusy}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (!open) setAiTarget(editorRef.current?.takeSelection() ?? null);
                    toggle();
                  }}
                  className={cn("grid size-8 place-items-center rounded-full text-pane-muted touch:size-10 hover:bg-pane-hover hover:text-accent disabled:opacity-50", open && "bg-pane-hover text-accent")}
                >
                  <Icon icon={AiMagicIcon} size={15} />
                </button>
              </Tooltip>
            )}
          />
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            addFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
        <div className="ml-auto flex items-center gap-2">
          <AnimatePresence mode="popLayout" initial={false}>
            {confirmDiscard ? (
              <motion.div key="confirm" {...blurFade({ x: 6, blur: 4 })} className="flex items-center gap-1.5 text-[12.5px]">
                <span className="text-pane-muted">Discard this draft?</span>
                <button onClick={() => setConfirmDiscard(false)} className="h-7 rounded-full border border-pane-border px-3 hover:bg-pane-hover">
                  Keep
                </button>
                <button onClick={() => void discard()} className="h-7 rounded-full bg-pane-fg px-3 font-medium text-pane">
                  Discard
                </button>
              </motion.div>
            ) : (
              <motion.div key="actions" {...blurFade({ x: -6, blur: 4 })} className="flex items-center gap-2">
                <Tooltip label="Discard draft" side="top">
                  <button
                    aria-label="Discard draft"
                    onClick={() => (isBlank(full) && !savedRef.current ? void discard() : setConfirmDiscard(true))}
                    className="grid size-8 place-items-center rounded-full text-pane-muted touch:size-10 hover:bg-pane-hover hover:text-pane-fg"
                  >
                    <Icon icon={Delete02Icon} size={15} />
                  </button>
                </Tooltip>
                <SendMenu disabled={!canSend} sending={sending} why={whyNot} archive={answers} onSend={(options) => void send(options)} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </ComposeWindow>
  );
}

/** Write (markup body) or Design (a designed email), as a pill segmented control. */
function ModeSwitch({ design, onChange }: { design: boolean; onChange: (design: boolean) => void }) {
  return (
    <FluidList axis="x" tone="pill" role="radiogroup" aria-label="Message type" className="ml-auto flex items-center rounded-full bg-pane p-[2px] shadow-[inset_0_0_0_1px_var(--pane-border)]">
      {([false, true] as const).map((value) => (
        <button
          key={String(value)}
          {...FLUID_ITEM}
          role="radio"
          aria-checked={value === design}
          onClick={() => onChange(value)}
          className={cn("relative h-6 rounded-full px-2.5 text-[11.5px] transition-[color,background-color,font-weight] duration-150", value === design ? "font-semibold text-pane-fg" : "font-medium text-pane-muted data-[lit]:text-pane-fg")}
        >
          {value === design ? (
            <motion.span
              layoutId="compose-mode"
              transition={springSnappy}
              className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
            />
          ) : null}
          <span className="relative">{value ? "Design" : "Write"}</span>
        </button>
      ))}
    </FluidList>
  );
}

/** The message being forwarded (always sent along) or quoted (removable). */
function QuoteCard({ draft, open, onToggle, onRemove, onRedact }: { draft: ComposeDraft; open: boolean; onToggle: () => void; onRemove: () => void; onRedact: () => void }) {
  const quote = draft.quote!;
  const forward = quote.mode === "forward";
  const removed = quote.redact ? quote.redact.phrases.length + quote.redact.images.length + (quote.redact.hideTo ? 1 : 0) : 0;
  return (
    <div className="blur-fade-up mt-3 rounded-xl border border-pane-border bg-pane-2/60">
      <div className="flex items-center gap-2 px-3 py-2 text-[12px]">
        <Icon icon={forward ? Forward01Icon : QuoteDownIcon} size={14} className="shrink-0 text-pane-muted" />
        <button onClick={onToggle} className="min-w-0 flex-1 truncate text-left text-pane-muted hover:text-pane-fg">
          {forward ? "Forwarding" : "Quoting"} <span className="font-medium text-pane-fg">{quote.from.name || quote.from.email}</span> · {formatFullDate(quote.date)}
        </button>
        {forward ? (
          <button
            onClick={onRedact}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[12px] hover:bg-pane-hover hover:text-pane-fg",
              removed ? "font-medium text-accent" : "text-pane-muted",
            )}
          >
            <Icon icon={EraserIcon} size={13} />
            {removed ? `${plural(removed, "part")} removed` : "Remove parts…"}
          </button>
        ) : (
          <Tooltip label="Don't include the quoted message">
            <button aria-label="Remove quoted message" onClick={onRemove} className="grid size-6 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
              <Icon icon={Cancel01Icon} size={12} />
            </button>
          </Tooltip>
        )}
      </div>
      {open || forward ? (
        <p className={cn("border-t border-pane-border px-3 py-2 text-[12px] leading-relaxed text-pane-muted", !open && "line-clamp-2")} onClick={onToggle}>
          {forward ? (
            <span className="mb-1 block font-medium text-pane-fg">{quote.subject}</span>
          ) : null}
          {redactText(quote.snippet, quote.redact) || "The original message is added when you send."}
        </p>
      ) : null}
    </div>
  );
}
