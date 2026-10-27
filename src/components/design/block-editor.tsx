"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Add01Icon,
  ArrowDown01Icon,
  ArrowExpandIcon,
  ArrowUp01Icon,
  CursorPointer01Icon,
  Delete02Icon,
  HeadingIcon,
  Image01Icon,
  LayoutTwoColumnIcon,
  Link01Icon,
  MinusSignIcon,
  TextBoldIcon,
  TextIcon,
  TextItalicIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import type { DesignAsset } from "@/lib/design/prompt";
import { assetId, type Block, type ColumnsBlock, type DesignTheme, type LeafBlock } from "@/lib/design/spec";
import { blurFade, springSnappy } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { ASSET_WARN } from "./assets";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
type Kind = Block["type"];

const KINDS: { type: Kind; label: string; icon: IconData }[] = [
  { type: "text", label: "Text", icon: TextIcon },
  { type: "heading", label: "Heading", icon: HeadingIcon },
  { type: "image", label: "Image", icon: Image01Icon },
  { type: "button", label: "Button", icon: CursorPointer01Icon },
  { type: "divider", label: "Divider", icon: MinusSignIcon },
  { type: "spacer", label: "Space", icon: ArrowExpandIcon },
  { type: "columns", label: "Columns", icon: LayoutTwoColumnIcon },
];

function newBlock(type: Kind): Block {
  switch (type) {
    case "text":
      return { type, text: "", size: "md", align: "left", bold: false, caps: false };
    case "heading":
      return { type, text: "", level: 2, align: "left" };
    case "image":
      return { type, src: "", alt: "", width: 120, align: "left", radius: 0 };
    case "button":
      return { type, label: "", href: "https://", align: "left" };
    case "divider":
      return { type };
    case "spacer":
      return { type, height: 16 };
    case "columns":
      return { type, columns: [{ blocks: [] }, { blocks: [] }], gap: 16, valign: "top" };
  }
}

function summary(block: Block): string {
  switch (block.type) {
    case "text":
    case "heading":
      return block.text.replace(/\*\*|\*|\[([^\]]*)\]\([^)]*\)/g, "$1").split("\n")[0] || "Empty";
    case "image":
      return block.alt || (block.src ? "No alt text" : "No image yet");
    case "button":
      return block.label || "No label";
    case "divider":
      return "Line";
    case "spacer":
      return `${block.height}px`;
    case "columns":
      return (
        block.columns
          .flatMap((c) => c.blocks.filter((b) => b.type !== "spacer" && b.type !== "divider"))
          .slice(0, 3)
          .map((b): string => (b.type === "image" ? "Image" : summary(b)))
          .join(", ") || `${block.columns.length} columns`
      );
  }
}

export type EditorContext = {
  /** The part picked inside the open columns block: [column, part]. */
  part?: [number, number] | null;
  /** Opens (or closes, with null) a part inside columns block `block`. */
  onPart?: (block: number, column: number, part: number | null) => void;
  theme: DesignTheme;
  assets: DesignAsset[];
  onUpload: (file: File) => Promise<DesignAsset | null>;
  /** First-frame stills for GIF assets. */
  stills: Record<string, string>;
  /** The top-level block this inspector belongs to (set by the list). */
  index?: number;
};

