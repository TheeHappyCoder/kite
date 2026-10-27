"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Attachment01Icon, Cancel01Icon, Image01Icon, LinkSquare02Icon, Pdf01Icon, SentIcon, Upload04Icon } from "@hugeicons/core-free-icons";
import type { DesktopMail, DesktopState } from "@/lib/desktop";
import { escapeMarkup } from "@/lib/mail/body";
import { attachmentLimitError, type AttachmentRef, type ComposeDraft } from "@/lib/mail/compose";
import { uploadFile } from "@/lib/mail/upload";
import { comboFromEvent, comboParts, useShortcuts } from "@/lib/shortcuts";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { CopyIcon } from "../ui/copy";
import { Spinner } from "../ui/spinner";
import { formatBytes } from "@/lib/format";

/*
 * A quick reply inside the Kite bar (components/desktop/bar.tsx): a few lines and files, sent the way
 * compose sends (the prefilled reply from /api/mail/compose, files through /api/uploads, held for
 * Undo send when that's on). Files come from the paperclip or dropped on the Kite bar from Explorer.
 * The Kite bar takes the keyboard only while this is open (src-tauri/src/bar.rs `focus` / `release`).
 */


export type ReplyFile = { key: string; name: string; bytes: number; type: string; ref?: AttachmentRef; error?: string };

/** writing → sending → held (Undo send) → sent; failed goes back to writing with the reason. */
export type ReplyPhase = "writing" | "sending" | "held" | "sent";

type Sent = { held?: string; seconds: number };

const keyOf = (account: string, threadId: string) => threadId.slice(account.length + 1);

export function useQuickReply(mail: DesktopMail | null, demo: boolean) {
  const [text, setText] = useState("");
  const [files, setFiles] = useState<ReplyFile[]>([]);
  const [phase, setPhase] = useState<ReplyPhase>("writing");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<Sent | null>(null);
  /** The prefilled reply and the Undo send setting, read when the reply opens so Send is instant. */
  const prepared = useRef<Promise<{ draft: ComposeDraft | null; undoSend: number }> | null>(null);
  const counter = useRef(0);

  const prepare = useCallback(() => {
    if (!mail || demo || prepared.current) return;
    const key = keyOf(mail.accountId, mail.threadId);
    prepared.current = Promise.all([
      fetch(`/api/mail/compose?account=${encodeURIComponent(mail.accountId)}&thread=${encodeURIComponent(key)}&mode=reply`)
        .then((res) => res.json() as Promise<{ draft?: ComposeDraft }>)
        .then((data) => data.draft ?? null)
        .catch(() => null),
      fetch("/api/desktop")
        .then((res) => res.json() as Promise<DesktopState>)
        .then((data) => data.undoSend ?? 0)
        .catch(() => 0),
    ]).then(([draft, undoSend]) => ({ draft, undoSend }));
  }, [mail, demo]);

  /** A new email on the Kite bar starts a new reply. */
  const reset = useCallback(() => {
    setText("");
    setFiles([]);
    setPhase("writing");
    setError(null);
    setSent(null);
    prepared.current = null;
  }, []);

  const addFiles = useCallback(
    (list: FileList | File[]) => {
      const picked = [...list];
      if (!picked.length) return;
      setError(null);
      let total = files.reduce((sum, f) => sum + (f.error ? 0 : f.bytes), 0);
      const added: ReplyFile[] = [];
      for (const file of picked) {
        const key = `f${++counter.current}`;
        const problem = attachmentLimitError(file.name, file.size, total);
        if (problem) {
          setError(problem);
          continue;
        }
        total += file.size;
        added.push({ key, name: file.name, bytes: file.size, type: file.type });
        if (demo) {
          setTimeout(() => setFiles((all) => all.map((f) => (f.key === key ? { ...f, ref: { type: "upload", id: key, name: file.name, mimeType: file.type, bytes: file.size } } : f))), 700);
          continue;
        }
        uploadFile(file)
          .then((ref) => setFiles((all) => all.map((f) => (f.key === key ? { ...f, ref } : f))))
          .catch((reason: unknown) =>
            setFiles((all) => all.map((f) => (f.key === key ? { ...f, error: reason instanceof Error ? reason.message : "Couldn't attach it" } : f))),
          );
      }
      setFiles((all) => [...all, ...added]);
    },
    [files, demo],
  );

  const removeFile = useCallback((key: string) => setFiles((all) => all.filter((f) => f.key !== key)), []);

  const uploading = files.some((f) => !f.ref && !f.error);
  const ready = files.filter((f) => f.ref).map((f) => f.ref!);
  const canSend = phase === "writing" && !uploading && (text.trim().length > 0 || ready.length > 0);

  /** Sends (or holds for Undo send). Resolves to whether it went. */
  const send = useCallback(async () => {
    if (!mail || !canSend) return false;
    setPhase("sending");
    setError(null);
    if (demo) {
      setSent({ held: "demo", seconds: 5 });
      setPhase("held");
      return true;
    }
    prepare();
    const { draft, undoSend } = await prepared.current!;
    if (!draft) {
      prepared.current = null;
      setPhase("writing");
      setError("Couldn't open this conversation to reply. Try it in Kite.");
      return false;
    }
    const res = await fetch("/api/mail/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...draft, body: escapeMarkup(text.trim()), attachments: [...(draft.attachments ?? []), ...ready], hold: undoSend }),
    }).catch(() => null);
    const data = (await res?.json().catch(() => ({}))) as { held?: string; error?: string } | undefined;
    if (!res?.ok) {
      setPhase("writing");
      setError(data?.error ?? "Couldn't send it. Check your connection and try again.");
      return false;
    }
    setSent({ held: data?.held, seconds: undoSend });
    setPhase(data?.held ? "held" : "sent");
    return true;
  }, [mail, canSend, demo, prepare, text, ready]);

  // Held for Undo send: it goes when the time's up.
  useEffect(() => {
    if (phase !== "held" || !sent) return;
    const timer = setTimeout(() => setPhase("sent"), sent.seconds * 1000);
    return () => clearTimeout(timer);
  }, [phase, sent]);

  /** Undo send: the message comes back into the reply, unchanged. */
  const undo = useCallback(async () => {
    if (phase !== "held" || !sent?.held) return false;
    if (!demo) {
      const res = await fetch(`/api/mail/send?scheduled=${encodeURIComponent(sent.held)}`, { method: "DELETE", headers: { "content-type": "application/json" } }).catch(() => null);
      if (!res?.ok) {
        setPhase("sent");
        return false;
      }
    }
    setSent(null);
    setPhase("writing");
    return true;
  }, [phase, sent, demo]);

  return { text, setText, files, addFiles, removeFile, phase, error, sent, canSend, uploading, prepare, reset, send, undo };
}

