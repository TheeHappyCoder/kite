"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cancel01Icon, EraserIcon } from "@hugeicons/core-free-icons";
import { escapeHtml } from "@/lib/design/compile";
import type { Quote } from "@/lib/mail/compose";
import { holdRemoteImages } from "@/lib/mail/privacy";
import { phrasePattern, redactHtml, redactText, type Redactions } from "@/lib/mail/redact";
import type { Thread } from "@/lib/mail/types";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Dialog } from "../ui/dialog";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Icon } from "../icon";

export const NO_REDACTIONS: Redactions = { phrases: [], images: [], hideTo: false };

type Source = { html: string | null; text: string };

/**
 * Forward with parts removed: the forwarded message as it will go, with what the user took out
 * blacked out. Select text and Remove (or Delete), click a picture; click a removed part to put it
 * back. The send applies the same redactions (lib/mail/redact.ts), so this is what they'll see.
 */
export function RedactDialog({
  open,
  onClose,
  accountId,
  threadId,
  quote,
  subject,
  live,
  demoThreads,
  demoThreadId,
  onChange,
  onSubject,
}: {
  open: boolean;
  onClose: () => void;
  accountId: string;
  /** The provider thread the forwarded message is in. */
  threadId?: string;
  quote: Quote;
  /** The forward's own subject: it goes as written, so a removed phrase there is pointed out. */
  subject: string;
  live: boolean;
  demoThreads: Thread[];
  /** Demo mode: the Kite thread id of the conversation being forwarded. */
  demoThreadId?: string;
  onChange: (redact: Redactions) => void;
  onSubject: (subject: string) => void;
}) {
  const value = quote.redact ?? NO_REDACTIONS;
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState("");
  const frame = useRef<HTMLIFrameElement>(null);
  const scroll = useRef(0);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  });

  useEffect(() => {
    if (!open || source) return;
    if (!live) {
      // Demo message ids repeat across conversations ("m1"): look in the one being answered first.
      const threads = [...demoThreads.filter((t) => t.id === demoThreadId), ...demoThreads];
      const message = threads.flatMap((t) => t.messages).find((m) => m.id === quote.messageId);
      queueMicrotask(() => setSource({ html: message?.html ?? null, text: message?.body.join("\n\n") ?? quote.snippet }));
      return;
    }
    const params = new URLSearchParams({ account: accountId, message: quote.messageId, ...(threadId ? { thread: threadId } : {}) });
    let gone = false;
    fetch(`/api/mail/quoted?${params}`)
      .then(async (r) => {
        const body = await r.json();
        if (!r.ok) throw new Error(body.error ?? "Kite couldn't open the forwarded message.");
        if (!gone) setSource(body as Source);
      })
      .catch((e: Error) => !gone && setError(e.message));
    return () => {
      gone = true;
    };
  }, [open, source, live, demoThreads, demoThreadId, accountId, threadId, quote.messageId, quote.snippet]);

  const html = useMemo(() => {
    if (!source) return null;
    const body = source.html ?? `<div style="white-space:pre-wrap">${escapeHtml(source.text)}</div>`;
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid: 'self'; style-src 'unsafe-inline'; font-src data: 'self';">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#1b1b1f;font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;overflow-wrap:anywhere}
  body{padding:12px}
  img{max-width:100%;height:auto}
  img[data-kite-img]{cursor:pointer}
  img[data-kite-img]:hover{outline:2px solid #5b4ff0;outline-offset:2px}
  [data-kite-removed],[data-kite-removed-img]{cursor:pointer}
  a{color:#5b4ff0;cursor:text}
  img[data-kite-held]{background:#f1f1f4;border-radius:4px;min-width:40px;min-height:24px}
</style></head><body>${holdRemoteImages(redactHtml(body, value, { mark: true }))}</body></html>`;
  }, [source, value]);

  const change = useCallback((patch: Partial<Redactions>) => onChange({ ...valueRef.current, ...patch }), [onChange]);

  const removePicked = useCallback(() => {
    const text = (frame.current?.contentWindow?.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!text) return;
    const phrases = valueRef.current.phrases;
    if (!phrases.some((p) => p.toLowerCase() === text.toLowerCase())) change({ phrases: [...phrases, text] });
    setPicked("");
  }, [change]);

  /** Wires the freshly loaded preview: selection, clicks on pictures and removed parts, Delete. */
  const onLoad = () => {
    const win = frame.current?.contentWindow;
    const doc = frame.current?.contentDocument;
    if (!win || !doc) return;
    win.scrollTo(0, scroll.current);
    win.addEventListener("scroll", () => (scroll.current = win.scrollY));
    doc.addEventListener("selectionchange", () => setPicked((win.getSelection()?.toString() ?? "").replace(/\s+/g, " ").trim()));
    doc.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removePicked();
      }
      if (e.key === "Escape") onClose();
    });
    doc.addEventListener("click", (e) => {
      const target = e.target as Element | null;
      // Links never open here: this is for picking.
      if (target?.closest("a")) e.preventDefault();
      if (win.getSelection()?.toString()) return;
      const current = valueRef.current;
      const back = target?.closest("[data-kite-removed]");
      if (back) {
        const i = Number(back.getAttribute("data-kite-removed"));
        return change({ phrases: current.phrases.filter((_, j) => j !== i) });
      }
      const picture = target?.closest("[data-kite-img]");
      if (picture) {
        const place = Number(picture.getAttribute("data-kite-img"));
        const images = current.images.includes(place) ? current.images.filter((p) => p !== place) : [...current.images, place];
        change({ images });
      }
    });
  };

  const pattern = phrasePattern(value.phrases);
  const inSubject = !!pattern && pattern.test(subject);
  const count = value.phrases.length + value.images.length;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Remove parts before forwarding"
      description="Select text and press Remove or Delete, or click a picture. Click a removed part to put it back."
      className="w-[720px]"
      footer={
        <>
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-pane-muted">
            {count ? `${plural(count, "part")} removed. It's taken out of the message, not covered.` : "Nothing removed yet."}
          </span>
          {picked ? (
            <button
              onClick={removePicked}
              className="flex max-w-[45%] items-center gap-1.5 rounded-full border border-accent/50 px-3.5 py-1.5 text-[12.5px] font-medium text-accent hover:bg-accent-soft"
            >
              <Icon icon={EraserIcon} size={14} className="shrink-0" />
              <span className="truncate">Remove “{picked}”</span>
            </button>
          ) : null}
          <button onClick={onClose} className="rounded-full bg-pane-fg px-4 py-1.5 text-[12.5px] font-medium text-pane">
            Done
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 pb-4">
        <div data-sensitive className={cn("h-[min(56vh,520px)] overflow-hidden rounded-xl border border-pane-border", html && "bg-white")}>
          {html ? (
            <iframe ref={frame} title="The forwarded message" srcDoc={html} sandbox="allow-same-origin" onLoad={onLoad} className="size-full" />
          ) : (
            <div className="grid size-full place-items-center text-[12.5px] text-pane-muted">
              {error ?? (
                <span className="flex items-center gap-2">
                  <Spinner /> Opening the forwarded message
                </span>
              )}
            </div>
          )}
        </div>

        {value.phrases.length ? (
          <div data-sensitive className="flex flex-wrap gap-1.5">
            {value.phrases.map((phrase, i) => (
              <span key={phrase} className="flex max-w-full items-center gap-1 rounded-full bg-pane-2 py-1 pl-3 pr-1 text-[12px]">
                <span className="truncate line-through decoration-pane-muted">{phrase}</span>
                <button
                  aria-label={`Put back “${phrase}”`}
                  onClick={() => change({ phrases: value.phrases.filter((_, j) => j !== i) })}
                  className="grid size-5 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                >
                  <Icon icon={Cancel01Icon} size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}

        {inSubject ? (
          <p className="flex flex-wrap items-center gap-2 text-[12.5px] text-pane-muted">
            The subject still shows something you removed.
            <button onClick={() => onSubject(redactText(subject, value))} className="font-medium text-accent hover:underline">
              Take it out of the subject
            </button>
          </p>
        ) : null}

        <div className="flex items-center justify-between gap-3 text-[13px]">
          <span>
            Leave out who it was sent to
            <span className="block text-[12px] text-pane-muted">The “To:” line in the forwarded header.</span>
          </span>
          <Switch value={value.hideTo} onChange={(hideTo) => change({ hideTo })} label="Leave out who it was sent to" />
        </div>
        <p className="text-[12px] text-pane-muted">Attached files go as they are: remove any you don&apos;t want from the message itself.</p>
      </div>
    </Dialog>
  );
}
