"use client";

import { useState } from "react";
import { CrownIcon, Folder02Icon, UserGroupIcon } from "@hugeicons/core-free-icons";
import type { FileItem } from "@/lib/mail/types";
import type { SpacePerson } from "@/lib/spaces";
import { plural } from "@/lib/format";
import { formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { FilePreview, FileThumb, type FileRef } from "../files/file-preview";
import { Avatar } from "./avatar";

// A space's Files and People tabs (space-tabs.tsx), worked out from the conversations the space's
// list already holds (the slim list copy keeps attachments and who each message went to).

const refOf = (file: FileItem): FileRef => ({
  accountId: file.accountId,
  // Demo mail has nothing to download (no part ids).
  messageId: file.partId ? file.messageId : null,
  attachment: file,
  subject: file.subject,
  threadId: file.threadId,
  from: file.from,
});

/** The files in a space's conversations, newest first, as All files shows them; a click previews. */
export function SpaceFiles({ files, onOpenConversation }: { files: FileItem[]; onOpenConversation: (threadId: string) => void }) {
  const [preview, setPreview] = useState<FileRef | null>(null);
  if (!files.length) return <Empty icon={Folder02Icon} title="No files here yet" note="Attachments in this space's conversations show up here, its pockets' too." />;
  return (
    <div className="@container px-1 pt-1">
      <FluidList axis="xy" tone="pane" className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5 @max-[340px]:grid-cols-1 @max-[340px]:gap-1">
        {files.map((file, i) => {
          const ref = refOf(file);
          return (
            <button
              key={`${file.messageId}:${file.partId ?? file.name}`}
              {...FLUID_ITEM}
              onClick={() => setPreview(ref)}
              style={{ "--i": Math.min(i, 16) } as React.CSSProperties}
              className="blur-fade-up group relative flex flex-col overflow-hidden rounded-xl border border-pane-border text-left transition-[background-color,border-color] duration-150 data-[lit]:border-accent/50 @max-[340px]:flex-row @max-[340px]:items-center @max-[340px]:gap-3 @max-[340px]:border-transparent @max-[340px]:p-1.5 @max-[340px]:data-[lit]:bg-pane-hover"
            >
              <FileThumb file={ref} size={26} className="h-[96px] w-full bg-pane-2 transition-transform duration-300 group-hover:scale-[1.02] @max-[340px]:size-11 @max-[340px]:shrink-0 @max-[340px]:rounded-lg @max-[340px]:group-hover:scale-100" />
              <span className="flex min-w-0 flex-col gap-0.5 px-3 py-2.5 @max-[340px]:p-0">
                <span data-sensitive className="truncate text-[12.5px] font-medium" title={file.name}>
                  {file.name}
                </span>
                <span data-sensitive className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-pane-muted">
                  <span className="truncate">{file.from.name || file.from.email}</span>
                  <span className="shrink-0">· {formatListDate(file.date)}</span>
                </span>
                <span className="text-[11px] text-pane-muted/80">{file.size}</span>
              </span>
            </button>
          );
        })}
      </FluidList>
      <FilePreview file={preview} onClose={() => setPreview(null)} openLabel="Open conversation" onOpenEmail={(file) => file.threadId && onOpenConversation(file.threadId)} />
    </div>
  );
}

/** Everyone in a space's conversations but you: how many conversations, the last one, VIP crown. A click opens them in Contacts. */
export function SpacePeople({ people, vips, onOpenPerson }: { people: SpacePerson[]; vips: Set<string>; onOpenPerson: (email: string) => void }) {
  if (!people.length) return <Empty icon={UserGroupIcon} title="Nobody here yet" note="The people in this space's conversations show up here." />;
  return (
    <div className="@container">
      <FluidList tone="pane" className="flex flex-col">
        {people.map((person, i) => (
          <button
            key={person.email}
            {...FLUID_ITEM}
            onClick={() => onOpenPerson(person.email)}
            style={{ "--i": Math.min(i, 16) } as React.CSSProperties}
            className="blur-fade-up relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-[background-color] duration-150 touch:py-3"
          >
            <Avatar name={person.name || person.email} email={person.email} className="size-9 text-[11.5px]" />
            <span className="min-w-0 flex-1" data-sensitive>
              <span className="flex items-center gap-1.5">
                <span className="truncate text-[14px] font-medium">{person.name || person.email}</span>
                {vips.has(person.email) ? <Icon icon={CrownIcon} size={12} className="shrink-0 fill-warning text-warning" /> : null}
              </span>
              <span className="block truncate text-[12.5px] text-pane-muted">
                {person.name ? person.email : null}
                <span className="hidden @max-[360px]:inline">
                  {person.name ? " · " : ""}
                  {plural(person.conversations, "conversation")}
                </span>
              </span>
            </span>
            <span className="flex shrink-0 flex-col items-end gap-0.5 text-[12px] tabular-nums text-pane-muted">
              <span className="@max-[360px]:hidden">{plural(person.conversations, "conversation")}</span>
              <span>{person.last ? formatListDate(person.last) : ""}</span>
            </span>
          </button>
        ))}
      </FluidList>
    </div>
  );
}

function Empty({ icon, title, note }: { icon: typeof Folder02Icon; title: string; note: string }) {
  return (
    <div className="blur-fade flex flex-col items-center gap-2 px-6 py-16 text-center">
      <Icon icon={icon} size={26} className="text-pane-muted opacity-60" />
      <p className="text-[13px] font-medium">{title}</p>
      <p className="max-w-xs text-[12px] text-pane-muted">{note}</p>
    </div>
  );
}
