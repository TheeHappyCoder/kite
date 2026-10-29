"use client";

import { useEffect, useId, useRef, useState } from "react";
import { motion } from "motion/react";
import { Add01Icon, Delete02Icon, Image02Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import { COLOR_NAMES } from "@/lib/mail/account-face";
import { springSnappy } from "@/lib/motion";
import { SPACE_COLORS, SPACE_DEPTH, siblingsOf, spaceDepth, type Space, type SpacePatch } from "@/lib/spaces";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { squareImage, uploadAsset } from "../design/assets";
import { FOOTER, HEADER, Panel, type Spot } from "../ui/date-time-picker";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { SpaceDot } from "./space-picker";

const WIDTH = 300;

/** How tall the card is: header, colours, logo, its pockets and "Add a pocket", footer. */
function heightFor(spaces: Space[], space: Space) {
  const pockets = spaceDepth(spaces, space.id) < SPACE_DEPTH - 1 ? 30 + (siblingsOf(spaces, space.id).length + 1) * 34 : 0;
  return 48 + 12 + 112 + 14 + 66 + 14 + pockets + 12 + 44;
}

/** Below the point when it fits, else above it, else as low as the window allows. */
function place(at: { x: number; y: number }, height: number): Spot {
  const left = Math.max(8, Math.min(at.x, window.innerWidth - WIDTH - 8));
  if (window.innerHeight - at.y - 8 >= height) return { left, width: WIDTH, top: at.y };
  if (at.y - 8 >= height) return { left, width: WIDTH, bottom: window.innerHeight - at.y };
  return { left, width: WIDTH, top: Math.max(8, window.innerHeight - height - 8) };
}

/**
 * Everything about one space in one small card, in the house pickers' look (date-time-picker.tsx's
 * Panel): its name, its colour, a logo of your own, and its pockets (rename in place, add one).
 * Changes save as they're made. Opens at a point (a right-click, the header's menu button).
 */
export function SpaceEditor({
  spaceId,
  spaces,
  at,
  onClose,
  onUpdate,
  onCreatePocket,
  onError,
}: {
  spaceId: string | null;
  spaces: Space[];
  at: { x: number; y: number } | null;
  onClose: () => void;
  onUpdate: (id: string, patch: SpacePatch) => void;
  onCreatePocket: (parentId: string, name: string) => void;
  onError: (message: string) => void;
}) {
  const space = spaceId ? spaces.find((s) => s.id === spaceId) : undefined;
  const panel = useRef<HTMLDivElement>(null);
  const open = !!(space && at);
  const spot = open ? place(at!, heightFor(spaces, space!)) : null;

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!panel.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, [open, onClose]);

  return (
    <Panel
      spot={spot}
      panelRef={panel}
      label={space ? `Edit ${space.name}` : "Edit space"}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
      className="flex flex-col"
    >
      {space ? <Body key={space.id} space={space} spaces={spaces} onClose={onClose} onUpdate={onUpdate} onCreatePocket={onCreatePocket} onError={onError} /> : null}
    </Panel>
  );
}

