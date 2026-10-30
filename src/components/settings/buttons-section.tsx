"use client";

import { useRef, useState } from "react";
import { MoreHorizontalIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import {
  BUTTON_ACTIONS,
  BUTTON_INFO,
  DEFAULT_BUTTONS,
  DIVIDER,
  HOVER_ACTIONS,
  HOVER_MAX,
  onToolbar,
  tidySlots,
  type ButtonAction,
  type ButtonPrefs,
  type HoverAction,
  type ToolbarSlot,
} from "@/lib/buttons";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Avatar } from "../mail/avatar";
import { BUTTON_ICONS } from "../mail/button-icons";
import { setButtonDragImage } from "../mail/drag-image";
import { Tooltip } from "../ui/tooltip";
import { Group } from "./settings-ui";

/** The toolbar as one row: the left side, where the subject goes, then the right side. */
const SPLIT = "split";
type Flat = (ToolbarSlot | typeof SPLIT)[];
const toFlat = (toolbar: ButtonPrefs["toolbar"]): Flat => [...toolbar.left, SPLIT, ...toolbar.right];
function fromFlat(flat: Flat): ButtonPrefs["toolbar"] {
  const cut = flat.indexOf(SPLIT);
  return { left: tidySlots(flat.slice(0, cut) as ToolbarSlot[]), right: tidySlots(flat.slice(cut + 1) as ToolbarSlot[]) };
}

/** What's being dragged: a button already on a bar (by its place), or a tile from the tray. */
type Drag = { from: "bar"; index: number } | { from: "tray"; slot: ToolbarSlot };

const nameOf = (slot: ToolbarSlot) => (slot === DIVIDER ? "A line" : BUTTON_INFO[slot].label);

/**
 * Settings → Buttons, the way a Mac customises a toolbar: a true copy of the bar (drag to move, off the
 * bar to remove) over a tray of every action (click to add or remove, drag onto the bar to place).
 * The list's hover row works the same on a real-looking row. Every change saves at once.
 */
export function ButtonsSection({ buttons, onChange }: { buttons: ButtonPrefs; onChange: (buttons: ButtonPrefs) => void }) {
  return (
    <>
      <Group
        title="Reader toolbar"
        description="Drag buttons to move them, or off the bar to put them in More. Right-click the toolbar in a conversation to come back here."
        action={<Reset shown={JSON.stringify(buttons.toolbar) !== JSON.stringify(DEFAULT_BUTTONS.toolbar)} onReset={() => onChange({ ...buttons, toolbar: DEFAULT_BUTTONS.toolbar })} />}
        bare
      >
        <ToolbarEditor toolbar={buttons.toolbar} onChange={(toolbar) => onChange({ ...buttons, toolbar })} />
      </Group>
      <Group
        title="Conversation list"
        description={`What shows when you point at a conversation, up to ${HOVER_MAX}. More and right-click have the rest.`}
        action={<Reset shown={JSON.stringify(buttons.hover) !== JSON.stringify(DEFAULT_BUTTONS.hover)} onReset={() => onChange({ ...buttons, hover: DEFAULT_BUTTONS.hover })} />}
        bare
      >
        <HoverEditor hover={buttons.hover} onChange={(hover) => onChange({ ...buttons, hover })} />
      </Group>
    </>
  );
}

