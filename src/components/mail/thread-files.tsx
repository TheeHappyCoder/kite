"use client";

import { onDownloadClick, saveAttachment } from "@/lib/mail/download";
import { formatBytes } from "@/lib/format";
import { useState } from "react";
import { ArrowDown01Icon, Attachment01Icon, Cancel01Icon, Download04Icon, Target02Icon } from "@hugeicons/core-free-icons";
import { AnimatePresence, motion } from "motion/react";
import { canPreview, officePreview } from "@/lib/mail/attachments";
import { fileType, type FileType } from "../files/file-icon";
import type { Message, Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { blurFade } from "@/lib/motion";
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
  if (download && !canPreview(file.attachment) && !officePreview(file.attachment)) window.location.assign(download);
  else onPreview(file);
}

/** The drawer's filter pills, shown once a conversation has this many files. */
const FILTER_FROM = 6;
const FILTERS: { id: string; label: string; types: FileType[] | null }[] = [
  { id: "all", label: "All", types: null },
  { id: "docs", label: "Documents", types: ["word", "sheet", "slides", "text"] },
  { id: "pdf", label: "PDFs", types: ["pdf"] },
  { id: "images", label: "Images", types: ["image"] },
];

/**
 * Every file in the conversation, versions grouped: a drawer over the reader's right side, from the
 * paperclip in the toolbar or "N files" under the subject. It floats over the text instead of narrowing it.
 */
export function FilesDrawer({ thread, open, onClose, onPreview, onJump }: { thread: Thread; open: boolean; onClose: () => void; onPreview: (file: FileRef) => void; onJump: (messageId: string) => void }) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.aside
          key="files"
          {...blurFade({ x: 24, blur: 4, speed: "moderate" })}
          aria-label="Files in this conversation"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              onClose();
            }
          }}
          className="pane-on-sky absolute bottom-2 right-2 top-2 z-20 flex w-[min(360px,calc(100%-16px))] flex-col overflow-hidden rounded-2xl border border-pane-border bg-pane"
        >
          <DrawerBody
            thread={thread}
            onClose={onClose}
            onPreview={onPreview}
            onJump={(id) => {
              onClose();
              onJump(id);
            }}
          />
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}

function DrawerBody({ thread, onClose, onPreview, onJump }: { thread: Thread; onClose: () => void; onPreview: (file: FileRef) => void; onJump: (messageId: string) => void }) {
  const groups = groupThreadFiles(thread);
  const all = groups.flat();
  const [filter, setFilter] = useState("all");
  const typeOf = (file: ThreadFile) => fileType(file.attachment.name, file.attachment.mimeType);
  // Pills only for a long list, and only kinds it has; "All" plus one kind isn't worth a row.
  const filters = all.length >= FILTER_FROM ? FILTERS.filter((f) => !f.types || all.some((file) => f.types!.includes(typeOf(file)))) : [];
  const types = filters.length > 2 ? FILTERS.find((f) => f.id === filter)?.types : null;
  const shown = types ? groups.filter((g) => types.includes(typeOf(g[0]))) : groups;
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 px-4 pb-2 pt-3.5">
        <p className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          Files <span className="font-normal text-pane-muted">· {all.length}</span>
        </p>
        <DownloadAll files={all} />
        <Tooltip label="Close">
          <button autoFocus aria-label="Close" onClick={onClose} className="grid size-7 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
            <Icon icon={Cancel01Icon} size={14} />
          </button>
        </Tooltip>
      </div>
      {filters.length > 2 ? (
        <FluidList axis="x" tone="pill" className="flex shrink-0 gap-1 px-3 pb-2">
          {filters.map((f) => (
            <button
              key={f.id}
              {...FLUID_ITEM}
              onClick={() => setFilter(f.id)}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-[11.5px] transition-[background-color,color] duration-150",
                filter === f.id ? "bg-pane-selected font-semibold text-pane-fg" : "text-pane-muted",
              )}
            >
              {f.label}
            </button>
          ))}
        </FluidList>
      ) : null}
      <div className="scroll-fade flex min-h-0 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {shown.map((group, i) => (
          <DrawerFile key={versionKey(group[0].attachment.name)} group={group} index={i} onPreview={onPreview} onJump={onJump} />
        ))}
      </div>
    </>
  );
}

