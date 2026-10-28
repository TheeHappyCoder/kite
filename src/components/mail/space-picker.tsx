"use client";

import { useRef, useState } from "react";
import { Command } from "cmdk";
import { Add01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { Thread } from "@/lib/mail/types";
import { spaceLabel, spaceTree, type Space } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Spinner } from "../ui/spinner";
import { FluidList } from "../ui/fluid-hover";

/** A space's mark: its colour as a dot (a pocket's a ring, so the two read apart). */
export function SpaceDot({ space, className }: { space: Pick<Space, "color" | "parentId">; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", space.parentId && "border-2 bg-transparent", className)}
      style={space.parentId ? { borderColor: space.color } : { background: space.color }}
    />
  );
}

/**
 * "Add to a space" (`y`; `Shift+Y` opens it to move): every space and pocket, recent ones first while
 * nothing is typed. Enter adds, Shift+Enter moves (adds, then archives). A name nobody has yet makes
 * a space; "Acme / Website" makes the pocket Website inside Acme.
 */
export function SpacePicker({
  threads,
  move: moveFirst,
  spaces,
  recent,
  onClose,
  onPick,
  onCreate,
}: {
  /** Null when closed. */
  threads: Thread[] | null;
  /** Opened to move (Shift+Y, "Move to space…"). */
  move: boolean;
  spaces: Space[];
  /** Space ids picked lately, newest first. */
  recent: string[];
  onClose: () => void;
  /** `remove`: every one of them was in it already, so picking it takes them out. */
  onPick: (spaceId: string, how: { move: boolean; remove: boolean }) => void;
  onCreate: (name: string, parentId: string | null) => Promise<Space | null>;
}) {
  const [query, setQuery] = useState("");
  const [making, setMaking] = useState(false);
  const shift = useRef(false);
  const open = !!threads?.length;
  const typed = query.trim();
  const close = () => {
    setQuery("");
    onClose();
  };
  const tree = spaceTree(spaces);
  const inIt = (id: string) => threads?.filter((t) => t.spaces?.includes(id)).length ?? 0;
  const recents = typed ? [] : recent.flatMap((id) => spaces.find((s) => s.id === id) ?? []).slice(0, 4);

  // "Acme / Website": the part before the last slash names a space that's there.
  const parts = typed.split("/").map((p) => p.trim()).filter(Boolean);
  const parent = parts.length > 1 ? tree.find(({ space }) => spaceLabel(spaces, space.id).toLowerCase() === parts.slice(0, -1).join(" / ").toLowerCase())?.space : undefined;
  const newName = parent ? parts[parts.length - 1] : typed;
  const exists = spaces.some((s) => spaceLabel(spaces, s.id).toLowerCase() === typed.toLowerCase().replace(/\s*\/\s*/g, " / "));
  const canMake = !!typed && !exists && (parts.length === 1 || !!parent) && newName.length <= 80;

  const pick = (id: string) => {
    const all = !!threads && inIt(id) === threads.length;
    const move = moveFirst !== shift.current;
    onPick(id, { move, remove: all && !move });
    close();
  };
  const make = async () => {
    if (making || !canMake) return;
    setMaking(true);
    const move = moveFirst !== shift.current;
    const made = await onCreate(newName, parent?.id ?? null);
    setMaking(false);
    if (!made) return;
    onPick(made.id, { move, remove: false });
    close();
  };

  const row = (space: Space, depth: number, key: string) => {
    const n = inIt(space.id);
    const all = !!threads && n === threads.length;
    return (
      <Command.Item
        key={key}
        value={`${key} ${spaceLabel(spaces, space.id)}`}
        onSelect={() => pick(space.id)}
        className="relative flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13px] touch:h-11"
      >
        <span style={{ paddingLeft: typed ? 0 : depth * 14 }} className="flex min-w-0 flex-1 items-center gap-2.5">
          <SpaceDot space={space} />
          <span className="min-w-0 flex-1 truncate">{typed || key.startsWith("recent") ? spaceLabel(spaces, space.id) : space.name}</span>
        </span>
        {n ? <Icon icon={Tick02Icon} size={13} className={cn("shrink-0", all ? "text-accent" : "text-pane-muted")} /> : null}
      </Command.Item>
    );
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      onKeyDown={(e) => {
        shift.current = e.shiftKey;
      }}
      label={moveFirst ? "Move to a space" : "Add to a space"}
      overlayClassName="blur-fade fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px]"
      contentClassName="blur-fade-down fixed inset-x-0 top-[18%] z-50 mx-auto w-[440px] max-w-[calc(100vw-32px)] overflow-hidden rounded-2xl border border-pane-border bg-pane text-pane-fg shadow-2xl"
    >
      <div className="border-b border-pane-border px-4 pb-2 pt-3">
        <p className="truncate text-[12px] text-pane-muted">
          {moveFirst ? "Move " : "Add "}
          {threads && threads.length > 1 ? `${threads.length} conversations` : `“${threads?.[0]?.subject ?? ""}”`}
        </p>
      </div>
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder={spaces.length ? "Find a space, or name a new one…" : "Name your first space, like a client…"}
        className="h-12 w-full border-b border-pane-border bg-transparent px-4 text-[14px] outline-none placeholder:text-pane-muted"
      />
      <Command.List className="scroll-fade max-h-[340px] overflow-y-auto p-2 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider [&_[cmdk-group-heading]]:text-pane-muted">
        <Command.Empty className="px-3 py-6 text-center text-[13px] text-pane-muted">{spaces.length ? "No spaces match." : "No spaces yet. Type a name to make one."}</Command.Empty>
        <FluidList tone="pane" follow="[data-selected=true]">
          {recents.length ? <Command.Group heading="Recent">{recents.map((s) => row(s, 0, `recent:${s.id}`))}</Command.Group> : null}
          {tree.length ? (
            <Command.Group heading={recents.length ? "All spaces" : undefined}>{tree.map(({ space, depth }) => row(space, depth, space.id))}</Command.Group>
          ) : null}
          {canMake ? (
            <Command.Item
              forceMount
              value={`make ${typed}`}
              disabled={making}
              onSelect={() => void make()}
              className="relative flex h-9 cursor-default items-center gap-2.5 rounded-lg px-2.5 text-[13px] touch:h-11"
            >
              <span className="grid size-4 shrink-0 place-items-center text-accent">{making ? <Spinner size={13} /> : <Icon icon={Add01Icon} size={14} />}</span>
              <span className="min-w-0 flex-1 truncate">
                {parent ? (
                  <>
                    Make the pocket <span className="font-medium">“{newName}”</span> in {parent.name}
                  </>
                ) : (
                  <>
                    Make the space <span className="font-medium">“{newName}”</span>
                  </>
                )}
              </span>
            </Command.Item>
          ) : null}
        </FluidList>
      </Command.List>
      <p className="border-t border-pane-border px-4 py-2 text-[11.5px] text-pane-muted">
        {moveFirst ? "Enter moves it out of the Inbox too; Shift+Enter only adds." : "Enter adds; Shift+Enter also moves it out of the Inbox."} Spaces live only in Kite.
      </p>
    </Command.Dialog>
  );
}