export function BlockList<T extends Block>({
  blocks,
  onChange,
  context,
  nested = false,
  open: openProp,
  onOpen,
}: {
  blocks: T[];
  onChange: (blocks: T[]) => void;
  context: EditorContext;
  nested?: boolean;
  /** Which block is open, when the editor drives it (a click in the preview selects one). */
  open?: number | null;
  onOpen?: (index: number | null) => void;
}) {
  const [ownOpen, setOwnOpen] = useState<number | null>(null);
  const open = onOpen ? (openProp ?? null) : ownOpen;
  const setOpen = (next: number | null | ((current: number | null) => number | null)) => {
    const value = typeof next === "function" ? next(open) : next;
    if (onOpen) onOpen(value);
    else setOwnOpen(value);
  };

  // What opens (here or from a click in the preview) comes into view.
  const items = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    if (open === null) return;
    const timer = setTimeout(() => items.current[open]?.scrollIntoView({ behavior: "smooth", block: "nearest" }), 120);
    return () => clearTimeout(timer);
  }, [open]);

  const update = (index: number, block: T) => onChange(blocks.map((b, i) => (i === index ? block : b)));
  const move = (index: number, delta: number) => {
    const next = [...blocks];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    onChange(next);
    setOpen((o) => (o === index ? index + delta : o));
  };
  const remove = (index: number) => {
    onChange(blocks.filter((_, i) => i !== index));
    setOpen(null);
  };
  const add = (type: Kind) => {
    onChange([...blocks, newBlock(type) as T]);
    setOpen(blocks.length);
  };

  return (
    <div className="flex flex-col gap-1.5">
      {blocks.map((block, index) => {
        const kind = KINDS.find((k) => k.type === block.type)!;
        const expanded = open === index;
        return (
          <div
            key={index}
            ref={(el) => {
              items.current[index] = el;
            }}
            className={cn("scroll-mt-3 rounded-xl border bg-pane transition-colors", expanded ? "border-accent/40" : "border-pane-border")}
          >
            <div className="flex items-center gap-2 py-1.5 pl-2.5 pr-1.5">
              <button onClick={() => setOpen(expanded ? null : index)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                <Icon icon={kind.icon} size={14} className="shrink-0 text-pane-muted" />
                <span className="shrink-0 text-[12.5px] font-medium">{kind.label}</span>
                <span className="truncate text-[12px] text-pane-muted">{summary(block)}</span>
              </button>
              <MiniButton icon={ArrowUp01Icon} label="Move up" disabled={index === 0} onClick={() => move(index, -1)} />
              <MiniButton icon={ArrowDown01Icon} label="Move down" disabled={index === blocks.length - 1} onClick={() => move(index, 1)} />
              <MiniButton icon={Delete02Icon} label="Remove block" onClick={() => remove(index)} />
            </div>
            <AnimatePresence initial={false}>
              {expanded ? (
                <motion.div {...blurFade({ y: -4 })} className="border-t border-pane-border px-3 pb-3 pt-2.5">
                  <Inspector block={block} onChange={(b) => update(index, b as T)} context={{ ...context, index }} />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
      <AddMenu nested={nested} onAdd={add} />
    </div>
  );
}

function AddMenu({ nested, onAdd }: { nested: boolean; onAdd: (type: Kind) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-1 pt-1">
      <Icon icon={Add01Icon} size={13} className="mr-0.5 text-pane-muted" />
      {KINDS.filter((k) => !nested || k.type !== "columns").map((k) => (
        <button
          key={k.type}
          onClick={() => onAdd(k.type)}
          className="flex h-7 items-center gap-1.5 rounded-full border border-pane-border px-2.5 text-[11.5px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
        >
          <Icon icon={k.icon} size={12} />
          {k.label}
        </button>
      ))}
    </div>
  );
}

function MiniButton({ icon, label, onClick, disabled }: { icon: IconData; label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Tooltip label={label} side="top">
      <button
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        className="grid size-6 shrink-0 place-items-center rounded-md text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg disabled:opacity-30 disabled:hover:bg-transparent"
      >
        <Icon icon={icon} size={13} />
      </button>
    </Tooltip>
  );
}

// ---------------------------------------------------------------------------
// Inspectors
// ---------------------------------------------------------------------------

function Inspector({ block, onChange, context }: { block: Block; onChange: (block: Block) => void; context: EditorContext }) {
  const set = <B extends Block>(patch: Partial<B>) => onChange({ ...block, ...patch } as Block);
  switch (block.type) {
    case "text":
      return (
        <Fields>
          <RichTextField value={block.text} onChange={(text) => set({ text })} />
          <Row label="Size">
            <Segmented value={block.size} options={[["sm", "Small"], ["md", "Normal"], ["lg", "Large"]]} onChange={(size) => set({ size })} />
          </Row>
          <Row label="Align">
            <AlignField value={block.align} onChange={(align) => set({ align })} />
          </Row>
          <Row label="Style">
            <Segmented
              value={block.caps ? "caps" : block.bold ? "bold" : "regular"}
              options={[["regular", "Regular"], ["bold", "Bold"], ["caps", "Label"]]}
              onChange={(v) => set({ bold: v === "bold", caps: v === "caps" })}
            />
          </Row>
          <Row label="Colour">
            <ColorField value={block.color} fallback={block.size === "sm" ? context.theme.muted : context.theme.text} onChange={(color) => set({ color })} />
          </Row>
        </Fields>
      );
    case "heading":
      return (
        <Fields>
          <Input value={block.text} placeholder="Heading" onChange={(text) => set({ text })} />
          <Row label="Level">
            <Segmented value={String(block.level)} options={[["1", "Large"], ["2", "Medium"], ["3", "Small"]]} onChange={(v) => set({ level: Number(v) as 1 | 2 | 3 })} />
          </Row>
          <Row label="Align">
            <AlignField value={block.align} onChange={(align) => set({ align })} />
          </Row>
          <Row label="Colour">
            <ColorField value={block.color} fallback={context.theme.text} onChange={(color) => set({ color })} />
          </Row>
        </Fields>
      );
    case "image":
      return <ImageInspector block={block} onChange={onChange} context={context} />;
    case "button":
      return (
        <Fields>
          <Input value={block.label} placeholder="Button label" onChange={(label) => set({ label })} />
          <Input value={block.href} placeholder="https://…" mono onChange={(href) => set({ href })} />
          <Row label="Align">
            <AlignField value={block.align} onChange={(align) => set({ align })} />
          </Row>
          <Row label="Colour">
            <ColorField value={block.color} fallback={context.theme.accent} onChange={(color) => set({ color })} />
          </Row>
          <Row label="Text">
            <ColorField value={block.textColor} fallback="#ffffff" onChange={(textColor) => set({ textColor })} />
          </Row>
        </Fields>
      );
    case "divider":
      return (
        <Row label="Colour">
          <ColorField value={block.color} fallback="#e3e3e8" onChange={(color) => set({ color })} />
        </Row>
      );
    case "spacer":
      return (
        <Row label="Height">
          <NumberField value={block.height} min={4} max={80} suffix="px" onChange={(height) => set({ height: height ?? 16 })} />
        </Row>
      );
    case "columns":
      return <ColumnsInspector block={block} onChange={onChange} context={context} />;
  }
}

function ColumnsInspector({ block, onChange, context }: { block: ColumnsBlock; onChange: (block: Block) => void; context: EditorContext }) {
  const setColumns = (columns: ColumnsBlock["columns"]) => onChange({ ...block, columns });
  return (
    <Fields>
      <Row label="Columns">
        <Segmented
          value={String(block.columns.length)}
          options={[["2", "Two"], ["3", "Three"]]}
          onChange={(v) => {
            const n = Number(v);
            setColumns(n > block.columns.length ? [...block.columns, { blocks: [] }] : block.columns.slice(0, n));
          }}
        />
      </Row>
      <Row label="Align">
        <Segmented value={block.valign} options={[["top", "Top"], ["middle", "Middle"], ["bottom", "Bottom"]]} onChange={(valign) => onChange({ ...block, valign })} />
      </Row>
      <Row label="Gap">
        <NumberField value={block.gap} min={0} max={48} suffix="px" onChange={(gap) => onChange({ ...block, gap: gap ?? 0 })} />
      </Row>
      <Row label="Line">
        <Segmented
          value={block.rule ? "on" : "off"}
          options={[["off", "None"], ["on", "Between"]]}
          onChange={(v) => onChange({ ...block, rule: v === "on" ? "#e3e3e8" : undefined })}
        />
        {block.rule ? (
          <span className="ml-2">
            <ColorField value={block.rule} fallback="#e3e3e8" onChange={(rule) => onChange({ ...block, rule: rule ?? "#e3e3e8" })} />
          </span>
        ) : null}
      </Row>
      {block.columns.map((column, i) => (
        <div key={i} className="rounded-lg bg-pane-2 p-2">
          <div className="mb-1.5 flex items-center gap-2 px-0.5">
            <span className="flex-1 text-[11.5px] font-medium uppercase tracking-wide text-pane-muted">Column {i + 1}</span>
            <NumberField
              value={column.width}
              min={10}
              max={90}
              suffix="%"
              placeholder="auto"
              onChange={(width) => setColumns(block.columns.map((c, j) => (j === i ? { ...c, width } : c)))}
            />
          </div>
          <BlockList<LeafBlock>
            nested
            blocks={column.blocks}
            context={context}
            {...(context.onPart && context.index !== undefined
              ? {
                  open: context.part?.[0] === i ? context.part[1] : null,
                  onOpen: (part: number | null) => context.onPart!(context.index!, i, part),
                }
              : {})}
            onChange={(blocks) => setColumns(block.columns.map((c, j) => (j === i ? { ...c, blocks } : c)))}
          />
        </div>
      ))}
    </Fields>
  );
}

function ImageInspector({ block, onChange, context }: { block: Extract<Block, { type: "image" }>; onChange: (block: Block) => void; context: EditorContext }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const id = assetId(block.src);
  const asset = id ? context.assets.find((a) => a.id === id) : undefined;
  const placeholder = !!asset?.name.startsWith("Placeholder ");
  const set = (patch: Partial<typeof block>) => onChange({ ...block, ...patch });

  const choose = (a: DesignAsset) =>
    set({
      src: `asset:${a.id}`,
      // Keep the size the design gave it; a fresh image starts at its own width (up to 600).
      width: block.src ? block.width : Math.min(a.width, 600),
      alt: placeholder || !block.alt ? a.name.replace(/\.[^.]+$/, "") : block.alt,
    });
  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const uploaded = await context.onUpload(file);
    setBusy(false);
    if (uploaded) choose(uploaded);
  };
  const others = context.assets.filter((a) => !a.name.startsWith("Placeholder "));

  return (
    <Fields>
      {/* Drop or click: a photo, a logo or a GIF. */}
      <button
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          void upload(e.dataTransfer.files[0]);
        }}
        disabled={busy}
        className={cn(
          "group relative flex items-center gap-3 rounded-xl border border-dashed p-3 text-left transition-colors duration-150",
          over ? "border-accent bg-accent-soft" : "border-pane-border hover:border-pane-muted hover:bg-pane-2",
        )}
      >
        <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-lg border border-pane-border bg-white">
          {block.src ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={id ? `/api/assets/${id}` : block.src} alt="" className="max-h-full max-w-full object-contain" />
          ) : (
            <Icon icon={Image01Icon} size={18} className="text-pane-muted" />
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-1.5 text-[13px] font-medium">
            {busy ? <Spinner size={13} /> : <Icon icon={Upload01Icon} size={14} />}
            {busy ? "Adding it…" : placeholder || !block.src ? "Add your photo, logo or GIF" : "Replace the image"}
          </span>
          <span className="text-[11.5px] leading-snug text-pane-muted">
            {placeholder ? "This one is a placeholder. " : ""}Drop it here or click. PNG, JPG, GIF or WebP, up to 512 KB.
          </span>
          {asset && !placeholder ? (
            <span className={cn("text-[11.5px]", asset.bytes > ASSET_WARN ? "text-warning" : "text-pane-muted")}>
              {asset.width}×{asset.height}px · {Math.round(asset.bytes / 1024)} KB
              {asset.bytes > ASSET_WARN ? ". Heavy for something in every email" : ""}
            </span>
          ) : null}
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void upload(file);
        }}
      />

      {others.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-[11.5px] text-pane-muted">Or one you&apos;ve added before</span>
          <div className="flex flex-wrap gap-1.5">
            {others.map((a) => (
              <Tooltip key={a.id} label={a.name} side="top">
                <button
                  onClick={() => choose(a)}
                  className={cn("grid size-10 place-items-center overflow-hidden rounded-md border bg-white", a.id === id ? "border-accent" : "border-pane-border hover:border-pane-muted")}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={`/api/assets/${a.id}`} alt={a.name} className="max-h-full max-w-full object-contain" />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
      ) : null}

      {asset?.contentType === "image/gif" ? (
        <div className="flex items-center gap-3 rounded-lg bg-pane-2 p-2.5">
          <div className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-white">
            {context.stills[asset.id] ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={context.stills[asset.id]} alt="" className="max-h-full max-w-full object-contain" />
            ) : null}
          </div>
          <p className="text-[11.5px] leading-snug text-pane-muted">
            It moves in Gmail, Apple Mail and on phones. Outlook on Windows shows this first frame, so make it work on its own.
          </p>
        </div>
      ) : null}

      <label className="block">
        <span className="mb-1 block text-[11.5px] text-pane-muted">If images are off, people see</span>
        <Input value={block.alt} placeholder="e.g. Thandi Nkosi, or Kite logo" onChange={(alt) => set({ alt })} invalid={!!block.src && !block.alt.trim()} />
      </label>
      <Row label="Size">
        <NumberField value={block.width} min={16} max={600} suffix="px" onChange={(width) => set({ width: width ?? 120 })} />
      </Row>
      <Row label="Shape">
        <Segmented
          value={block.radius === 0 ? "square" : block.radius >= block.width / 2 ? "round" : "soft"}
          options={[["square", "Square"], ["soft", "Soft"], ["round", "Round"]]}
          onChange={(v) => set({ radius: v === "square" ? 0 : v === "round" ? Math.ceil(block.width / 2) : 12 })}
        />
      </Row>
      <Row label="Align">
        <AlignField value={block.align} onChange={(align) => set({ align })} />
      </Row>
      <Input value={block.href ?? ""} placeholder="Opens when clicked (optional): https://…" onChange={(href) => set({ href: href || undefined })} />
      {!id ? <Input value={block.src} placeholder="…or an image already on the web: https://…" mono onChange={(src) => set({ src })} /> : null}
    </Fields>
  );
}

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function Fields({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2.5">{children}</div>;
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-[12px] text-pane-muted">{label}</span>
      <div className="flex min-w-0 flex-1 items-center">{children}</div>
    </div>
  );
}

const inputClass =
  "h-8 w-full rounded-lg border border-pane-border bg-pane-2 px-2.5 text-[12.5px] outline-none placeholder:text-pane-muted/80 focus:border-accent/60";

function Input({
  value,
  onChange,
  placeholder,
  mono,
  invalid,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  invalid?: boolean;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={cn(inputClass, mono && "tabular-nums text-[11.5px]", invalid && "border-warning/70")}
    />
  );
}

function NumberField({
  value,
  onChange,
  min,
  max,
  suffix,
  placeholder,
}: {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  min: number;
  max: number;
  suffix: string;
  placeholder?: string;
}) {
  return (
    <label className="flex h-7 w-[92px] items-center rounded-lg border border-pane-border bg-pane-2 pr-2 focus-within:border-accent/60">
      <input
        type="number"
        min={min}
        max={max}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(undefined);
          onChange(Math.min(max, Math.max(min, Math.round(Number(raw)))));
        }}
        className="w-full min-w-0 bg-transparent px-2 text-[12px] tabular-nums outline-none placeholder:text-pane-muted [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
      />
      <span className="text-[11px] text-pane-muted">{suffix}</span>
    </label>
  );
}

export function ColorField({ value, fallback, onChange }: { value: string | undefined; fallback: string; onChange: (value: string | undefined) => void }) {
  const [text, setText] = useState(value ?? "");
  const shown = value ?? fallback;
  return (
    <div className="flex items-center gap-2">
      <label className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-full border border-pane-border" style={{ background: shown }}>
        <input
          type="color"
          value={shown}
          onChange={(e) => {
            setText(e.target.value);
            onChange(e.target.value);
          }}
          className="absolute inset-0 cursor-pointer opacity-0"
          aria-label="Pick a colour"
        />
      </label>
      <input
        value={text}
        placeholder={fallback}
        onChange={(e) => {
          setText(e.target.value);
          if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value);
          if (!e.target.value) onChange(undefined);
        }}
        className="h-7 w-[84px] rounded-lg border border-pane-border bg-pane-2 px-2 tabular-nums text-[11.5px] outline-none placeholder:text-pane-muted focus:border-accent/60"
      />
      {value ? (
        <button
          onClick={() => {
            setText("");
            onChange(undefined);
          }}
          className="text-[11.5px] text-pane-muted hover:text-pane-fg"
        >
          Default
        </button>
      ) : null}
    </div>
  );
}