export type QuickReplyState = ReturnType<typeof useQuickReply>;

const iconFor = (file: ReplyFile) => (file.type.startsWith("image/") ? Image01Icon : file.type === "application/pdf" ? Pdf01Icon : Attachment01Icon);

/** The reply: who it goes to, the text, the files, and Send. */
export function QuickReply(props: { mail: DesktopMail; reply: QuickReplyState; onClose: () => void; onOpenInKite: () => void; onSend: () => void }) {
  const { mail, reply } = props;
  const { actionFor, primary } = useShortcuts();
  const input = useRef<HTMLInputElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const sendKeys = primary("send");
  const sending = reply.phase === "sending";

  // The shell hands over the keyboard just before this mounts; take it into the text.
  useEffect(() => {
    const timer = setTimeout(() => field.current?.focus(), 60);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1 truncate text-[12px] text-pane-muted">
          To <span className="text-pane-fg">{mail.from.name || mail.from.email}</span>
          <span> · {/^re:/i.test(mail.subject) ? mail.subject : `Re: ${mail.subject}`}</span>
        </div>
        <button
          onClick={props.onClose}
          aria-label="Close reply"
          className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted transition-colors duration-150 hover:bg-pane-2 hover:text-pane-fg"
        >
          <Icon icon={Cancel01Icon} size={13} />
        </button>
      </div>
      <textarea
        ref={field}
        value={reply.text}
        disabled={sending}
        onChange={(event) => reply.setText(event.target.value)}
        onKeyDown={(event) => {
          const combo = comboFromEvent(event);
          if (combo && actionFor(combo) === "send") {
            event.preventDefault();
            props.onSend();
          } else if (event.key === "Escape") {
            event.preventDefault();
            props.onClose();
          }
        }}
        placeholder="Write a reply…"
        rows={3}
        className="max-h-48 min-h-[4.5rem] w-full resize-none rounded-2xl bg-pane-2 px-3.5 py-2.5 font-reading text-[13.5px] leading-snug text-pane-fg outline-none transition-[box-shadow] duration-150 [field-sizing:content] placeholder:text-pane-muted focus:shadow-[inset_0_0_0_1px_var(--pane-border)] disabled:opacity-60"
      />
      <AnimatePresence initial={false}>
        {reply.files.length ? (
          <motion.div {...blurFade({ y: -4, blur: 4, speed: "moderate" })} className="flex flex-wrap gap-1.5">
            <AnimatePresence initial={false} mode="popLayout">
              {reply.files.map((file) => (
                <motion.span
                  key={file.key}
                  layout
                  {...blurFade({ y: 4, blur: 4, speed: "fast" })}
                  title={file.error ?? file.name}
                  className={cn(
                    "flex h-8 max-w-full items-center gap-1.5 rounded-full bg-pane-2 pl-2.5 pr-1 text-[12px]",
                    file.error && "text-danger",
                  )}
                >
                  {!file.ref && !file.error ? <Spinner size={12} /> : <Icon icon={iconFor(file)} size={13} className="shrink-0 text-pane-muted" />}
                  <span className="max-w-[150px] truncate">{file.name}</span>
                  <span className="shrink-0 tabular-nums text-pane-muted">{file.error ? "failed" : formatBytes(file.bytes)}</span>
                  <button
                    onClick={() => reply.removeFile(file.key)}
                    aria-label={`Remove ${file.name}`}
                    className="grid size-6 shrink-0 place-items-center rounded-full text-pane-muted transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg"
                  >
                    <Icon icon={Cancel01Icon} size={11} />
                  </button>
                </motion.span>
              ))}
            </AnimatePresence>
          </motion.div>
        ) : null}
      </AnimatePresence>
      {reply.error ? <div className="text-[12px] leading-snug text-danger">{reply.error}</div> : null}
      <div className="flex items-center gap-1.5">
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(event) => {
            if (event.target.files) reply.addFiles(event.target.files);
            event.target.value = "";
          }}
        />
        <button
          onClick={() => input.current?.click()}
          aria-label="Attach files"
          title="Attach files (or drop them here)"
          className="grid size-9 place-items-center rounded-full bg-pane-2 text-pane-fg transition-[background-color,transform] duration-150 hover:bg-pane-hover active:scale-95"
        >
          <Icon icon={Attachment01Icon} size={15} />
        </button>
        <button
          onClick={props.onOpenInKite}
          className="flex h-9 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-pane-muted transition-colors duration-150 hover:bg-pane-2 hover:text-pane-fg"
        >
          <Icon icon={LinkSquare02Icon} size={13} />
          Open in Kite
        </button>
        {sendKeys ? <span className="ml-auto text-[11px] text-pane-muted">{comboParts(sendKeys).join(" ")}</span> : <span className="ml-auto" />}
        <button
          onClick={props.onSend}
          disabled={!reply.canSend}
          className="flex h-9 items-center gap-1.5 rounded-full bg-accent px-4 text-[13px] font-medium text-accent-fg transition-[opacity,transform] duration-150 active:scale-95 disabled:opacity-40 disabled:active:scale-100"
        >
          {sending ? <Spinner size={13} /> : <Icon icon={SentIcon} size={14} />}
          {sending ? "Sending" : reply.uploading ? "Attaching" : "Send"}
        </button>
      </div>
    </div>
  );
}

