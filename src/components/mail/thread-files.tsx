"use client";

import { onDownloadClick } from "@/lib/mail/download";
import { useState } from "react";
import { ArrowDown01Icon, Download04Icon, Target02Icon } from "@hugeicons/core-free-icons";
import { AnimatePresence, motion } from "motion/react";
import { canPreview } from "@/lib/mail/attachments";
import type { Message, Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { EASE_OUT, exitFor, spring } from "@/lib/motion";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { FileThumb, fileUrl, type FileRef } from "../files/file-preview";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
/** A file plus the message it arrived in. */
type ThreadFile = FileRef & { message: Message };

/** Files a message carries (inline images are part of the body, not files). */
export function messageFiles(message: Message, thread: Thread): FileRef[] {
  return (message.attachments ?? [])
    .filter((a) => !a.inline)
    .map((attachment) => ({ accountId: thread.accountId, messageId: thread.remoteId ? message.id : null, attachment, subject: thread.subject, threadId: thread.id, from: message.from }));
}

/**
 * Same file, another version: "proposal.pdf", "proposal (1).pdf", "Proposal_v2.pdf" and
 * "proposal-final.pdf" share a key. The extension stays part of it, so a .docx and its .pdf don't merge.
 */
function versionKey(name: string) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot).toLowerCase() : "";
  const base = (dot > 0 ? name.slice(0, dot) : name)
    .toLowerCase()
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[\s_-]*(v|ver|version|rev)\s*\d+(\.\d+)*$/, "")
    .replace(/[\s_-]*(final|copy|updated|latest|draft|revised)$/, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
  return base + ext;
}

/** Newest version first in each group; groups ordered by their newest file. */
function groupThreadFiles(thread: Thread): ThreadFile[][] {
  const groups = new Map<string, ThreadFile[]>();
  for (const message of thread.messages) {
    for (const file of messageFiles(message, thread)) {
      const key = versionKey(file.attachment.name);
      groups.set(key, [...(groups.get(key) ?? []), { ...file, message }]);
    }
  }
  return [...groups.values()]
    .map((files) => files.sort((a, b) => b.message.date.localeCompare(a.message.date)))
    .sort((a, b) => b[0].message.date.localeCompare(a[0].message.date));
}

function openFile(file: FileRef, onPreview: (file: FileRef) => void) {
  const download = fileUrl(file, true);
  if (download && !canPreview(file.attachment)) window.location.assign(download);
  else onPreview(file);
}

/** Opening and closing the files panel: height and a blur fade, moderate in, a tier quicker out. */
const PANEL = {
  initial: { height: 0, opacity: 0, filter: "blur(4px)" },
  animate: { height: "auto", opacity: 1, filter: "blur(0px)", transition: { ...spring.moderate, opacity: { duration: 0.16, ease: EASE_OUT } } },
  exit: { height: 0, opacity: 0, filter: "blur(4px)", transition: exitFor.moderate },
} as const;