function ToolbarEditor({ toolbar, onChange }: { toolbar: ButtonPrefs["toolbar"]; onChange: (toolbar: ButtonPrefs["toolbar"]) => void }) {
  const flat = toFlat(toolbar);
  const placed = onToolbar({ toolbar, hover: [] });
  const [drag, setDrag] = useState<Drag | null>(null);
  const { rowRef, place, zone, clear: clearDrop } = useDropPlace({
    active: !!drag,
    effect: drag?.from === "tray" ? "copy" : "move",
    // Dropping right before or after where it already is changes nothing, so no line shows there.
    still: drag?.from === "bar" ? drag.index : null,
    onDrop: (index) => {
      landed.current = true;
      if (!drag) return;
      if (drag.from === "bar") insert(flat[drag.index] as ToolbarSlot, index, drag.index);
      else insert(drag.slot, index);
      setDrag(null);
    },
  });
  // Set by any drop target; a bar button dropped anywhere else leaves the bar.
  const landed = useRef(false);

  const save = (next: Flat) => onChange(fromFlat(next));
  const insert = (slot: ToolbarSlot, at: number, without?: number) => {
    const next = [...flat];
    if (without !== undefined) next.splice(without, 1);
    next.splice(without !== undefined && at > without ? at - 1 : at, 0, slot);
    save(next);
  };
  const removeAt = (index: number) => save(flat.filter((_, i) => i !== index));
  const toggle = (action: ButtonAction) => {
    const index = flat.indexOf(action);
    if (index >= 0) removeAt(index);
    else save([...flat, action]);
  };

  return (
    <div className="flex flex-col gap-4">
      {/* The drop zone reaches a little past the bar, so a drop near its edge still lands on it. */}
      <div {...zone} className="-m-3 p-3">
      <div ref={rowRef} className="relative flex min-w-0 items-center gap-1.5 overflow-x-auto rounded-2xl border border-pane-border bg-pane px-3 py-2.5">
        <DropLine x={place?.x ?? null} />
        {flat.map((slot, i) =>
          slot === SPLIT ? (
            // Where the subject goes: dropping here puts a button at the end of the left side.
            <span key="split" data-slot className="flex min-w-6 flex-1 items-center self-stretch px-2">
              <span className="h-2 w-full rounded-full bg-pane-2" />
            </span>
          ) : (
            <span key={`${slot}:${i}`} data-slot className="flex shrink-0 items-center">
              <Tooltip label={`${nameOf(slot)} · drag to move, off the bar to remove`}>
                <button
                  draggable
                  aria-label={`${nameOf(slot)}: drag to move. Delete removes it; arrow keys move it.`}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", slot);
                    setButtonDragImage(e, { name: nameOf(slot), hint: "Drop where it goes, or off the bar" });
                    landed.current = false;
                    setDrag({ from: "bar", index: i });
                  }}
                  onDragEnd={() => {
                    if (!landed.current) removeAt(i);
                    setDrag(null);
                    clearDrop();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Delete" || e.key === "Backspace") removeAt(i);
                    else if (e.key === "ArrowLeft" && i > 0) insert(slot, i - 1, i);
                    else if (e.key === "ArrowRight" && i < flat.length - 1) insert(slot, i + 2, i);
                    else return;
                    e.preventDefault();
                  }}
                  className={cn(
                    "grid shrink-0 cursor-grab place-items-center active:cursor-grabbing",
                    slot === DIVIDER ? "h-9 w-3" : "size-9 rounded-full border border-pane-border text-pane-fg/80 hover:bg-pane-hover hover:text-pane-fg",
                    drag?.from === "bar" && drag.index === i && DRAGGED,
                  )}
                >
                  {slot === DIVIDER ? <span className="h-5 w-px bg-pane-border" /> : <Icon icon={BUTTON_ICONS[slot]} size={17} />}
                </button>
              </Tooltip>
            </span>
          ),
        )}
        <Tooltip label="More: everything that isn't on the bar">
          <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-pane-border text-pane-muted">
            <Icon icon={MoreHorizontalIcon} size={17} />
          </span>
        </Tooltip>
      </div>
      </div>

      {/* The tray: dropping a bar button here takes it off the bar. */}
      <div
        onDragOver={(e) => {
          if (drag?.from !== "bar") return;
          e.preventDefault();
          e.dataTransfer.dropEffect = "move";
        }}
        onDrop={(e) => {
          e.preventDefault();
          landed.current = false;
        }}
      >
        <p className="mb-2 text-[12px] text-pane-muted">All actions · click to add or remove, drag onto the bar to place</p>
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,11rem),1fr))] gap-1.5">
          {[...BUTTON_ACTIONS, DIVIDER as ToolbarSlot].map((slot) => {
            const on = slot !== DIVIDER && placed.has(slot);
            return (
              <button
                key={slot}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = "copy";
                  e.dataTransfer.setData("text/plain", slot);
                  setButtonDragImage(e, { name: slot === DIVIDER ? "A line" : shortName(slot), hint: "Drop it on the bar" });
                  landed.current = true;
                  setDrag({ from: "tray", slot });
                }}
                onDragEnd={() => {
                  setDrag(null);
                  clearDrop();
                }}
                onClick={() => (slot === DIVIDER ? save([...flat, DIVIDER]) : toggle(slot))}
                aria-pressed={slot === DIVIDER ? undefined : on}
                className={cn(
                  "flex min-w-0 cursor-grab items-center gap-2 rounded-xl border px-2.5 py-2 text-left text-[12.5px] transition-colors duration-150 active:cursor-grabbing",
                  on ? "border-pane-border bg-pane text-pane-fg" : "border-pane-border/70 text-pane-muted hover:bg-pane-hover hover:text-pane-fg",
                  drag?.from === "tray" && drag.slot === slot && DRAGGED,
                )}
              >
                {slot === DIVIDER ? <span className="mx-[7px] h-4 w-px shrink-0 bg-current" /> : <Icon icon={BUTTON_ICONS[slot]} size={16} className="shrink-0" />}
                <span className="min-w-0 flex-1 truncate">{slot === DIVIDER ? "A line between buttons" : shortName(slot)}</span>
                {slot === DIVIDER ? null : <Check on={on} />}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function HoverEditor({ hover, onChange }: { hover: HoverAction[]; onChange: (hover: HoverAction[]) => void }) {
  const [drag, setDrag] = useState<number | null>(null);
  const { rowRef, place, zone, clear: clearDrop } = useDropPlace({
    active: drag !== null,
    effect: "move",
    still: drag,
    onDrop: (index) => {
      landed.current = true;
      if (drag !== null) move(drag, index);
      setDrag(null);
    },
  });
  const landed = useRef(false);
  const full = hover.length >= HOVER_MAX;

  const move = (from: number, to: number) => {
    const next = [...hover];
    const [moved] = next.splice(from, 1);
    next.splice(to > from ? to - 1 : to, 0, moved);
    onChange(next);
  };
  const removeAt = (index: number) => onChange(hover.filter((_, i) => i !== index));

  return (
    <div className="flex flex-col gap-3">
      <div {...zone} className="flex min-w-0 items-center gap-3 rounded-2xl border border-pane-border bg-pane px-3 py-3">
        <Avatar name="Lerato Mokoena" className="size-8 shrink-0" src={null} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold">Lerato Mokoena</span>
          <span className="block truncate text-[12px] text-pane-muted">Contract draft v3 · Here&rsquo;s v3 with the changes to clause 7</span>
        </span>
        <div ref={rowRef} className="relative flex shrink-0 items-center gap-0.5 rounded-full border border-pane-border bg-pane p-0.5 shadow-sm">
          <DropLine x={place?.x ?? null} small />
          {hover.map((action, i) => (
            <span key={action} data-slot className="flex items-center">
              <Tooltip label={`${shortName(action)} · drag to move, off the row to remove`}>
                <button
                  draggable
                  aria-label={`${shortName(action)}: drag to move. Delete removes it; arrow keys move it.`}
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", action);
                    setButtonDragImage(e, { name: shortName(action), hint: "Drop where it goes, or off the row" });
                    landed.current = false;
                    setDrag(i);
                  }}
                  onDragEnd={() => {
                    if (!landed.current) removeAt(i);
                    setDrag(null);
                    clearDrop();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Delete" || e.key === "Backspace") removeAt(i);
                    else if (e.key === "ArrowLeft" && i > 0) move(i, i - 1);
                    else if (e.key === "ArrowRight" && i < hover.length - 1) move(i, i + 2);
                    else return;
                    e.preventDefault();
                  }}
                  className={cn("grid size-7 cursor-grab place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg active:cursor-grabbing", drag === i && DRAGGED)}
                >
                  <Icon icon={BUTTON_ICONS[action]} size={15} />
                </button>
              </Tooltip>
            </span>
          ))}
          <span className="grid size-7 place-items-center rounded-full text-pane-muted">
            <Icon icon={MoreHorizontalIcon} size={15} />
          </span>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {HOVER_ACTIONS.map((action) => {
          const on = hover.includes(action);
          const blocked = !on && full;
          return (
            <Tooltip key={action} label={blocked ? `Up to ${HOVER_MAX}: take one off first` : on ? "Take it off the row" : "Add it to the row"}>
              <button
                aria-pressed={on}
                aria-disabled={blocked || undefined}
                onClick={() => (on ? onChange(hover.filter((a) => a !== action)) : !blocked && onChange([...hover, action]))}
                className={cn(
                  "flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12.5px] transition-colors duration-150",
                  blocked ? "cursor-not-allowed" : "cursor-pointer",
                  on ? "border-success/30 bg-success/10 text-pane-fg" : "border-pane-border text-pane-muted",
                  blocked ? "opacity-40" : !on && "hover:bg-pane-hover hover:text-pane-fg",
                )}
              >
                {on ? <Icon icon={Tick02Icon} size={13} className="text-success" /> : <Icon icon={BUTTON_ICONS[action]} size={14} />}
                {shortName(action)}
              </button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
}

/** What's being dragged stays in its place, faded and dashed, so you can see which one it is. */
const DRAGGED = "border border-dashed border-pane-muted/60 bg-transparent opacity-40";

/** Tile and tooltip names, shorter than the menu's. */
function shortName(action: ButtonAction) {
  const short: Partial<Record<ButtonAction, string>> = {
    snooze: "Snooze",
    read: "Read / unread",
    pin: "Pin",
    files: "Files",
    people: "People",
    summarise: "Summarise",
    calendar: "Add to calendar",
    merge: "Merge",
  };
  return short[action] ?? BUTTON_INFO[action].label;
}

/**
 * Where a drop over a row of `[data-slot]` items lands, from the pointer alone: before the first item
 * whose middle is right of it, else at the end. One answer for the whole zone (no target per item), so
 * the line doesn't flicker in the gaps, and it sits between the two neighbours without moving anything.
 * `still`: the dragged item's own place; dropping just before or after it changes nothing, so no line.
 */
function useDropPlace({ active, effect, still, onDrop }: { active: boolean; effect: "move" | "copy"; still: number | null; onDrop: (index: number) => void }) {
  const rowRef = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ index: number; x: number } | null>(null);

  const measure = (clientX: number, still: number | null) => {
    const row = rowRef.current;
    if (!row) return null;
    const box = row.getBoundingClientRect();
    const items = [...row.querySelectorAll<HTMLElement>("[data-slot]")].map((el) => el.getBoundingClientRect());
    let index = items.findIndex((r) => clientX < r.left + r.width / 2);
    if (index < 0) index = items.length;
    const prev = items[index - 1];
    const next = items[index];
    const at = prev && next ? (prev.right + next.left) / 2 : next ? next.left - 3 : prev ? prev.right + 3 : box.left + 12;
    const noMove = still !== null && (index === still || index === still + 1);
    return { index, x: noMove ? null : at - box.left + row.scrollLeft };
  };

  const zone = {
    onDragOver: (e: React.DragEvent) => {
      if (!active) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = effect;
      const found = measure(e.clientX, still);
      const next = found && found.x !== null ? { index: found.index, x: found.x } : null;
      setPlace((current) => (current?.index === next?.index && current?.x === next?.x ? current : next));
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setPlace(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      const found = measure(e.clientX, still);
      setPlace(null);
      if (found) onDrop(found.index);
    },
  };

  return { rowRef, place, zone, clear: () => setPlace(null) };
}

/** Where the dragged button will land: an accent line between its new neighbours. */
function DropLine({ x, small }: { x: number | null; small?: boolean }) {
  // Mounted where it first shows (no slide in from the edge), then glides from gap to gap.
  if (x === null) return null;
  return (
    <span
      aria-hidden
      style={{ left: x }}
      className={cn(
        "pointer-events-none absolute top-1/2 z-10 w-0.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent transition-[left] duration-100 ease-out",
        small ? "h-5" : "h-7",
      )}
    />
  );
}

function Check({ on }: { on: boolean }) {
  return (
    // A pointer here (the rest of the tile is a grab handle): this is the part that adds or takes off.
    <span className={cn("grid size-4 shrink-0 cursor-pointer place-items-center rounded-full", on ? "bg-success/15 text-success" : "border border-pane-border")}>
      {on ? <Icon icon={Tick02Icon} size={11} /> : null}
    </span>
  );
}

function Reset({ shown, onReset }: { shown: boolean; onReset: () => void }) {
  if (!shown) return null;
  return (
    <button onClick={onReset} className="rounded-full px-2.5 py-1 text-[12px] font-medium text-accent hover:bg-accent-soft">
      Reset to Kite&rsquo;s layout
    </button>
  );
}
