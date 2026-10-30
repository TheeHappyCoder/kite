"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Calendar03Icon, Cancel01Icon, Drag04Icon } from "@hugeicons/core-free-icons";
import type { PDFPageProxy, PageViewport } from "pdfjs-dist";
import { formatAcrobatDate, TEXT_SIZE, TICK_PATH, type FieldValue, type FormField, type Placed, type PlacedKind } from "@/lib/pdf/fill";
import { blankBox } from "@/lib/pdf/autofill";
import { type Blank } from "@/lib/pdf/labels";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { DateTimePicker } from "../ui/date-time-picker";
import { Select } from "../ui/select";
import { Tooltip } from "../ui/tooltip";

// Fill & sign: fill a PDF's real form fields (Tab walks them in the form's order) or place text,
// a tick, a date and a signature anywhere, then save a new file. The original is never changed,
// and nothing is sent: "Reply with signed copy" only opens a reply with the file attached.
// Loaded with next/dynamic, so pdf.js and pdf-lib download only when the editor opens.

/** Ink for values on the page. The page is paper, so it doesn't follow the pane theme. */
const INK = "#14161f";

/** One page: the pdf.js canvas, rendered when near the screen, with fields and items over it. */
export function PdfPage({
  page,
  index,
  scale,
  annotationMode,
  tool,
  onPlace,
  onBackground,
  children,
}: {
  page: PDFPageProxy;
  index: number;
  scale: number;
  annotationMode: number;
  tool: PlacedKind | null;
  onPlace: (x: number, y: number) => void;
  onBackground: () => void;
  children: (viewport: PageViewport) => React.ReactNode;
}) {
  const viewport = useMemo(() => page.getViewport({ scale }), [page, scale]);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(index < 2);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el || visible) return;
    const observer = new IntersectionObserver(([entry]) => entry.isIntersecting && setVisible(true), { rootMargin: "800px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible]);

  // Renders off-screen and swaps in when done, so zoom changes don't flash.
  useEffect(() => {
    if (!visible) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const scaled = page.getViewport({ scale: scale * ratio });
    const off = document.createElement("canvas");
    off.width = Math.floor(scaled.width);
    off.height = Math.floor(scaled.height);
    const task = page.render({ canvas: off, viewport: scaled, annotationMode });
    task.promise
      .then(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        canvas.width = off.width;
        canvas.height = off.height;
        canvas.getContext("2d")?.drawImage(off, 0, 0);
      })
      .catch(() => {});
    return () => task.cancel();
  }, [page, scale, visible, annotationMode]);

  return (
    <div
      className="relative shrink-0 bg-white shadow-[0_1px_3px_rgba(0,0,0,0.12),0_0_0_1px_var(--pane-border)]"
      style={{ width: viewport.width, height: viewport.height }}
    >
      <canvas ref={canvasRef} aria-label={`Page ${index + 1}`} className="absolute inset-0 size-full" />
      <div
        className={cn("absolute inset-0", tool && "cursor-crosshair")}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (!tool) {
            onBackground();
            return;
          }
          e.preventDefault();
          const box = e.currentTarget.getBoundingClientRect();
          const [x, y] = viewport.convertToPdfPoint(e.clientX - box.left, e.clientY - box.top);
          onPlace(x, y);
        }}
      >
        {children(viewport)}
      </div>
    </div>
  );
}

export function screenRect(viewport: PageViewport, r: { x: number; y: number; width: number; height: number }) {
  const [x1, y1] = viewport.convertToViewportPoint(r.x, r.y) as [number, number];
  const [x2, y2] = viewport.convertToViewportPoint(r.x + r.width, r.y + r.height) as [number, number];
  return {
    left: Math.min(x1, x2),
    top: Math.min(y1, y2),
    width: Math.abs(x2 - x1),
    height: Math.abs(y2 - y1),
  };
}

const fieldClass =
  "absolute rounded-[2px] bg-accent/10 outline-none transition-colors hover:bg-accent/15 focus:bg-accent/15 focus:ring-2 focus:ring-accent disabled:bg-transparent disabled:ring-0";

/** A place "Fill from my profile" left for the user. */
const missingClass = "bg-warning/10 ring-1 ring-warning/80";