export function Segmented<V extends string>({
  value,
  options,
  onChange,
  fill,
}: {
  value: V;
  options: [V, string][];
  onChange: (value: V) => void;
  /** Spread the options evenly across the row (top-level tabs); otherwise the track hugs them. */
  fill?: boolean;
}) {
  const id = useId();
  return (
    <FluidList
      axis="x"
      tone="pill"
      className={cn("flex items-center rounded-full bg-pane-2 p-[2px] shadow-[inset_0_0_0_1px_var(--pane-border)]", fill ? "w-full" : "w-fit")}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          {...FLUID_ITEM}
          onClick={() => onChange(v)}
          className={cn(
            "relative h-6 rounded-full px-2.5 text-[11.5px] transition-[color,background-color,font-weight] duration-150",
            fill && "h-7 flex-1 text-[12px]",
            v === value ? "font-semibold text-pane-fg" : "font-medium text-pane-muted data-[lit]:text-pane-fg",
          )}
        >
          {v === value ? (
            <motion.span
              layoutId={`seg-${id}`}
              transition={springSnappy}
              className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
            />
          ) : null}
          <span className="relative">{label}</span>
        </button>
      ))}
    </FluidList>
  );
}

function AlignField({ value, onChange }: { value: "left" | "center" | "right"; onChange: (value: "left" | "center" | "right") => void }) {
  return <Segmented value={value} options={[["left", "Left"], ["center", "Centre"], ["right", "Right"]]} onChange={onChange} />;
}

