"use client";

import { onDownloadClick } from "@/lib/mail/download";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import {
  Download04Icon,
  FilePenIcon,
  InformationCircleIcon,
  LinkSquare02Icon,
  Mail01Icon,
  RepeatIcon,
} from "@hugeicons/core-free-icons";
import { parseIcs } from "@/lib/calendar/ics";
import { isCalendarFile, type Invite } from "@/lib/calendar/invite";
import { attachmentUrl, canPreview, officePreview } from "@/lib/mail/attachments";
import type { Attachment, Contact } from "@/lib/mail/types";
import type { Layout } from "@/lib/pdf/layout";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Dialog } from "../ui/dialog";
import { Tooltip } from "../ui/tooltip";
import { useFillSign } from "./fill-sign";
import { CircleButton } from "../mail/circle-button";
import { InviteSummary } from "../mail/invite-card";
import { FileTypeIcon } from "./file-icon";
import { PreviewLoading } from "./preview-loading";
import { PDF_THUMB_MAX_BYTES, usePdfThumb } from "./pdf-thumb";

const OfficePreview = dynamic(() => import("./office-preview"), { ssr: false, loading: () => <PreviewLoading /> });

/** An attachment plus where it lives. `messageId` is null for demo mail, which has nothing to download. */
export type FileRef = {
  accountId: string;
  messageId: string | null;
  attachment: Attachment;
  subject?: string;
  threadId?: string;
  /** The message's sender, which "sign like last time" matches on. */
  from?: Contact;
};


export function fileUrl(file: FileRef, download = false) {
  return file.messageId ? attachmentUrl(file.accountId, file.messageId, file.attachment, download) : null;
}

/**
 * What a file looks like at a glance: a viewable image itself, a PDF's first page (drawn once it's on
 * screen, up to PDF_THUMB_MAX_BYTES), else its type's tile. `size` is the tile's height in pixels.
 */
export function FileThumb({ file, size = 20, className }: { file: FileRef; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = fileUrl(file);
  const { attachment } = file;
  const pdfUrl = url && attachment.kind === "pdf" && (attachment.bytes ?? 0) > 0 && attachment.bytes! <= PDF_THUMB_MAX_BYTES ? url : null;
  const { target, src: pdfPage } = usePdfThumb<HTMLSpanElement>(pdfUrl);
  const picture = attachment.kind === "image" && canPreview(attachment) ? url : pdfPage;
  if (picture && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- local, same-origin attachment bytes (or a PDF page drawn here)
      <img src={picture} alt="" loading="lazy" onError={() => setFailed(true)} className={cn("bg-white object-cover object-top", className)} />
    );
  }
  return (
    <span ref={target} className={cn("grid place-items-center", className)}>
      <FileTypeIcon name={attachment.name} mimeType={attachment.mimeType} className="h-auto" style={{ height: Math.round(size * 1.35) }} />
    </span>
  );
}

/** Shows an attachment inside Kite when the browser can render it; everything else downloads. */
/** `openLabel`: the words on the button that goes to the file's mail ("Show email"). */
export function FilePreview({ file, onClose, onOpenEmail, openLabel }: { file: FileRef | null; onClose: () => void; onOpenEmail?: (file: FileRef) => void; openLabel?: string }) {
  const [shown, setShown] = useState<FileRef | null>(file);
  // Keep the last file while the dialog animates out.
  if (file && file !== shown) setShown(file);
  const current = file ?? shown;

  return (
    <Dialog
      open={!!file}
      onClose={onClose}
      title={current?.attachment.name ?? ""}
      description={current ? [current.attachment.size, current.subject].filter(Boolean).join(" · ") : undefined}
      icon={current ? <FileTypeIcon name={current.attachment.name} mimeType={current.attachment.mimeType} className="h-8 w-auto shrink-0" /> : null}
      actions={current ? <PreviewActions file={current} onOpenEmail={onOpenEmail} openLabel={openLabel} onClose={onClose} /> : null}
      stage
      sensitive
      className={cn("w-[min(1120px,calc(100vw-32px))] max-sm:w-full", current && fillsCard(current) && "h-[90vh] max-h-[90vh] max-sm:h-[94vh]")}
    >
      {current ? <PreviewBody file={current} /> : null}
    </Dialog>
  );
}

