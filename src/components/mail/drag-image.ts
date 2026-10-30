/**
 * What follows the pointer while conversations are dragged: a clean card (who and what) instead of
 * the browser's ghost of the row. Browsers draw a drag image see-through, so theirs is replaced by an
 * empty one and the card is our own element, moved with the pointer. Several conversations fan out
 * as up to three cards, with "+N" for the rest. Colours are read from the row, so the card matches
 * its pane in light and dark.
 */

/** A transparent pixel, loaded ahead so it's ready the moment a drag starts. */
let blank: HTMLImageElement | null = null;
function emptyImage() {
  if (!blank) {
    blank = new Image();
    blank.src = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  }
  return blank;
}
if (typeof window !== "undefined") emptyImage();

const VARS = ["--pane", "--pane-2", "--pane-fg", "--pane-muted", "--pane-border", "--accent", "--accent-soft", "--lime", "--lime-fg", "--font-ui"];
const FAN = [
  { rotate: 0, x: 0, y: 0 },
  { rotate: -6, x: -8, y: 4 },
  { rotate: 5, x: 10, y: 8 },
];

const text = (value: string) => value.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function setThreadDragImage(e: React.DragEvent<HTMLElement>, { sender, subject, ids }: { sender: string; subject: string; ids: string[] }) {
  const count = ids.length;
  const shown = Math.min(count, 3);
  const extra = count - shown;
  const initial = (sender.trim()[0] ?? "?").toUpperCase();

  const card = cardShell(e, { width: 240, height: 50 });

  const sheet = (i: number, content: string) => {
    const { rotate, x, y } = FAN[i];
    return `<div style="position:absolute;inset:0;display:flex;align-items:center;gap:10px;padding:0 14px 0 10px;border-radius:14px;background:var(--pane);color:var(--pane-fg);border:1px solid var(--pane-border);box-shadow:0 1px 2px rgb(0 0 0 / 0.06), 0 10px 24px -12px rgb(0 0 0 / 0.35);transform:translate(${x}px, ${y}px) rotate(${rotate}deg);transform-origin:50% 100%">${content}</div>`;
  };
  const front = `
    <span style="display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:999px;background:var(--accent-soft);color:var(--accent);font-size:13px;font-weight:600">${text(initial)}</span>
    <span style="display:flex;flex-direction:column;min-width:0;gap:1px">
      <span style="font-size:13px;font-weight:600;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text(sender)}</span>
      <span style="font-size:12px;line-height:16px;color:var(--pane-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text(subject)}</span>
    </span>`;
  const behind = Array.from({ length: shown - 1 }, (_, i) => sheet(shown - 1 - i, "")).join("");
  const more = extra
    ? `<span style="position:absolute;top:-8px;right:-8px;padding:0 8px;height:22px;display:grid;place-items:center;border-radius:999px;background:var(--lime);color:var(--lime-fg);font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;box-shadow:0 0 0 2px var(--pane)">+${extra}</span>`
    : "";
  card.innerHTML = `${behind}${sheet(0, front)}${more}`;

  // The rows being dragged step back, until the drag ends.
  const rows = new Set(ids);
  followPointer(e, card, {
    start: () => document.querySelectorAll<HTMLElement>("[data-thread]").forEach((row) => rows.has(row.dataset.thread ?? "") && row.setAttribute("data-dragging", "")),
    end: () => document.querySelectorAll("[data-dragging]").forEach((row) => row.removeAttribute("data-dragging")),
  });
}

/** A card on its own: the drag look shared by conversations and spaces (fixed, see-through until shown). */
function cardShell(e: React.DragEvent<HTMLElement>, { width, height }: { width: number; height: number }) {
  const look = getComputedStyle(e.currentTarget);
  const card = document.createElement("div");
  card.setAttribute("data-sensitive", "");
  card.setAttribute("aria-hidden", "true");
  for (const name of VARS) card.style.setProperty(name, look.getPropertyValue(name));
  Object.assign(card.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: `${width}px`,
    height: `${height}px`,
    zIndex: "2147483647",
    pointerEvents: "none",
    fontFamily: "var(--font-ui, system-ui), system-ui, sans-serif",
    opacity: "0",
    transition: "opacity 120ms ease",
    willChange: "transform",
  });
  return card;
}

