"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Download04Icon,
  HighlighterIcon,
  PencilIcon,
  Redo02Icon,
  TextFontIcon,
  Undo02Icon,
  ViewOffSlashIcon,
} from "@hugeicons/core-free-icons";
import {
  MARK_COLOURS,
  MARK_SIZES,
  MASK_MAX,
  REDACT_STYLES,
  TEXT_LINE,
  maskLayout,
  isEmpty,
  rectFrom,
  renderMarks,
  type Annotation,
  type MarkSize,
  type Point,
  type RedactStyle,
  type Tool,
} from "@/lib/screenshot/annotations";
import { comboFromEvent, useShortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../../icon";
import { Dialog } from "../../ui/dialog";
import { FLUID_ITEM, FluidList } from "../../ui/fluid-hover";
import { Spinner } from "../../ui/spinner";
import { Tooltip } from "../../ui/tooltip";
import { CopyIcon } from "../../ui/copy";

/** What the dialog shows: the capture running, the picture to mark up, or why it didn't work. */
export type Shot =
  | { id: number; status: "capturing"; name: string }
  | { id: number; status: "ready"; name: string; canvas: HTMLCanvasElement; scale: number }
  | { id: number; status: "error"; name: string; message: string };

const TOOLS: { id: Tool; label: string; icon: IconData; hint: string }[] = [
  { id: "redact", label: "Redact", icon: ViewOffSlashIcon, hint: "Drag over text to swap each word for characters" },
  { id: "highlight", label: "Highlight", icon: HighlighterIcon, hint: "Drag over text to highlight it" },
  { id: "draw", label: "Draw", icon: PencilIcon, hint: "Draw on the email" },
  { id: "text", label: "Text", icon: TextFontIcon, hint: "Click where the text goes" },
];

/**
 * Screenshot of an email (reader: toolbar, More, a message's own menu, the palette, `screenshot`):
 * redact, highlight, draw and write on it, then save it as a PNG or copy it. Everything stays in
 * the browser; marks are flattened into the saved pixels.
 */
export default function ScreenshotEditor({ shot, onClose, onToast }: { shot: Shot | null; onClose: () => void; onToast: (message: string) => void }) {
  const [confirming, setConfirming] = useState(false);
  const dirty = useRef(false);
  const close = useCallback(() => {
    if (dirty.current) setConfirming(true);
    else onClose();
  }, [onClose]);
  const markDirty = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const discard = () => {
    dirty.current = false;
    setConfirming(false);
    onClose();
  };

  return (
    <Dialog
      open={!!shot}
      onClose={close}
      title="Screenshot"
      description={shot?.status === "ready" ? TOOL_LINE : undefined}
      className="h-[92vh] max-h-[92vh] w-[1180px] max-sm:h-[96vh] max-sm:max-h-[96vh]"
    >
      {!shot ? null : shot.status === "capturing" ? (
        <div className="grid h-full min-h-60 place-items-center text-[13px] text-pane-muted">
          <span className="flex items-center gap-2">
            <Spinner />
            Taking the screenshot…
          </span>
        </div>
      ) : shot.status === "error" ? (
        <div className="grid h-full min-h-60 place-items-center px-6 text-center text-[13px]">
          <div>
            <p className="font-medium">That screenshot didn&apos;t work</p>
            <p className="mt-1 text-pane-muted">{shot.message}</p>
          </div>
        </div>
      ) : (
        <Editor
          key={shot.id}
          shot={shot}
          confirming={confirming}
          onDirty={markDirty}
          onKeep={() => setConfirming(false)}
          onDiscard={discard}
          onToast={onToast}
        />
      )}
    </Dialog>
  );
}

const REDACT_KEY = "kite-redact";

/** The redaction style last used (kept in this browser), else dots. */
function storedRedact(): { style: RedactStyle; custom: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(REDACT_KEY) ?? "null") as { style?: string; custom?: string } | null;
    const style = REDACT_STYLES.find((r) => r.id === saved?.style)?.id;
    if (style) return { style, custom: typeof saved?.custom === "string" ? saved.custom : "x#" };
  } catch {}
  return { style: "dots", custom: "x#" };
}

const TOOL_LINE = "Redact, highlight, draw or write on it, then save or copy the picture.";