/** On the drawer's dark cards: round ink buttons that show while the card is hovered or focused. */
const INK_BUTTON = "mr-0 size-8 bg-frame text-frame-fg opacity-0 shadow-[0_1px_3px_rgba(0,0,0,0.25)] hover:bg-frame-hover hover:text-frame-fg group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100";

/**
 * One file in the drawer, on a dark ink card: a big first page or picture for PDFs and images, a row for
 * the rest. Jump and Download float in the corner on hover; older versions fold under it.
 */
function DrawerFile({ group, index, onPreview, onJump }: { group: ThreadFile[]; index: number; onPreview: (file: FileRef) => void; onJump: (messageId: string) => void }) {
  const [older, setOlder] = useState(false);
  const latest = group[0];
  const type = fileType(latest.attachment.name, latest.attachment.mimeType);
  const big = type === "pdf" || (type === "image" && canPreview(latest.attachment));
  return (
    <div className="ink-chrome blur-fade-up group relative shrink-0 overflow-hidden rounded-xl bg-frame text-frame-fg" style={{ "--i": index } as React.CSSProperties}>
      <div className="flex min-w-0">
          <button
            onClick={() => openFile(latest, onPreview)}
            className={cn("flex min-w-0 flex-1 text-left transition-colors duration-150 hover:bg-frame-hover hover:transition-none", big ? "flex-col gap-2 p-2" : "items-center gap-2.5 p-2")}
          >
            {big ? (
              <FileThumb file={latest} size={40} className="h-32 w-full overflow-hidden rounded-lg bg-frame-hover" />
            ) : (
              <FileThumb file={latest} size={26} className="size-9 shrink-0 overflow-hidden rounded-lg" />
            )}
            <span className={cn("block min-w-0", big && "px-1 pb-0.5")}>
              <span className="block truncate text-[12.5px] font-medium">{latest.attachment.name}</span>
              <span className="block truncate text-[11px] text-frame-muted">
                {latest.attachment.size} · {latest.message.from.name} · {formatListDate(latest.message.date)}
              </span>
            </span>
          </button>
      </div>
      <div className={cn("absolute right-2 flex gap-1", big ? "top-3.5" : "top-1/2 -translate-y-1/2")}>
        <JumpButton onClick={() => onJump(latest.message.id)} className={INK_BUTTON} />
        <DownloadLink file={latest} className={INK_BUTTON} />
      </div>
      {group.length > 1 ? (
        <button
          aria-expanded={older}
          onClick={() => setOlder((v) => !v)}
          className="mx-2 mb-2 flex h-6 items-center gap-0.5 rounded-full px-2 text-[11px] font-medium text-frame-muted hover:bg-frame-hover hover:text-frame-fg"
        >
          {group.length - 1} older version{group.length > 2 ? "s" : ""}
          <Icon icon={ArrowDown01Icon} size={12} className={cn("transition-transform", older && "rotate-180")} />
        </button>
      ) : null}
      {older ? (
        <div className="blur-fade-down flex flex-col gap-0.5 border-t border-frame-border p-1.5">
          {group.slice(1).map((file) => (
            <div key={`${file.message.id}:${file.attachment.partId ?? file.attachment.name}`} className="relative flex items-center rounded-lg hover:bg-frame-hover">
              <button onClick={() => openFile(file, onPreview)} className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left">
                <FileThumb file={file} size={14} className="size-6 shrink-0 overflow-hidden rounded-md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px]">{file.attachment.name}</span>
                  <span className="block truncate text-[11px] text-frame-muted">
                    {file.attachment.size} · {file.message.from.name} · {formatListDate(file.message.date)}
                  </span>
                </span>
              </button>
              <JumpButton onClick={() => onJump(file.message.id)} className={cn(INK_BUTTON, "size-7 bg-transparent text-frame-muted opacity-100 shadow-none")} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function JumpButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <Tooltip label="Jump to message">
      <button
        aria-label="Jump to message"
        onClick={onClick}
        className={cn("grid size-7 shrink-0 place-items-center rounded-full text-pane-muted opacity-0 transition-opacity hover:bg-pane-2 hover:text-pane-fg focus-visible:opacity-100 group-hover:opacity-100", className)}
      >
        <Icon icon={Target02Icon} size={16} />
      </button>
    </Tooltip>
  );
}

function DownloadLink({ file, className }: { file: FileRef; className?: string }) {
  const download = fileUrl(file, true);
  if (!download) return <span className="w-1.5" />;
  return (
    <Tooltip label="Download">
      <a
        href={download}
        download={file.attachment.name}
        onClick={onDownloadClick(download, file.attachment.name)}
        aria-label={`Download ${file.attachment.name}`}
        className={cn("mr-1.5 grid size-7 shrink-0 place-items-center rounded-full text-pane-muted opacity-0 transition-opacity hover:bg-pane-2 hover:text-pane-fg focus-visible:opacity-100 group-hover:opacity-100", className)}
      >
        <Icon icon={Download04Icon} size={16} />
      </a>
    </Tooltip>
  );
}

/** Bytes of these files together, when every one says how big it is. */
function totalSize(files: FileRef[]) {
  return files.every((f) => f.attachment.bytes) ? formatBytes(files.reduce((n, f) => n + f.attachment.bytes!, 0)) : null;
}

/** Saves every file, one after another (each through `saveAttachment`, so a failure says why). */
function DownloadAll({ files }: { files: FileRef[] }) {
  const links = files.flatMap((file) => {
    const url = fileUrl(file, true);
    return url ? [{ url, name: file.attachment.name }] : [];
  });
  if (links.length < 2) return null;
  return (
    <button
      onClick={async () => {
        for (const link of links) await saveAttachment(link.url, link.name);
      }}
      className="shrink-0 rounded-full px-2 py-0.5 text-[12px] font-medium text-accent hover:bg-accent-soft"
    >
      Download all
    </button>
  );
}

/** The files a message carries, at its end: a quiet line (how many, how big, Download all) over a grid of cards. */
export function MessageFiles({ files, onPreview }: { files: FileRef[]; onPreview: (file: FileRef) => void }) {
  const size = totalSize(files);
  return (
    <div className="mt-5 border-t border-pane-border pt-3">
      <div className="mb-2 flex min-w-0 items-center gap-1.5 text-[12px] text-pane-muted">
        <Icon icon={Attachment01Icon} size={13} className="shrink-0" />
        <span className="min-w-0 truncate">
          {files.length} file{files.length > 1 ? "s" : ""}
          {size ? ` · ${size}` : ""}
        </span>
        <span className="flex-1" />
        <DownloadAll files={files} />
      </div>
      <FluidList axis="xy" tone="pane" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12.5rem),1fr))] gap-2">
        {files.map((file, i) => (
          <div
            key={`${file.attachment.partId ?? ""}:${file.attachment.name}`}
            {...FLUID_ITEM}
            className="blur-fade-up group relative flex min-w-0 items-center rounded-xl border border-pane-border"
            style={{ "--i": i } as React.CSSProperties}
          >
            <Tooltip label={file.attachment.name} className="flex min-w-0 flex-1">
              <button onClick={() => openFile(file, onPreview)} className="flex min-w-0 flex-1 items-center gap-2.5 py-2 pl-2 pr-1 text-left">
                <FileThumb file={file} size={24} className="size-9 shrink-0 overflow-hidden rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium">{file.attachment.name}</span>
                  <span className="block truncate text-[11px] text-pane-muted">{file.attachment.size}</span>
                </span>
              </button>
            </Tooltip>
            <DownloadLink file={file} />
          </div>
        ))}
      </FluidList>
    </div>
  );
}

/** One file in a chat bubble: opens a preview for files the browser can show; anything else downloads. */
export function AttachmentChip({ file, index, onPreview }: { file: FileRef; index: number; onPreview: (file: FileRef) => void }) {
  return (
    <div
      className="blur-fade-up group flex items-center rounded-xl border border-pane-border bg-pane transition-colors hover:bg-pane-hover"
      style={{ "--i": index } as React.CSSProperties}
    >
      <button onClick={() => openFile(file, onPreview)} className="flex min-w-0 items-center gap-2.5 py-2 pl-2 pr-1 text-left">
        <FileThumb file={file} size={24} className="size-9 shrink-0 overflow-hidden rounded-lg" />
        <span className="min-w-0">
          <span className="block max-w-56 truncate text-[12.5px] font-medium">{file.attachment.name}</span>
          <span className="block text-[11px] text-pane-muted">{file.attachment.size}</span>
        </span>
      </button>
      <DownloadLink file={file} />
    </div>
  );
}