function Body({
  space,
  spaces,
  onClose,
  onUpdate,
  onCreatePocket,
  onError,
}: {
  space: Space;
  spaces: Space[];
  onClose: () => void;
  onUpdate: (id: string, patch: SpacePatch) => void;
  onCreatePocket: (parentId: string, name: string) => void;
  onError: (message: string) => void;
}) {
  const id = useId();
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const pockets = siblingsOf(spaces, space.id);
  const canNest = spaceDepth(spaces, space.id) < SPACE_DEPTH - 1;

  const upload = async (picked: File) => {
    setUploading(true);
    try {
      const asset = await uploadAsset(await squareImage(picked, "space-logo.webp"), { private: true });
      onUpdate(space.id, { logo: asset.id });
    } catch (error) {
      onError(error instanceof Error ? error.message : "The upload didn't go through. Try again.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <div className={cn(HEADER, "h-12 gap-2.5 px-3")}>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-pane-2/60">
          <SpaceDot space={space} className="size-2.5" logo logoClassName="size-7 rounded-lg" />
        </span>
        <NameInput
          value={space.name}
          label={space.parentId ? "Pocket name" : "Space name"}
          onSave={(name) => onUpdate(space.id, { name })}
          className="h-8 text-[15px] font-semibold"
        />
      </div>

      <div className="scroll-fade flex min-h-0 flex-col gap-3.5 overflow-y-auto px-3 pb-3 pt-3">
        <section>
          <Label>Colour</Label>
          <FluidList tone="pane" axis="xy" role="radiogroup" aria-label="Colour" className="grid grid-cols-6 gap-1">
            {SPACE_COLORS.map((color) => {
              const on = color === space.color;
              return (
                <Tooltip key={color} label={COLOR_NAMES[color]}>
                  <button
                    {...FLUID_ITEM}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    aria-label={COLOR_NAMES[color]}
                    onClick={() => (on ? undefined : onUpdate(space.id, { color }))}
                    className="relative grid h-9 w-full place-items-center rounded-lg transition-[background-color] duration-150 touch:h-11"
                  >
                    {on ? <motion.span layoutId={`${id}-colour`} transition={springSnappy} className="absolute inset-1 rounded-md ring-2 ring-accent/70" /> : null}
                    <span className="relative grid size-5 place-items-center rounded-full" style={{ background: color }}>
                      {on ? <Icon icon={Tick02Icon} size={11} className="blur-fade text-white drop-shadow" /> : null}
                    </span>
                  </button>
                </Tooltip>
              );
            })}
          </FluidList>
        </section>

        <section>
          <Label>Logo</Label>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => file.current?.click()}
              disabled={uploading}
              aria-label={space.logo ? "Change the logo" : "Upload a logo"}
              className={cn(
                "grid size-10 shrink-0 place-items-center overflow-hidden rounded-lg text-pane-muted transition-[background-color,color] duration-150 hover:text-pane-fg",
                space.logo ? "" : "border border-dashed border-pane-fg/20 hover:bg-pane-hover",
              )}
            >
              {uploading ? <Spinner size={14} /> : space.logo ? <SpaceDot space={space} logo logoClassName="size-10 rounded-lg" /> : <Icon icon={Image02Icon} size={16} />}
            </button>
            <div className="flex min-w-0 flex-1 flex-col text-[12.5px]">
              <button type="button" onClick={() => file.current?.click()} disabled={uploading} className="self-start rounded-md font-semibold text-accent transition-opacity duration-150 hover:opacity-75">
                {space.logo ? "Change" : "Upload an image"}
              </button>
              <span className="truncate text-pane-muted">{space.logo ? "Shown instead of the colour" : "Square works best"}</span>
            </div>
            {space.logo ? (
              <Tooltip label="Use the colour again">
                <button
                  type="button"
                  aria-label="Remove the logo"
                  onClick={() => onUpdate(space.id, { logo: null })}
                  className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted transition-[background-color,color] duration-150 hover:bg-pane-hover hover:text-pane-fg"
                >
                  <Icon icon={Delete02Icon} size={13} />
                </button>
              </Tooltip>
            ) : null}
            <input
              ref={file}
              type="file"
              hidden
              accept="image/png,image/jpeg,image/gif,image/webp"
              onChange={(e) => {
                const picked = e.target.files?.[0];
                e.target.value = "";
                if (picked) void upload(picked);
              }}
            />
          </div>
        </section>

        {canNest ? (
          <section>
            <Label>Pockets</Label>
            <div className="flex flex-col gap-0.5">
              {pockets.map((pocket) => (
                <div key={pocket.id} className="flex h-8 items-center gap-2.5 pl-2.5 touch:h-10">
                  <SpaceDot space={pocket} logo logoClassName="size-3.5" />
                  <NameInput value={pocket.name} label={`Rename ${pocket.name}`} onSave={(name) => onUpdate(pocket.id, { name })} className="h-8 text-[13px]" />
                </div>
              ))}
              <NewPocket onAdd={(name) => onCreatePocket(space.id, name)} />
            </div>
          </section>
        ) : null}
      </div>

      <div className={cn(FOOTER, "h-11 justify-between gap-3 px-4 text-[12.5px]")}>
        <span className="truncate text-pane-muted">Only in Kite</span>
        <button type="button" onClick={onClose} className="shrink-0 rounded-md font-semibold text-accent transition-opacity duration-150 hover:opacity-75">
          Done
        </button>
      </div>
    </>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="pb-1.5 text-[11.5px] font-medium text-pane-muted">{children}</div>;
}

/** A name edited in place: saved on Enter or leaving the field, Escape puts it back. */
function NameInput({ value, label, onSave, className }: { value: string; label: string; onSave: (name: string) => void; className?: string }) {
  const [text, setText] = useState(value);
  const save = () => {
    const name = text.trim();
    if (name && name !== value) onSave(name);
    else setText(value);
  };
  return (
    <input
      value={text}
      maxLength={80}
      aria-label={label}
      onChange={(e) => setText(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape" && text !== value) {
          e.stopPropagation();
          setText(value);
        }
      }}
      className={cn("min-w-0 flex-1 rounded-lg bg-transparent px-1.5 outline-none transition-[background-color] duration-150 hover:bg-pane-hover focus:bg-pane-hover", className)}
    />
  );
}

function NewPocket({ onAdd }: { onAdd: (name: string) => void }) {
  const [name, setName] = useState("");
  const add = () => {
    if (name.trim()) onAdd(name.trim());
    setName("");
  };
  return (
    <label className="flex h-8 items-center gap-2.5 pl-2 text-pane-muted touch:h-10">
      <Icon icon={Add01Icon} size={13} className="shrink-0" />
      <input
        value={name}
        maxLength={80}
        placeholder="Add a pocket"
        aria-label="New pocket's name"
        onChange={(e) => setName(e.target.value)}
        onBlur={add}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
        className="h-8 min-w-0 flex-1 rounded-lg bg-transparent px-1.5 text-[13px] text-pane-fg outline-none placeholder:text-pane-muted focus:bg-pane-hover"
      />
    </label>
  );
}