function Editor({
  shot,
  confirming,
  onDirty,
  onKeep,
  onDiscard,
  onToast,
}: {
  shot: Extract<Shot, { status: "ready" }>;
  confirming: boolean;
  onDirty: (dirty: boolean) => void;
  onKeep: () => void;
  onDiscard: () => void;
  onToast: (message: string) => void;
}) {
  const { canvas: base, scale } = shot;
  const view = useRef<HTMLCanvasElement>(null);
  const [tool, setTool] = useState<Tool>("redact");
  const [redact, setRedact] = useState<{ style: RedactStyle; custom: string }>(storedRedact);
  const pickRedact = (next: Partial<typeof redact>) => {
    const value = { ...redact, ...next, custom: (next.custom ?? redact.custom).slice(0, MASK_MAX * 2) };
    setRedact(value);
    try {
      localStorage.setItem(REDACT_KEY, JSON.stringify(value));
    } catch {}
  };
  /** The characters a redaction is written in now; null = a black box. */
  const mask = redact.style === "custom" ? Array.from(redact.custom.trim()).slice(0, MASK_MAX).join("") || null : (REDACT_STYLES.find((r) => r.id === redact.style)?.mask ?? null);
  const [colour, setColour] = useState<string>(MARK_COLOURS[0].value);
  const [size, setSize] = useState<MarkSize>("m");
  /** The marks in order, and the ones undone (Redo puts them back until a new mark is made). */
  const [history, setHistory] = useState<{ marks: Annotation[]; undone: Annotation[] }>({ marks: [], undone: [] });
  const { marks, undone } = history;
  const [draft, setDraft] = useState<Annotation | null>(null);
  const start = useRef<Point | null>(null);
  /** The text being typed: where (image pixels) and what. */
  const [writing, setWriting] = useState<{ id: number; at: Point; text: string; color: string; size: number } | null>(null);
  /** The same, readable from a blur that fires after a click has already started the next one. */
  const writingNow = useRef(writing);
  useEffect(() => {
    writingNow.current = writing;
  });
  /** Image pixels per CSS pixel of the canvas as shown now (the picture shrinks to fit the dialog). */
  const [shown, setShown] = useState(1);
  const [copied, setCopied] = useState(false);
  const shortcuts = useShortcuts();
  const sizes = MARK_SIZES.find((s) => s.id === size)!;
  const family = useRef<string | undefined>(undefined);

  useEffect(() => {
    onDirty(marks.length > 0);
  }, [marks, onDirty]);

  // The canvas is the picture's own size; CSS shrinks it to fit.
  useLayoutEffect(() => {
    const canvas = view.current;
    if (!canvas) return;
    canvas.width = base.width;
    canvas.height = base.height;
    family.current = getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() || undefined;
    const observer = new ResizeObserver(() => setShown(canvas.width / Math.max(1, canvas.getBoundingClientRect().width)));
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [base]);

  useEffect(() => {
    const ctx = view.current?.getContext("2d");
    if (ctx) renderMarks(ctx, base, draft ? [...marks, draft] : marks, family.current);
  }, [base, marks, draft]);

  const add = useCallback((mark: Annotation) => {
    if (!isEmpty(mark)) setHistory((h) => ({ marks: [...h.marks, mark], undone: [] }));
  }, []);
  const undo = useCallback(
    () => setHistory((h) => (h.marks.length ? { marks: h.marks.slice(0, -1), undone: [...h.undone, h.marks[h.marks.length - 1]] } : h)),
    [],
  );
  const redo = useCallback(
    () => setHistory((h) => (h.undone.length ? { marks: [...h.marks, h.undone[h.undone.length - 1]], undone: h.undone.slice(0, -1) } : h)),
    [],
  );

  /** Keeps the text being typed as a mark (`id`: only if it's still that one). */
  const commitText = (id?: number) => {
    const writing = writingNow.current;
    if (!writing || (id !== undefined && writing.id !== id)) return;
    writingNow.current = null;
    if (writing) add({ kind: "text", x: writing.at.x, y: writing.at.y, text: writing.text.replace(/\s+$/, ""), color: writing.color, size: writing.size });
    setWriting(null);
  };

  // Undo / redo from the user's bindings (not while typing a text mark: the field has its own).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest?.("textarea, input")) return;
      const combo = comboFromEvent(e);
      const action = combo ? shortcuts.actionFor(combo) : undefined;
      if (action === "annotateUndo") {
        e.preventDefault();
        undo();
      } else if (action === "annotateRedo") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcuts, undo, redo]);

  const pointAt = (e: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = e.currentTarget.getBoundingClientRect();
    const k = e.currentTarget.width / rect.width;
    // Inside the picture, even when the pointer leaves it mid-drag.
    const clamp = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v)));
    return { x: clamp((e.clientX - rect.left) * k, e.currentTarget.width), y: clamp((e.clientY - rect.top) * k, e.currentTarget.height) };
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const at = pointAt(e);
    if (tool === "text") {
      e.preventDefault();
      commitText();
      // Under the pointer: the first line's middle sits where the click was.
      const px = sizes.text * scale;
      const next = { id: Date.now(), at: { x: at.x, y: Math.max(0, at.y - px * 0.6) }, text: "", color: colour, size: px };
      writingNow.current = next;
      setWriting(next);
      return;
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = at;
    setDraft(
      tool === "draw"
        ? { kind: "draw", points: [at], color: colour, size: sizes.pen * scale }
        : tool === "highlight"
          ? { kind: "highlight", color: colour, ...rectFrom(at, at) }
          : { kind: "redact", mask, ...rectFrom(at, at) },
    );
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!start.current || !draft) return;
    const at = pointAt(e);
    setDraft(draft.kind === "draw" ? { ...draft, points: [...draft.points, at] } : { ...draft, ...rectFrom(start.current, at) });
  };
  const onUp = () => {
    if (draft?.kind === "redact" && draft.mask && !isEmpty(draft)) {
      // Read the words under the box from the picture itself, once.
      const pixels = base.getContext("2d")!.getImageData(draft.x, draft.y, draft.w, draft.h);
      add({ ...draft, layout: maskLayout(pixels.data, draft.w, draft.h, draft.x, draft.y, Math.round(48 * scale)) });
    } else if (draft) add(draft);
    setDraft(null);
    start.current = null;
  };

  /** The picture with every mark (the text being typed included). */
  const finished = () =>
    new Promise<Blob>((resolve, reject) => {
      const out = document.createElement("canvas");
      out.width = base.width;
      out.height = base.height;
      const ctx = out.getContext("2d")!;
      const all = writing?.text.trim()
        ? [...marks, { kind: "text", x: writing.at.x, y: writing.at.y, text: writing.text, color: writing.color, size: writing.size } as Annotation]
        : marks;
      renderMarks(ctx, base, all, family.current);
      out.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't make the picture"))), "image/png");
    });

  const save = async () => {
    try {
      const url = URL.createObjectURL(await finished());
      const a = document.createElement("a");
      a.href = url;
      a.download = shot.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      onDirty(false);
      onToast(`Saved “${shot.name}” to your downloads`);
    } catch {
      onToast("Couldn't save the picture. Try again.");
    }
  };
  const copy = async () => {
    try {
      await navigator.clipboard.write([new ClipboardItem({ "image/png": finished() })]);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      onToast("Couldn't copy the picture. Save it instead.");
    }
  };

  const hint = tool === "redact" && !mask ? "Drag a box to black it out" : TOOLS.find((t) => t.id === tool)!.hint;

  return (
    <div className="@container flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-y border-pane-border px-4 py-2">
        <FluidList tone="pill" axis="x" className="flex rounded-full border border-pane-border p-0.5">
          {TOOLS.map((t) => (
            <button
              key={t.id}
              {...FLUID_ITEM}
              aria-pressed={tool === t.id}
              onClick={() => {
                commitText();
                setTool(t.id);
              }}
              className={cn(
                "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[12.5px] transition-[background-color,color,font-weight] duration-150 touch:h-11",
                tool === t.id ? "bg-pane-selected font-semibold text-pane-fg" : "text-pane-muted data-[lit]:text-pane-fg",
              )}
            >
              <Icon icon={t.icon} size={15} />
              <span className="@max-[640px]:hidden">{t.label}</span>
            </button>
          ))}
        </FluidList>

        {tool === "redact" ? (
          <div className="flex items-center gap-1.5">
            <FluidList tone="pill" axis="x" className="flex rounded-full border border-pane-border p-0.5" aria-label="Redact with">
              {REDACT_STYLES.map((r) => (
                <button
                  key={r.id}
                  {...FLUID_ITEM}
                  aria-pressed={redact.style === r.id}
                  onClick={() => pickRedact({ style: r.id })}
                  className={cn(
                    "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[12px] transition-[background-color,color,font-weight] duration-150 touch:h-11",
                    redact.style === r.id ? "bg-pane-selected font-semibold text-pane-fg" : "text-pane-muted data-[lit]:text-pane-fg",
                  )}
                >
                  <span aria-hidden className="tabular-nums text-[11px] tracking-tight">
                    {r.id === "box" ? <span className="inline-block h-2.5 w-4 rounded-[2px] bg-current align-middle" /> : r.mask ? r.mask.repeat(3) : "ab#"}
                  </span>
                  <span className="@max-[760px]:hidden">{r.label}</span>
                </button>
              ))}
            </FluidList>
            {redact.style === "custom" ? (
              <input
                autoFocus
                value={redact.custom}
                onChange={(e) => pickRedact({ custom: e.target.value })}
                placeholder="Characters"
                aria-label="Characters to redact with"
                maxLength={MASK_MAX * 2}
                className="h-8 w-28 rounded-full border border-pane-border bg-pane px-3 tabular-nums text-[12.5px] outline-none transition-colors focus:border-accent/60 touch:h-11"
              />
            ) : null}
          </div>
        ) : (
          <div className="flex items-center gap-1" role="radiogroup" aria-label="Colour">
            {MARK_COLOURS.map((c) => (
              <Tooltip key={c.id} label={c.label}>
                <button
                  role="radio"
                  aria-checked={colour === c.value}
                  aria-label={c.label}
                  onClick={() => setColour(c.value)}
                  className={cn(
                    "grid size-7 place-items-center rounded-full transition-transform duration-150 hover:scale-110 touch:size-10",
                    colour === c.value && "ring-2 ring-accent ring-offset-2 ring-offset-pane",
                  )}
                >
                  <span className="size-4.5 rounded-full border border-black/10" style={{ background: c.value }} />
                </button>
              </Tooltip>
            ))}
          </div>
        )}

        {tool === "draw" || tool === "text" ? (
          <FluidList tone="pill" axis="x" className="flex rounded-full border border-pane-border p-0.5" aria-label="Size">
            {MARK_SIZES.map((s) => (
              <button
                key={s.id}
                {...FLUID_ITEM}
                aria-pressed={size === s.id}
                onClick={() => setSize(s.id)}
                className={cn(
                  "h-8 rounded-full px-2.5 text-[12px] transition-[background-color,color,font-weight] duration-150 touch:h-11",
                  size === s.id ? "bg-pane-selected font-semibold text-pane-fg" : "text-pane-muted data-[lit]:text-pane-fg",
                )}
              >
                {s.label}
              </button>
            ))}
          </FluidList>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <ToolButton label="Undo" shortcut="annotateUndo" icon={Undo02Icon} disabled={!marks.length} onClick={undo} />
          <ToolButton label="Redo" shortcut="annotateRedo" icon={Redo02Icon} disabled={!undone.length} onClick={redo} />
        </div>
      </div>

      <div className="scroll-fade min-h-0 flex-1 overflow-auto bg-pane-2 p-4">
        <div className="relative mx-auto w-fit max-w-full" data-sensitive>
          <canvas
            ref={view}
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
            aria-label={`Screenshot. ${hint}.`}
            className={cn("block h-auto max-w-full rounded-lg shadow-sm touch-pinch-zoom", tool === "text" ? "cursor-text" : "cursor-crosshair")}
            style={{ width: base.width / scale }}
          />
          {writing ? (
            <textarea
              key={writing.id}
              autoFocus
              value={writing.text}
              rows={Math.max(1, writing.text.split("\n").length)}
              placeholder="Type here"
              onChange={(e) => setWriting({ ...writing, text: e.target.value })}
              onBlur={() => commitText(writing.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitText(writing.id);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  writingNow.current = null;
                  setWriting(null);
                }
              }}
              className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 font-semibold outline-1 outline-offset-2 outline-dashed outline-accent [field-sizing:content] placeholder:text-pane-muted/70"
              style={{
                left: writing.at.x / shown,
                top: writing.at.y / shown,
                minWidth: "4ch",
                color: writing.color,
                fontFamily: "var(--font-ui)",
                fontSize: writing.size / shown,
                lineHeight: TEXT_LINE,
              }}
            />
          ) : null}
        </div>
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-pane-border px-5 py-3">
        {confirming ? (
          <>
            <span className="mr-auto text-[12.5px] text-pane-muted">Close without saving your marks?</span>
            <button onClick={onKeep} className={quiet}>
              Keep editing
            </button>
            <button onClick={onDiscard} className={cn(pill, "border-danger/40 text-danger hover:bg-danger/10")}>
              Discard
            </button>
          </>
        ) : (
          <>
            <span className="mr-auto truncate text-[12px] text-pane-muted">{hint}</span>
            <button onClick={() => void copy()} className={pill}>
              <CopyIcon copied={copied} />
              {copied ? "Copied" : "Copy"}
            </button>
            <button onClick={() => void save()} className={cn(pill, "border-transparent bg-pane-fg text-pane hover:bg-pane-fg/90")}>
              <Icon icon={Download04Icon} size={15} />
              Save image
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

const pill =
  "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-pane-border px-4 text-[13px] font-medium transition-colors duration-150 hover:bg-pane-hover touch:h-11";
const quiet = "h-9 shrink-0 rounded-full px-3 text-[13px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg touch:h-11";

function ToolButton({
  label,
  shortcut,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  shortcut: "annotateUndo" | "annotateRedo";
  icon: IconData;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip label={label} shortcut={shortcut}>
      <button
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className="grid size-8 place-items-center rounded-full text-pane-muted transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg disabled:opacity-40 touch:size-11"
      >
        <Icon icon={icon} size={16} />
      </button>
    </Tooltip>
  );
}
