"use client";

import { onDownloadClick } from "@/lib/mail/download";
import { useEffect, useState } from "react";
import {
  Attachment01Icon,
  Doc01Icon,
  Download04Icon,
  FilePenIcon,
  Image02Icon,
  LinkSquare02Icon,
  Mail01Icon,
  Pdf01Icon,
  RepeatIcon,
  Xls01Icon,
} from "@hugeicons/core-free-icons";
import { parseIcs } from "@/lib/calendar/ics";
import { isCalendarFile, type Invite } from "@/lib/calendar/invite";
import { attachmentUrl, canPreview } from "@/lib/mail/attachments";
import type { Attachment, Contact } from "@/lib/mail/types";
import type { Layout } from "@/lib/pdf/layout";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Dialog } from "../ui/dialog";
import { Tooltip } from "../ui/tooltip";
import { useFillSign } from "./fill-sign";
import { InviteSummary } from "../mail/invite-card";

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

const FILE_ICONS: Record<Attachment["kind"], IconData> = {
  pdf: Pdf01Icon,
  doc: Doc01Icon,
  sheet: Xls01Icon,
  image: Image02Icon,
  other: Attachment01Icon,
};

export function fileUrl(file: FileRef, download = false) {
  return file.messageId ? attachmentUrl(file.accountId, file.messageId, file.attachment, download) : null;
}

/** Image thumbnail when the file is a viewable image, otherwise the kind's icon. */
export function FileThumb({ file, size = 20, className }: { file: FileRef; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  const url = fileUrl(file);
  if (url && file.attachment.kind === "image" && canPreview(file.attachment) && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- local, same-origin attachment bytes
      <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} className={cn("object-cover", className)} />
    );
  }
  return (
    <span className={cn("grid place-items-center text-pane-muted", className)}>
      <Icon icon={FILE_ICONS[file.attachment.kind]} size={size} />
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
      className="w-[min(960px,calc(100vw-32px))]"
      footer={current ? <PreviewActions file={current} onOpenEmail={onOpenEmail} openLabel={openLabel} onClose={onClose} /> : null}
    >
      {current ? <PreviewBody file={current} /> : null}
    </Dialog>
  );
}

function PreviewActions({ file, onOpenEmail, openLabel = "Show email", onClose }: { file: FileRef; onOpenEmail?: (file: FileRef) => void; openLabel?: string; onClose: () => void }) {
  const open = fileUrl(file);
  const download = fileUrl(file, true);
  const fillSign = useFillSign();
  const pdf = !!fillSign && file.attachment.kind === "pdf";
  const layout = useRememberedLayout(file, pdf);
  return (
    <>
      {onOpenEmail && file.threadId ? (
        <button
          onClick={() => {
            onClose();
            onOpenEmail(file);
          }}
          className={ghostClass}
        >
          <Icon icon={Mail01Icon} size={14} /> {openLabel}
        </button>
      ) : null}
      {pdf && layout ? (
        <Tooltip label={`Opens Fill & sign with things placed where you put them on your last ${layout.name}, for you to check`} className="ml-auto inline-flex">
          <button
            onClick={() => {
              onClose();
              fillSign(file, { layout: layout.id });
            }}
            className="blur-fade flex h-8 items-center gap-1.5 rounded-full border border-accent/50 px-3 text-[12.5px] text-pane-fg hover:bg-accent-soft"
          >
            <Icon icon={RepeatIcon} size={14} /> Sign like last time
          </button>
        </Tooltip>
      ) : null}
      {pdf ? (
        <button
          onClick={() => {
            onClose();
            fillSign(file);
          }}
          className={cn(ghostClass, !layout && "ml-auto")}
        >
          <Icon icon={FilePenIcon} size={14} /> Fill &amp; sign
        </button>
      ) : null}
      {open && canPreview(file.attachment) ? (
        <a href={open} target="_blank" rel="noopener noreferrer" className={cn(ghostClass, !(fillSign && file.attachment.kind === "pdf") && "ml-auto")}>
          <Icon icon={LinkSquare02Icon} size={14} /> Open in new tab
        </a>
      ) : null}
      {download ? (
        <a
          href={download}
          download={file.attachment.name}
          onClick={onDownloadClick(download, file.attachment.name)}
          className={cn(
            "flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90",
            !(open && canPreview(file.attachment)) && !(fillSign && file.attachment.kind === "pdf") && "ml-auto",
          )}
        >
          <Icon icon={Download04Icon} size={14} /> Download
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
  if (!canPreview(file.attachment)) {
    return <Placeholder file={file} text="Kite can't show this kind of file. Download it to open it in another app." />;
  }
  return (
    <div className="blur-fade grid h-[70vh] place-items-center border-t border-pane-border bg-pane-2">
      {file.attachment.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element -- local, same-origin attachment bytes
        <img src={url} alt={file.attachment.name} className="max-h-full max-w-full object-contain p-4" />
      ) : type.startsWith("audio/") ? (
        <audio src={url} controls className="w-[80%]" />
      ) : type.startsWith("video/") ? (
        <video src={url} controls className="max-h-full max-w-full" />
      ) : file.attachment.kind === "pdf" ? (
        // Chrome's PDF viewer refuses sandboxed frames; the route never serves PDFs as HTML.
        <iframe src={url} title={file.attachment.name} className="size-full border-0" />
      ) : (
        // Plain text: served with a sandbox CSP, framed with no permissions.
        <iframe src={url} title={file.attachment.name} sandbox="" className="size-full border-0 bg-white" />
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
  if (state?.url !== url) return <div className="h-40 border-t border-pane-border" />;
  if (!state.invite) return <Placeholder file={file} text="Kite couldn't read an event in this calendar file. Download it to open it in your calendar." />;
  return (
    <div className="blur-fade border-t border-pane-border px-5 py-5">
      <InviteSummary invite={state.invite} />
    </div>
  );
}

function Placeholder({ file, text }: { file: FileRef; text: string }) {
  return (
    <div className="blur-fade flex flex-col items-center gap-3 border-t border-pane-border px-6 py-14 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-pane-2 text-pane-muted">
        <Icon icon={FILE_ICONS[file.attachment.kind]} size={26} />
      </span>
      <p className="max-w-sm text-[12.5px] text-pane-muted">{text}</p>
    </div>
  );
}

const ghostClass = "flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg";
