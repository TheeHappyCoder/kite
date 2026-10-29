"use client";

import { useEffect, useRef, useState } from "react";
import { Add01Icon, ArrowRight01Icon, Delete02Icon, Folder02Icon, MoreHorizontalIcon, Note01Icon, PencilEdit02Icon } from "@hugeicons/core-free-icons";
import { SPACE_COLORS, SPACE_DEPTH, spacePath, type Space, type SpacePatch } from "@/lib/spaces";
import { ContextMenu, type MenuItem, type MenuPoint } from "../ui/context-menu";
import { plural } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { SpaceDot } from "./space-picker";

export type SpaceHeaderActions = {
  open: (id: string) => void;
  createPocket: (parentId: string, name: string) => void;
  update: (id: string, patch: SpacePatch) => void;
  /** Deletes it and its pockets (with Undo); the mail stays where it is. */
  remove: (id: string) => void;
  /** The People tab: opens Contacts on this person. */
  openPerson: (email: string) => void;
};

/**
 * Over a space's conversations: where it sits (Acme › Website), its pockets as pills with a way to
 * make another, and its private note. Everything here lives only in Kite.
 */
export function SpaceHeader({ spaceId, spaces, count, actions }: { spaceId: string; spaces: Space[]; count: number; actions: SpaceHeaderActions }) {
  const space = spaces.find((s) => s.id === spaceId);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState("");
  const [noting, setNoting] = useState(false);
  const [menu, setMenu] = useState<MenuPoint | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  if (!space) return null;
  const rename = () => {
    if (renaming?.trim() && renaming.trim() !== space.name) actions.update(space.id, { name: renaming.trim() });
    setRenaming(null);
  };
  const items: MenuItem[] = [
    { id: "rename", label: "Rename", icon: PencilEdit02Icon, onSelect: () => setRenaming(space.name) },
    {
      id: "colour",
      label: "Colour",
      icon: Folder02Icon,
      submenu: SPACE_COLORS.map((color) => ({
        id: color,
        label: color === space.color ? "This one" : "Use this colour",
        leading: <span className="size-3 shrink-0 rounded-full" style={{ background: color }} />,
        checked: color === space.color,
        onSelect: () => actions.update(space.id, { color }),
      })),
    },
    ...(space.parentId ? [{ id: "lift", label: "Make it a space of its own", icon: ArrowRight01Icon, onSelect: () => actions.update(space.id, { parentId: null }) }] : []),
    { id: "delete", label: space.parentId ? "Delete this pocket" : "Delete this space", icon: Delete02Icon, danger: true, section: true, onSelect: () => actions.remove(space.id) },
  ];
  const path = spacePath(spaces, spaceId);
  const pockets = spaces.filter((s) => s.parentId === spaceId).sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const deep = path.length >= SPACE_DEPTH;
  const make = () => {
    if (name.trim()) actions.createPocket(spaceId, name.trim());
    setName("");
    setMaking(false);
  };
  return (
    <div className="flex flex-col gap-2 pb-1.5">
      <ContextMenu at={menu} items={items} label={space.name} onClose={() => setMenu(null)} />
      {renaming !== null ? (
        <input
          autoFocus
          value={renaming}
          maxLength={80}
          onChange={(e) => setRenaming(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={rename}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") rename();
            if (e.key === "Escape") setRenaming(null);
          }}
          aria-label="Space name"
          className="h-9 rounded-full border border-accent/60 bg-transparent px-3.5 text-[14px] outline-none"
        />
      ) : null}
      <div className="flex min-w-0 items-center gap-1 px-1 text-[12px] text-pane-muted">
        {path.slice(0, -1).map((p) => (
          <span key={p.id} className="flex min-w-0 items-center gap-1">
            <button onClick={() => actions.open(p.id)} className="truncate hover:text-pane-fg">
              {p.name}
            </button>
            <Icon icon={ArrowRight01Icon} size={11} className="shrink-0" />
          </span>
        ))}
        <span className="truncate">
          {plural(count, "conversation")}
          {pockets.length ? ", pockets included" : ""} · only in Kite
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-0.5">
          <Tooltip label={space.note ? "Note" : "Add a note"}>
            <button
              aria-label={space.note ? "Note" : "Add a note"}
              onClick={() => setNoting((v) => !v)}
              className={cn("grid size-7 place-items-center rounded-full hover:bg-pane-hover hover:text-pane-fg", (noting || space.note) && "text-warning")}
            >
              <Icon icon={Note01Icon} size={14} />
            </button>
          </Tooltip>
          <Tooltip label="Space options">
            <button
              aria-label="Space options"
              aria-haspopup="menu"
              onClick={(e) => {
                const box = e.currentTarget.getBoundingClientRect();
                setMenu({ x: box.right - 248, y: box.bottom + 4 });
              }}
              className="grid size-7 place-items-center rounded-full hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={MoreHorizontalIcon} size={15} />
            </button>
          </Tooltip>
        </span>
      </div>

      {pockets.length || !deep ? (
        <FluidList tone="pill" axis="x" className="scroll-fade flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {pockets.map((pocket, i) => (
            <button
              key={pocket.id}
              {...FLUID_ITEM}
              onClick={() => actions.open(pocket.id)}
              style={{ "--i": i } as React.CSSProperties}
              className="blur-fade relative flex h-8 shrink-0 items-center gap-2 rounded-full border border-pane-border px-3 text-[12.5px] transition-[background-color] duration-150"
            >
              <SpaceDot space={pocket} />
              <span className="max-w-[160px] truncate">{pocket.name}</span>
              {pocket.threads ? <span className="tabular-nums text-pane-muted">{pocket.threads}</span> : null}
            </button>
          ))}
          {deep ? null : making ? (
            <input
              autoFocus
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              onBlur={make}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") make();
                if (e.key === "Escape") {
                  setName("");
                  setMaking(false);
                }
              }}
              placeholder="Pocket name, like a job"
              aria-label="New pocket's name"
              className="h-8 w-48 shrink-0 rounded-full border border-accent/60 bg-transparent px-3 text-[12.5px] outline-none placeholder:text-pane-muted"
            />
          ) : (
            <button
              {...FLUID_ITEM}
              onClick={() => setMaking(true)}
              className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-pane-muted transition-[background-color,color] duration-150 data-[lit]:text-pane-fg"
            >
              <Icon icon={Add01Icon} size={13} />
              {pockets.length ? "Pocket" : "Add a pocket"}
            </button>
          )}
        </FluidList>
      ) : null}

      {noting || space.note ? <SpaceNote key={space.id} space={space} onSave={(note) => actions.update(space.id, { note })} onClose={() => setNoting(false)} autoFocus={noting && !space.note} /> : null}
    </div>
  );
}