/**
 * Swaps the browser's ghost for `card`, which then hangs a little below and right of the pointer
 * until the drag ends. `start` / `end` run as it appears and goes.
 */
function followPointer(e: React.DragEvent<HTMLElement>, card: HTMLElement, hooks: { start?: () => void; end?: () => void } = {}) {
  e.dataTransfer.setDragImage(emptyImage(), 0, 0);
  const place = (x: number, y: number) => {
    card.style.transform = `translate(${x + 12}px, ${y + 10}px)`;
  };
  const follow = (ev: DragEvent) => {
    // The last `drag` event reports 0, 0 in some browsers; ignore it.
    if (ev.clientX === 0 && ev.clientY === 0) return;
    place(ev.clientX, ev.clientY);
  };
  place(e.clientX, e.clientY);
  const start = () => {
    document.body.appendChild(card);
    requestAnimationFrame(() => (card.style.opacity = "1"));
    hooks.start?.();
  };
  const end = () => {
    card.remove();
    hooks.end?.();
    window.removeEventListener("dragover", follow, true);
    window.removeEventListener("drag", follow, true);
    window.removeEventListener("dragend", end, true);
    window.removeEventListener("drop", end, true);
  };
  // Not in the dragstart itself: changing the page there can cancel the drag.
  setTimeout(start, 0);
  window.addEventListener("dragover", follow, true);
  window.addEventListener("drag", follow, true);
  window.addEventListener("dragend", end, true);
  window.addEventListener("drop", end, true);
}

/** A space being dragged in the sidebar: its dot, its name, and how many pockets come with it. */
export function setSpaceDragImage(e: React.DragEvent<HTMLElement>, { name, color, pockets }: { name: string; color: string; pockets: number }) {
  const card = cardShell(e, { width: 200, height: 40 });
  // The same paper card as a conversation's, so both drags read alike.
  card.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;gap:10px;padding:0 14px 0 12px;border-radius:12px;background:var(--pane);color:var(--pane-fg);border:1px solid var(--pane-border);box-shadow:0 1px 2px rgb(0 0 0 / 0.06), 0 10px 24px -12px rgb(0 0 0 / 0.35)">
    <span style="flex:none;width:10px;height:10px;border-radius:999px;background:${text(color)}"></span>
    <span style="flex:1;min-width:0;font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text(name)}</span>
    ${pockets ? `<span style="flex:none;font-size:11.5px;color:var(--pane-muted);font-variant-numeric:tabular-nums">+${pockets} ${pockets === 1 ? "pocket" : "pockets"}</span>` : ""}
  </div>`;
  followPointer(e, card);
}

/** A button being placed in Settings → Buttons: its icon (copied from the element dragged) and its name, on the same card. */
export function setButtonDragImage(e: React.DragEvent<HTMLElement>, { name, hint }: { name: string; hint: string }) {
  const icon = e.currentTarget.querySelector("svg")?.outerHTML ?? "";
  const card = cardShell(e, { width: 230, height: 46 });
  card.innerHTML = `<div style="position:absolute;inset:0;display:flex;align-items:center;gap:10px;padding:0 14px 0 8px;border-radius:999px;background:var(--pane);color:var(--pane-fg);border:1px solid var(--pane-border);box-shadow:0 1px 2px rgb(0 0 0 / 0.06), 0 10px 24px -12px rgb(0 0 0 / 0.35)">
    <span style="display:grid;place-items:center;flex:none;width:30px;height:30px;border-radius:999px;border:1px solid var(--pane-border);color:var(--pane-fg)">${icon}</span>
    <span style="display:flex;flex-direction:column;min-width:0;gap:1px">
      <span style="font-size:13px;font-weight:600;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text(name)}</span>
      <span style="font-size:11.5px;line-height:15px;color:var(--pane-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${text(hint)}</span>
    </span>
  </div>`;
  followPointer(e, card);
}