/** After Send: held with Undo (a ring running down), then Sent. */
export function ReplySent({ reply, onUndo }: { reply: QuickReplyState; onUndo: () => void }) {
  const held = reply.phase === "held" && reply.sent?.held;
  const seconds = reply.sent?.seconds ?? 0;
  return (
    <div className="flex items-center gap-2.5">
      {held ? (
        <svg viewBox="0 0 20 20" className="size-5 -rotate-90 text-frame-fg" aria-hidden>
          <circle cx="10" cy="10" r="8" fill="none" stroke="currentColor" strokeOpacity={0.2} strokeWidth={2} />
          <motion.circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            initial={{ pathLength: 1 }}
            animate={{ pathLength: 0 }}
            transition={{ duration: seconds, ease: "linear" }}
          />
        </svg>
      ) : (
        <span className="grid size-5 place-items-center rounded-full bg-frame-active text-frame-active-fg">
          <CopyIcon copied size={11} tint={false} />
        </span>
      )}
      <span className="whitespace-nowrap text-[13.5px] font-medium">{held ? "Sending…" : "Sent"}</span>
      {held ? (
        <button
          onClick={onUndo}
          className="h-8 rounded-full bg-white/[0.16] px-3.5 text-[13px] text-frame-fg transition-[background-color,transform] duration-150 hover:bg-white/[0.26] active:scale-95"
        >
          Undo
        </button>
      ) : null}
    </div>
  );
}

/** Over the Kite bar while files are dragged onto it. */
export function DropZone() {
  return (
    <motion.div
      {...blurFade({ blur: 6, speed: "fast" })}
      className="pointer-events-none absolute inset-1.5 z-10 grid place-items-center rounded-[inherit] border border-dashed border-white/70 bg-black/25"
    >
      <div className="flex items-center gap-2 text-[13px]">
        <Icon icon={Upload04Icon} size={16} className="text-accent" />
        Drop to attach to your reply
      </div>
    </motion.div>
  );
}