const MARKUP_TOOLS: { icon: IconData; label: string; wrap: [string, string, string] }[] = [
  { icon: TextBoldIcon, label: "Bold", wrap: ["**", "**", "bold"] },
  { icon: TextItalicIcon, label: "Italic", wrap: ["*", "*", "italic"] },
  { icon: Link01Icon, label: "Link", wrap: ["[", "](https://)", "link text"] },
];

/** A textarea for inline markup with buttons that wrap the selection. */
function RichTextField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const wrap = (before: string, after: string, placeholder: string) => {
    const el = ref.current;
    if (!el) return;
    const { selectionStart: start, selectionEnd: end } = el;
    const selected = value.slice(start, end) || placeholder;
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + before.length, start + before.length + selected.length);
    });
  };


  return (
    <div className="rounded-lg border border-pane-border bg-pane-2 focus-within:border-accent/60">
      <div className="flex items-center gap-0.5 border-b border-pane-border px-1.5 py-1">
        {MARKUP_TOOLS.map((t) => (
          <MiniButton key={t.label} icon={t.icon} label={t.label} onClick={() => wrap(...t.wrap)} />
        ))}
        <span className="ml-auto pr-1 text-[10.5px] text-pane-muted">**bold** *italic* [link](https://…)</span>
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        placeholder="Text"
        className="block w-full resize-y bg-transparent px-2.5 py-2 text-[12.5px] leading-5 outline-none placeholder:text-pane-muted/80"
      />
    </div>
  );
}