/** Every file in the conversation, versions grouped, sliding open under the subject from the files pill. */
export function ThreadFiles({ thread, open, onPreview, onJump }: { thread: Thread; open: boolean; onPreview: (file: FileRef) => void; onJump: (messageId: string) => void }) {
  return (
    <AnimatePresence initial={false}>
      {open ? (
        <motion.div key="files" {...PANEL} className="overflow-hidden">
          <FileGroups thread={thread} onPreview={onPreview} onJump={onJump} />
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function FileGroups({ thread, onPreview, onJump }: { thread: Thread; onPreview: (file: FileRef) => void; onJump: (messageId: string) => void }) {
  const groups = groupThreadFiles(thread);
  const [openKey, setOpenKey] = useState<string | null>(null);
  if (!groups.length) return null;
  const open = groups.find((g) => versionKey(g[0].attachment.name) === openKey);

  return (
    <div className="pt-3">
      {/* Same-width cards that fill the row and shrink with the pane; long names truncate, the tooltip has the full name. */}
      <FluidList axis="xy" tone="pane" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2">
        {groups.map((group, i) => {
          const latest = group[0];
          const key = versionKey(latest.attachment.name);
          return (
            <div
              key={key}
              {...FLUID_ITEM}
              className="blur-fade-up group relative flex min-w-0 items-center rounded-xl border border-pane-border"
              style={{ "--i": i } as React.CSSProperties}
            >
              <Tooltip label={latest.attachment.name} className="flex min-w-0 flex-1">
              <button onClick={() => openFile(latest, onPreview)} className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2 pr-1 text-left">
                <FileThumb file={latest} className="size-8 shrink-0 overflow-hidden rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="block min-w-0 truncate text-[12.5px] font-medium">{latest.attachment.name}</span>
                    {group.length > 1 ? (
                      <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-[10.5px] font-medium text-accent">Latest</span>
                    ) : null}
                  </span>
                  <span className="block truncate text-[11px] text-pane-muted">
                    {latest.attachment.size} · {latest.message.from.name} · {formatListDate(latest.message.date)}
                  </span>
                </span>
              </button>
              </Tooltip>
              {group.length > 1 ? (
                <Tooltip label={openKey === key ? "Hide older versions" : "Show older versions"}>
                  <button
                    aria-label={`${group.length - 1} older version${group.length > 2 ? "s" : ""}`}
                    aria-expanded={openKey === key}
                    onClick={() => setOpenKey(openKey === key ? null : key)}
                    className="flex h-7 items-center gap-0.5 rounded-full px-1.5 text-[11px] text-pane-muted hover:bg-pane-2 hover:text-pane-fg"
                  >
                    {group.length - 1} older
                    <Icon icon={ArrowDown01Icon} size={12} className={cn("transition-transform", openKey === key && "rotate-180")} />
                  </button>
                </Tooltip>
              ) : null}
              <JumpButton onClick={() => onJump(latest.message.id)} />
              <DownloadLink file={latest} />
            </div>
          );
        })}
      </FluidList>
      {open ? (
        <div key={openKey} className="blur-fade-down mt-2 flex flex-col gap-0.5 rounded-xl border border-pane-border bg-pane p-1.5">
          <div className="px-2 pb-1 pt-0.5 text-[11px] text-pane-muted">Older versions of {open[0].attachment.name}</div>
          <FluidList tone="pane" className="flex flex-col gap-0.5">
          {open.slice(1).map((file, i) => (
            <div
              key={`${file.message.id}:${file.attachment.partId ?? file.attachment.name}`}
              {...FLUID_ITEM}
              className="blur-fade-up group relative flex items-center gap-2 rounded-lg pr-1"
              style={{ "--i": i } as React.CSSProperties}
            >
              <button onClick={() => openFile(file, onPreview)} className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left">
                <FileThumb file={file} size={16} className="size-6 shrink-0 overflow-hidden rounded-md" />
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{file.attachment.name}</span>
                <span className="shrink-0 text-[11.5px] text-pane-muted">
                  {file.attachment.size} · {file.message.from.name} · {formatListDate(file.message.date)}
                </span>
              </button>
              <JumpButton onClick={() => onJump(file.message.id)} />
              <DownloadLink file={file} />
            </div>
          ))}
          </FluidList>
        </div>
      ) : null}
    </div>
  );
}

function JumpButton({ onClick }: { onClick: () => void }) {
  return (
    <Tooltip label="Jump to message">
      <button
        aria-label="Jump to message"
        onClick={onClick}
        className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted opacity-0 transition-opacity hover:bg-pane-2 hover:text-pane-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Target02Icon} size={14} />
      </button>
    </Tooltip>
  );
}

function DownloadLink({ file }: { file: FileRef }) {
  const download = fileUrl(file, true);
  if (!download) return <span className="w-1.5" />;
  return (
    <Tooltip label="Download">
      <a
        href={download}
        download={file.attachment.name}
        onClick={onDownloadClick(download, file.attachment.name)}
        aria-label={`Download ${file.attachment.name}`}
        className="mr-1.5 grid size-7 shrink-0 place-items-center rounded-full text-pane-muted opacity-0 transition-opacity hover:bg-pane-2 hover:text-pane-fg focus-visible:opacity-100 group-hover:opacity-100"
      >
        <Icon icon={Download04Icon} size={14} />
      </a>
    </Tooltip>
  );
}

/** One file under a message: opens a preview for files the browser can show; anything else downloads. */
export function AttachmentChip({ file, index, onPreview }: { file: FileRef; index: number; onPreview: (file: FileRef) => void }) {
  return (
    <div
      className="blur-fade-up group flex items-center rounded-xl border border-pane-border bg-pane transition-colors hover:bg-pane-hover"
      style={{ "--i": index } as React.CSSProperties}
    >
      <button onClick={() => openFile(file, onPreview)} className="flex min-w-0 items-center gap-2.5 py-2 pl-2 pr-1 text-left">
        <FileThumb file={file} className="size-8 shrink-0 overflow-hidden rounded-lg" />
        <span className="min-w-0">
          <span className="block max-w-56 truncate text-[12.5px] font-medium">{file.attachment.name}</span>
          <span className="block text-[11px] text-pane-muted">{file.attachment.size}</span>
        </span>
      </button>
      <DownloadLink file={file} />
    </div>
  );
}
