"use client";

import { Fragment, useMemo, useState } from "react";
import { differenceInMinutes } from "date-fns";
import { paragraphs, snippetFresh, splitMessage, unwrap } from "@/lib/mail/quotes";
import type { Account, Message, Thread } from "@/lib/mail/types";
import { cn, formatFullDate } from "@/lib/utils";
import { Dialog } from "../ui/dialog";
import type { FileRef } from "../files/file-preview";
import { Avatar } from "./avatar";
import { EmailFrame } from "./email-frame";
import { PrivacyChip, useCleanHtml, useMessagePrivacy } from "./privacy-chip";
import { forkParent, replyingLabel, shortDate } from "./quote-card";
import { AttachmentChip, messageFiles } from "./thread-files";

/** Characters of new text before a bubble folds behind "Show more". */
const LONG_BUBBLE = 900;

/** A gap this long between messages shows the time again. */
const GAP_MINUTES = 60;

type Row = {
  message: Message;
  mine: boolean;
  /** First bubble of a run from the same sender. */
  groupStart: boolean;
  /** Last bubble of the run (the avatar sits beside it). */
  groupEnd: boolean;
  time: string | null;
  replyingTo: Message | null;
  replyingToMine: boolean;
};

function buildRows(thread: Thread, isMine: (m: Message) => boolean): Row[] {
  const messages = thread.messages;
  const rows = messages.map((message, i): Row => {
    const previous = messages[i - 1];
    const gap = !previous || Math.abs(differenceInMinutes(new Date(message.date), new Date(previous.date))) >= GAP_MINUTES;
    const sameSender = !!previous && previous.from.email.toLowerCase() === message.from.email.toLowerCase();
    const parent = forkParent(message, thread);
    return {
      message,
      mine: isMine(message),
      groupStart: gap || !sameSender,
      groupEnd: true,
      time: gap ? shortDate(message.date) : null,
      replyingTo: parent ?? null,
      replyingToMine: !!parent && isMine(parent),
    };
  });
  rows.forEach((row, i) => {
    const next = rows[i + 1];
    row.groupEnd = !next || next.groupStart;
  });
  return rows;
}

export function ChatThread({
  thread,
  account,
  unseen,
  highlight,
  onPreview,
}: {
  thread: Thread;
  account?: Account;
  unseen: Set<string>;
  highlight: string | null;
  onPreview: (file: FileRef) => void;
}) {
  const me = account?.email.toLowerCase();
  const rows = useMemo(
    () => buildRows(thread, (m) => m.from.name === "You" || (!!me && m.from.email.toLowerCase() === me)),
    [thread, me],
  );
  const [full, setFull] = useState<Message | null>(null);
  const firstNew = thread.messages.findIndex((m) => unseen.has(m.id));

  return (
    <div className="mt-5 flex flex-col">
      {rows.map((row, i) => (
        <Fragment key={row.message.id}>
          {i === firstNew && i > 0 ? (
            <div className="blur-fade my-3 flex items-center gap-3 text-[11.5px] font-medium text-accent" role="separator" aria-label="New messages">
              <span className="h-px flex-1 bg-accent/40" />
              New
              <span className="h-px flex-1 bg-accent/40" />
            </div>
          ) : null}
          {row.time ? <div className="mb-2 mt-4 text-center text-[11px] text-pane-muted first:mt-0">{row.time}</div> : null}
          <ChatBubble row={row} thread={thread} index={i} highlighted={highlight === row.message.id} onPreview={onPreview} onFull={() => setFull(row.message)} />
        </Fragment>
      ))}
      <FullMessage message={full} onClose={() => setFull(null)} />
    </div>
  );
}