export function boxesOverlap(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** A printed blank the profile didn't fill: click to type the answer there. */
export function BlankHint({ blank, viewport, onAnswer }: { blank: Blank; viewport: PageViewport; onAnswer: () => void }) {
  const box = blankBox(blank);
  const r = screenRect(viewport, { x: box.x, y: box.y, width: Math.min(box.w, 220), height: box.h });
  return (
    <Tooltip label={`Type your answer for "${blank.label}"`}>
      <button
        type="button"
        aria-label={`Answer ${blank.label}`}
        onClick={onAnswer}
        className="blur-fade absolute rounded-[2px] border border-dashed border-warning/80 bg-warning/10 hover:bg-warning/20"
        style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      />
    </Tooltip>
  );
}

/** A real form field as a control over its widget, so Tab, arrows and Space work as usual. */
export function FieldControl({
  field,
  viewport,
  scale,
  disabled,
  missing,
  value,
  onChange,
  onSign,
}: {
  field: FormField;
  viewport: PageViewport;
  scale: number;
  disabled: boolean;
  /** Left empty by "Fill from my profile": highlighted for the user. */
  missing?: boolean;
  value: FieldValue | undefined;
  onChange: (value: FieldValue) => void;
  onSign: () => void;
}) {
  // The day last picked from the calendar mark, so it opens there again.
  const [picked, setPicked] = useState("");
  const r = screenRect(viewport, field.rect);
  const box = {
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
    color: INK,
  };
  const fontSize = (field.fontSize ?? Math.max(6, Math.min(field.rect.height * 0.62, 12))) * scale;
  const title = field.label ?? field.name;

  switch (field.kind) {
    case "text":
    case "date": {
      const text = typeof value === "string" ? value : "";
      if (field.multiline) {
        return (
          <textarea
            aria-label={title}
            title={title}
            disabled={disabled}
            value={text}
            maxLength={field.maxLength}
            onChange={(e) => onChange(e.target.value)}
            className={cn(fieldClass, missing && missingClass, "resize-none px-1 py-0.5 leading-tight")}
            style={{ ...box, fontSize }}
          />
        );
      }
      return (
        <>
          <input
            aria-label={title}
            title={field.kind === "date" ? `${title} (${field.dateFormat})` : title}
            disabled={disabled}
            value={text}
            maxLength={field.maxLength}
            placeholder={field.kind === "date" ? field.dateFormat : undefined}
            onChange={(e) => onChange(e.target.value)}
            className={cn(fieldClass, missing && missingClass, "px-1 placeholder:text-black/25", field.kind === "date" && "pr-6")}
            style={{ ...box, fontSize }}
          />
          {field.kind === "date" && !disabled ? (
            <DateTimePicker
              label={`${title}: pick a date`}
              dateOnly
              value={{ date: picked, start: "", end: "" }}
              onChange={({ date }) => {
                setPicked(date);
                onChange(formatAcrobatDate(new Date(`${date}T00:00`), field.dateFormat ?? "dd/mm/yyyy"));
              }}
              trigger={(props) => (
                <button
                  {...props}
                  tabIndex={-1}
                  className="absolute grid place-items-center rounded-[2px] text-black/45 hover:text-black/80"
                  style={{
                    left: r.left + r.width - 22,
                    top: r.top,
                    width: 22,
                    height: r.height,
                  }}
                >
                  <Icon icon={Calendar03Icon} size={Math.min(14, r.height - 2)} />
                </button>
              )}
            />
          ) : null}
        </>
      );
    }
    case "checkbox":
    case "radio": {
      const checked = field.kind === "checkbox" ? value === true : value === field.option && !!field.option;
      return (
        <label className="absolute" style={box} title={field.kind === "radio" ? `${title}: ${field.option}` : title}>
          <input
            type={field.kind}
            name={field.kind === "radio" ? `pdf-field:${field.name}` : undefined}
            aria-label={field.kind === "radio" ? `${title}: ${field.option}` : title}
            disabled={disabled}
            checked={checked}
            onChange={(e) => onChange(field.kind === "checkbox" ? e.target.checked : (field.option ?? ""))}
            onClick={() => {
              // A second click on the chosen radio clears it, like most PDF viewers.
              if (field.kind === "radio" && checked) onChange("");
            }}
            className={cn(fieldClass, missing && missingClass, "inset-0 size-full cursor-pointer appearance-none", field.kind === "radio" && "rounded-full")}
          />
          {checked ? (
            <svg
              viewBox="0 0 24 24"
              className="pointer-events-none absolute inset-[12%]"
              fill="none"
              stroke={INK}
              strokeWidth={2.6}
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              {field.kind === "checkbox" ? <path d={TICK_PATH} /> : <circle cx="12" cy="12" r="6" fill={INK} stroke="none" />}
            </svg>
          ) : null}
        </label>
      );
    }
    case "dropdown":
    case "list":
      return (
        <Select
          label={title}
          title={title}
          variant="borderless"
          disabled={disabled}
          value={typeof value === "string" ? value : ""}
          options={[{ value: "", label: "" }, ...(field.options ?? []).map((o) => ({ value: o, label: o }))]}
          onChange={onChange}
          className={cn(fieldClass, missing && missingClass, "h-auto gap-0.5 rounded-[2px] px-0.5 focus-visible:bg-accent/15")}
          style={{ ...box, fontSize }}
        />
      );
    case "signature":
      return disabled ? null : (
        <button
          type="button"
          onClick={onSign}
          className={cn(fieldClass, "border border-dashed border-accent/60 text-[11px] font-medium text-accent")}
          style={{ ...box, color: undefined }}
        >
          Sign here
        </button>
      );
  }
}

let measure: CanvasRenderingContext2D | null = null;

/** Width of placed text in PDF points (Helvetica, which the copy is written in). */
export function textWidth(text: string, h: number) {
  measure ??= document.createElement("canvas").getContext("2d");
  if (!measure) return h * 4;
  measure.font = `${h * TEXT_SIZE}px Helvetica, Arial, sans-serif`;
  return Math.max(h * 3, measure.measureText(text).width + h * 0.4);
}

/** A placed item: drag to move, the corner handle to resize, × or Delete to remove. */
export function ItemBox({
  item,
  page,
  viewport,
  scale,
  signatureId,
  selected,
  onSelect,
  onChange,
  onRemove,
}: {
  item: Placed;
  page: PDFPageProxy;
  viewport: PageViewport;
  scale: number;
  signatureId: string | null;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Placed>) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const r = screenRect(viewport, {
    x: item.x,
    y: item.y,
    width: item.w,
    height: item.h,
  });
  const textual = item.kind === "text" || item.kind === "date";
  const [x0, y0, x1, y1] = page.view;

  useEffect(() => {
    if (item.kind === "text" && !item.text) inputRef.current?.focus();
    // Only when placed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const drag = (e: React.PointerEvent, mode: "move" | "resize") => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onSelect();
    const start = { x: e.clientX, y: e.clientY, item };
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / scale;
      const dy = (ev.clientY - start.y) / scale;
      const s = start.item;
      if (mode === "move") {
        onChange({
          x: clamp(s.x + dx, x0 - s.w / 2, x1 - s.w / 2),
          y: clamp(s.y - dy, y0 - s.h / 2, y1 - s.h / 2),
        });
        return;
      }
      // Resize from the bottom-right corner, keeping the top-left in place and the shape.
      const factor = Math.max(0.25, (s.w + dx) / s.w);
      const h = clamp(s.h * factor, 6, 200);
      const w = textual ? textWidth(s.text ?? "", h) : (s.w / s.h) * h;
      onChange({ w, h, y: s.y + s.h - h });
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className={cn("group absolute", !textual && "cursor-move", selected ? "z-10 ring-1 ring-accent" : "hover:ring-1 hover:ring-accent/50")}
      style={{ left: r.left, top: r.top, width: r.width, height: r.height }}
      onPointerDown={(e) => (textual ? onSelect() : drag(e, "move"))}
    >
      {textual ? (
        <input
          ref={inputRef}
          aria-label={item.kind === "date" ? "Date" : "Text"}
          value={item.text ?? ""}
          onFocus={onSelect}
          onChange={(e) =>
            onChange({
              text: e.target.value,
              w: textWidth(e.target.value, item.h),
            })
          }
          onBlur={() => {
            if (!item.text?.trim()) onRemove();
          }}
          className="block size-full bg-transparent p-0 outline-none"
          style={{
            fontSize: item.h * TEXT_SIZE * scale,
            lineHeight: `${item.h * scale}px`,
            fontFamily: "Helvetica, Arial, sans-serif",
            color: INK,
          }}
        />
      ) : item.kind === "tick" ? (
        <svg
          viewBox="0 0 24 24"
          className="pointer-events-none size-full"
          fill="none"
          stroke={INK}
          strokeWidth={2.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d={TICK_PATH} />
        </svg>
      ) : signatureId ? (
        // eslint-disable-next-line @next/next/no-img-element -- the user's own signature from data/assets
        <img src={`/api/assets/${signatureId}`} alt="Your signature" draggable={false} className="pointer-events-none size-full select-none" />
      ) : null}

      {selected ? (
        <>
          {textual ? (
            <Tooltip label="Drag to move">
              <span
                onPointerDown={(e) => drag(e, "move")}
                className="absolute -left-6 top-1/2 grid size-5 -translate-y-1/2 cursor-move place-items-center rounded-full bg-pane text-pane-muted shadow-sm ring-1 ring-pane-border"
              >
                <Icon icon={Drag04Icon} size={12} />
              </span>
            </Tooltip>
          ) : null}
          <Tooltip label="Remove">
            <button
              aria-label="Remove"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={onRemove}
              className="absolute -right-2.5 -top-2.5 grid size-5 place-items-center rounded-full bg-pane text-pane-muted shadow-sm ring-1 ring-pane-border hover:text-pane-fg"
            >
              <Icon icon={Cancel01Icon} size={11} />
            </button>
          </Tooltip>
          <span
            aria-hidden
            onPointerDown={(e) => drag(e, "resize")}
            className="absolute -bottom-1.5 -right-1.5 size-3 cursor-nwse-resize rounded-full bg-accent ring-2 ring-pane"
          />
        </>
      ) : null}
    </div>
  );
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}