/** The space's private note: plain words for yourself (job numbers, who's who), saved as you type. */
function SpaceNote({ space, autoFocus, onSave, onClose }: { space: Space; autoFocus: boolean; onSave: (note: string | null) => void; onClose: () => void }) {
  const [text, setText] = useState(space.note ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const pending = useRef<string | null>(null);
  const save = useRef(onSave);
  useEffect(() => {
    save.current = onSave;
  }, [onSave]);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (pending.current !== null) save.current(pending.current || null);
    },
    [],
  );
  return (
    <div data-sensitive className="blur-fade-up rounded-2xl border border-warning/30 bg-warning/10 px-3.5 pb-2 pt-2.5">
      <div className="flex items-center gap-2 text-[11.5px] text-pane-muted">
        <Icon icon={Note01Icon} size={13} className="text-warning" />
        <span className="flex-1">Note on this space · only in Kite</span>
        {space.note ? (
          <Tooltip label="Delete note">
            <button
              aria-label="Delete note"
              onClick={() => {
                clearTimeout(timer.current);
                pending.current = null;
                setText("");
                onSave(null);
                onClose();
              }}
              className="grid size-6 place-items-center rounded-full hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={Delete02Icon} size={12} />
            </button>
          </Tooltip>
        ) : null}
      </div>
      <textarea
        autoFocus={autoFocus}
        value={text}
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          pending.current = next;
          clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            pending.current = null;
            save.current(next.trim() ? next : null);
          }, 700);
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") e.currentTarget.blur();
        }}
        placeholder="Job numbers, who's who, what's agreed…"
        aria-label="Note on this space"
        className="font-reading mt-1 w-full resize-none bg-transparent text-[13px] leading-6 outline-none placeholder:text-pane-muted"
      />
    </div>
  );
}