/** Whether what's shown takes the whole card (a calendar file or a "can't show this" note doesn't). */
function fillsCard(file: FileRef) {
  return !!fileUrl(file) && !isCalendarFile(file.attachment) && (!!officePreview(file.attachment) || canPreview(file.attachment));
}

const OFFICE_NOTES = {
  word: "A preview: open it in Word for the exact layout",
  slides: "A preview: animations, videos and SmartArt only show in PowerPoint",
};

/** Everything you can do with the file, in the dialog's top bar. */
function PreviewActions({ file, onOpenEmail, openLabel = "Show email", onClose }: { file: FileRef; onOpenEmail?: (file: FileRef) => void; openLabel?: string; onClose: () => void }) {
  const open = fileUrl(file);
  const download = fileUrl(file, true);
  const fillSign = useFillSign();
  const pdf = !!fillSign && file.attachment.kind === "pdf";
  const layout = useRememberedLayout(file, pdf);
  const office = officePreview(file.attachment);
  const note = office === "word" || office === "slides" ? OFFICE_NOTES[office] : null;
  return (
    <>
        {note ? (
          <Tooltip label={note} className="mr-1.5 inline-flex shrink-0 text-pane-muted">
            <Icon icon={InformationCircleIcon} size={15} />
          </Tooltip>
        ) : null}
        {onOpenEmail && file.threadId ? (
          <CircleButton
            ghost
            icon={Mail01Icon}
            label={openLabel}
            onClick={() => {
              onClose();
              onOpenEmail(file);
            }}
          />
        ) : null}
        {pdf && layout ? (
          <CircleButton
            ghost
            icon={RepeatIcon}
            label={`Sign like last time: things placed where you put them on your last ${layout.name}, for you to check`}
            iconClassName="text-accent"
            onClick={() => {
              onClose();
              fillSign(file, { layout: layout.id });
            }}
          />
        ) : null}
        {pdf ? (
          <CircleButton
            ghost
            icon={FilePenIcon}
            label="Fill & sign"
            onClick={() => {
              onClose();
              fillSign(file);
            }}
          />
        ) : null}
        {open && canPreview(file.attachment) ? <CircleButton ghost icon={LinkSquare02Icon} label="Open in new tab" onClick={() => window.open(open, "_blank", "noopener,noreferrer")} /> : null}
        {download ? (
          <a
            href={download}
            download={file.attachment.name}
            onClick={onDownloadClick(download, file.attachment.name)}
            className="mx-1.5 flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane hover:opacity-90"
          >
            <Icon icon={Download04Icon} size={14} /> <span className="max-sm:hidden">Download</span>
          </a>
        ) : null}
    </>
  );
}

/**
 * A layout remembered for this sender that this PDF matches with confidence. pdf.js loads only
 * when the sender has remembered layouts at all; the form's text goes only to Kite's own server.
 */
function useRememberedLayout(file: FileRef, enabled: boolean) {
  const [found, setFound] = useState<{ key: string; layout: Layout } | null>(null);
  const sender = file.from?.email.trim().toLowerCase() ?? "";
  const url = fileUrl(file);
  const key = `${url}|${sender}`;
  useEffect(() => {
    if (!enabled || !sender || !url) return;
    let cancelled = false;
    (async () => {
      const { count } = (await fetch(`/api/fill-sign/layouts?sender=${encodeURIComponent(sender)}`).then((r) => r.json())) as { count: number };
      if (!count || cancelled) return;
      const res = await fetch(url);
      if (!res.ok || cancelled) return;
      const { readPrintFromBytes } = await import("@/lib/pdf/print");
      const print = await readPrintFromBytes(new Uint8Array(await res.arrayBuffer()));
      if (cancelled) return;
      const matched = (await fetch("/api/fill-sign/match", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sender, ...print }),
      }).then((r) => r.json())) as { layout: Layout | null };
      if (!cancelled && matched.layout) setFound({ key, layout: matched.layout });
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [enabled, sender, url, key]);
  return found?.key === key ? found.layout : null;
}