function ChatBubble({
  row,
  thread,
  index,
  highlighted,
  onPreview,
  onFull,
}: {
  row: Row;
  thread: Thread;
  index: number;
  highlighted: boolean;
  onPreview: (file: FileRef) => void;
  onFull: () => void;
}) {
  const { message, mine } = row;
  const split = useMemo(() => splitMessage(message), [message]);
  const loaded = message.body.length > 0 || !!message.html;
  const fresh = loaded ? paragraphs(split.text.fresh) : [];
  const files = messageFiles(message, thread);
  // Something is folded away (quote, signature or formatting), so offer the original.
  const hidden = !!message.html || !!split.text.quoted || !!split.text.signature;
  // Automated mail can be pages long; fold it so the conversation stays readable.
  const long = split.text.fresh.length > LONG_BUBBLE;
  const [more, setMore] = useState(false);

  return (
    <div
      data-message-id={message.id}
      data-sensitive
      className={cn(
        "blur-fade-up flex scroll-mt-4 items-end gap-2",
        mine ? "flex-row-reverse" : "flex-row",
        row.groupStart ? "mt-2.5" : "mt-0.5",
      )}
      style={{ "--i": Math.min(index, 12) } as React.CSSProperties}
    >
      {mine ? null : row.groupEnd ? (
        <Avatar name={message.from.name} email={message.from.email} className="mb-0.5 size-7 text-[10px]" />
      ) : (
        <span className="w-7 shrink-0" />
      )}
      <div className={cn("flex min-w-0 max-w-[78%] flex-col gap-1", mine ? "items-end" : "items-start")}>
        {row.groupStart && !mine ? <span className="px-3 text-[11.5px] font-medium text-pane-muted">{message.from.name}</span> : null}
        {row.replyingTo ? (
          <div className={cn("max-w-full truncate border-pane-border px-3 text-[11.5px] text-pane-muted", mine ? "border-r-2" : "border-l-2")}>
            {replyingLabel(row.replyingTo, row.replyingToMine)}
          </div>
        ) : null}
        {fresh.length || !loaded || !files.length ? (
          <div
            title={formatFullDate(message.date)}
            className={cn(
              "font-reading flex max-w-full flex-col gap-2 whitespace-pre-line break-words rounded-2xl px-3.5 py-2 text-[14px] leading-relaxed transition-shadow duration-500",
              mine ? "bg-accent text-accent-fg" : "bg-pane-2 text-pane-fg",
              mine ? (row.groupStart ? "" : "rounded-tr-md") : row.groupStart ? "" : "rounded-tl-md",
              mine ? (row.groupEnd ? "" : "rounded-br-md") : row.groupEnd ? "" : "rounded-bl-md",
              highlighted && "ring-2 ring-accent/50 ring-offset-2 ring-offset-pane",
              long && !more && "max-h-72 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
            )}
          >
            {message.draft ? <span className="text-[11px] font-medium uppercase tracking-wide opacity-70">Draft</span> : null}
            {loaded ? (
              fresh.length ? (
                fresh.map((p, i) => <p key={i}>{unwrap(p)}</p>)
              ) : (
                <p className="italic opacity-70">No new text</p>
              )
            ) : (
              <p className="opacity-70">{snippetFresh(message.snippet ?? "")}</p>
            )}
          </div>
        ) : null}
        {files.length ? (
          <div className={cn("flex flex-wrap gap-1.5", mine && "justify-end")}>
            {files.map((file, i) => (
              <AttachmentChip key={`${file.attachment.partId ?? ""}:${file.attachment.name}`} file={file} index={i} onPreview={onPreview} />
            ))}
          </div>
        ) : null}
        {loaded && (hidden || long) ? (
          <div className="flex gap-3 px-3 text-[11.5px] text-pane-muted">
            {long ? (
              <button onClick={() => setMore((v) => !v)} className="underline-offset-2 hover:text-pane-fg hover:underline">
                {more ? "Show less" : "Show more"}
              </button>
            ) : null}
            {hidden ? (
              <button onClick={onFull} className="underline-offset-2 hover:text-pane-fg hover:underline">
                Show full message
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}


/** The original message, exactly as sent (HTML in the sandboxed frame). */
function FullMessage({ message, onClose }: { message: Message | null; onClose: () => void }) {
  const [shown, setShown] = useState<Message | null>(message);
  // Keep the last message while the dialog animates out.
  if (message && message !== shown) setShown(message);
  const current = message ?? shown;

  return (
    <Dialog
      open={!!message}
      onClose={onClose}
      title={current ? `${current.from.name} <${current.from.email}>` : ""}
      description={current ? `${formatFullDate(current.date)} · To: ${current.to.map((c) => c.email).join(", ")}` : undefined}
      stage
      sensitive
      className="w-[min(820px,calc(100vw-32px))]"
    >
      {current ? <FullMessageBody key={current.id} message={current} /> : null}
    </Dialog>
  );
}

function FullMessageBody({ message }: { message: Message }) {
  const privacy = useMessagePrivacy(message);
  const html = useCleanHtml(message.html ?? "");
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mb-2 flex justify-end">
        <PrivacyChip message={message} state={privacy} />
      </div>
      {message.html ? (
        <EmailFrame html={html} loadRemote={privacy.loadRemote} />
      ) : (
        <div className="flex flex-col gap-3 whitespace-pre-line text-[14px] leading-relaxed">
          {message.body.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </div>
      )}
    </div>
  );
}