function PreviewBody({ file }: { file: FileRef }) {
  const url = fileUrl(file);
  const type = file.attachment.mimeType ?? "";
  if (!url) {
    const text =
      file.attachment.kind === "pdf"
        ? "This is sample mail, so there's no file to show. Fill & sign opens a sample form to try it on."
        : "This is sample mail. Connect your account to open real attachments.";
    return <Placeholder file={file} text={text} />;
  }
  if (isCalendarFile(file.attachment)) return <CalendarPreview file={file} url={url} />;
  if (officePreview(file.attachment)) return <OfficePreview file={file} url={url} />;
  if (!canPreview(file.attachment)) {
    return <Placeholder file={file} text="Kite can't show this kind of file. Download it to open it in another app." />;
  }
  return <BrowserPreview key={url} file={file} url={url} type={type} />;
}

/** What the browser draws itself. The wait sits underneath, so a file that never reports loaded still shows. */
function BrowserPreview({ file, url, type }: { file: FileRef; url: string; type: string }) {
  const [loaded, setLoaded] = useState(false);
  const done = { onLoad: () => setLoaded(true), onError: () => setLoaded(true) };
  const media = { onLoadedMetadata: () => setLoaded(true), onError: () => setLoaded(true) };
  return (
    // Tracks that can't grow past the card: a tall video or picture fits inside it, its controls still on screen.
    <div data-sensitive className="relative grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] grid-rows-[minmax(0,1fr)] place-items-center">
      {loaded ? null : <PreviewLoading className="absolute inset-0" />}
      {file.attachment.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- local, same-origin attachment bytes
        <img {...done} src={url} alt={file.attachment.name} className="relative max-h-full max-w-full rounded-lg object-contain p-6" />
      ) : type.startsWith("audio/") ? (
        <audio {...media} src={url} controls className={cn("relative w-[80%]", !loaded && "invisible")} />
      ) : type.startsWith("video/") ? (
        <video {...media} src={url} controls className={cn("relative size-full object-contain", !loaded && "invisible")} />
      ) : file.attachment.kind === "pdf" ? (
        // Chrome's PDF viewer refuses sandboxed frames; the route never serves PDFs as HTML.
        <iframe {...done} src={url} title={file.attachment.name} className="relative size-full border-0" />
      ) : (
        // Plain text: served with a sandbox CSP, framed with no permissions.
        <iframe {...done} src={url} title={file.attachment.name} sandbox="" className={cn("relative size-full border-0", loaded && "bg-white")} />
      )}
    </div>
  );
}

/** A calendar file shows as the event it describes (read here, never answered from the preview). */
function CalendarPreview({ file, url }: { file: FileRef; url: string }) {
  const [state, setState] = useState<{ url: string; invite: Invite | null } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(url)
      .then((r) => (r.ok ? r.text() : ""))
      .then((text) => live && setState({ url, invite: text ? parseIcs(text) : null }))
      .catch(() => live && setState({ url, invite: null }));
    return () => {
      live = false;
    };
  }, [url]);
  if (state?.url !== url) return <div className="h-40" />;
  if (!state.invite) return <Placeholder file={file} text="Kite couldn't read an event in this calendar file. Download it to open it in your calendar." />;
  return (
    <div className="blur-fade overflow-y-auto px-5 py-5">
      <InviteSummary invite={state.invite} />
    </div>
  );
}

function Placeholder({ file, text }: { file: FileRef; text: string }) {
  return (
    <div className="blur-fade flex flex-col items-center gap-3 px-6 py-14 text-center">
      <FileTypeIcon name={file.attachment.name} mimeType={file.attachment.mimeType} className="h-14" />
      <p className="max-w-sm text-[12.5px] text-pane-muted">{text}</p>
    </div>
  );
}
