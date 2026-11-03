"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Link01Icon, TextBoldIcon, TextColorIcon, TextItalicIcon, Unlink01Icon } from "@hugeicons/core-free-icons";
import { escapeDesignText, inlineToHtml } from "@/lib/design/inline";
import { FONT_STACKS } from "@/lib/design/compile";
import type { DesignTheme } from "@/lib/design/spec";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { useDismiss } from "../ui/use-dismiss";

// A design text block's text, edited as it will look: select words and make them bold,
// italic, a link or another colour. It reads and writes the inline markup of
// lib/design/inline.ts, so nobody types ** or {#hex|…} by hand.

type Run = { text: string; bold: boolean; italic: boolean; href: string | null; colour: string | null };
type Style = Omit<Run, "text">;

const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)\S+$/i;
const BLOCK = new Set(["DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "TR", "TABLE"]);
const SKIP = new Set(["STYLE", "SCRIPT", "HEAD", "TITLE", "META", "TEMPLATE", "IMG", "SVG"]);

/** "rgb(22, 163, 74)" or "#16A34A" -> "#16a34a"; anything else (named, transparent) -> null. */
function toHex(value: string | null | undefined) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  if (/^#[0-9a-f]{3}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`;
  const rgb = v.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!rgb || (rgb[4] !== undefined && Number(rgb[4]) === 0)) return null;
  return `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}

function emphasis(run: Run) {
  const text = escapeDesignText(run.text);
  if (!run.bold && !run.italic) return text;
  const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  if (!core) return text;
  const mark = run.bold && run.italic ? "***" : run.bold ? "**" : "*";
  return `${lead}${mark}${core}${mark}${trail}`;
}

/** Runs of one colour as markup; a run in the block's own colour needs no mark. */
function coloured(runs: Run[], plain: string | null) {
  let out = "";
  for (let i = 0; i < runs.length; ) {
    const colour = runs[i].colour;
    let inner = "";
    for (; i < runs.length && runs[i].colour === colour; i++) inner += emphasis(runs[i]);
    out += colour && colour !== plain && inner.trim() ? `{${colour}|${inner}}` : inner;
  }
  return out;
}

/** One line (no breaks inside) as markup: links outermost unless the whole link is one colour. */
function lineMarkup(runs: Run[], plain: string | null) {
  let out = "";
  for (let i = 0; i < runs.length; ) {
    const href = runs[i].href;
    const group: Run[] = [];
    for (; i < runs.length && runs[i].href === href; i++) group.push(runs[i]);
    if (!href) {
      out += coloured(group, plain);
      continue;
    }
    const url = href.replace(/\)/g, "%29").replace(/\s/g, "%20");
    const one = group.every((r) => r.colour === group[0].colour) ? group[0].colour : undefined;
    if (one !== undefined) {
      const label = group.map(emphasis).join("");
      out += one && one !== plain ? `{${one}|[${label}](${url})}` : `[${label}](${url})`;
    } else {
      out += `[${coloured(group, plain)}](${url})`;
    }
  }
  return out;
}

/** The editor's DOM back as design markup. `plain` is the block's own colour (colours equal to it are dropped). */
function serialize(root: HTMLElement, plain: string | null) {
  const runs: Run[] = [];
  const newline = () => runs.push({ text: "\n", bold: false, italic: false, href: null, colour: null });
  const walk = (node: Node, style: Style) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? "").replace(/ /g, " ").replace(/​/g, "");
      text.split("\n").forEach((part, i) => {
        if (i > 0) newline();
        if (part) runs.push({ text: part, ...style });
      });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (SKIP.has(tag)) return;
    if (tag === "BR") return void newline();
    const next: Style = { ...style };
    const weight = el.style.fontWeight;
    if (tag === "B" || tag === "STRONG" || weight === "bold" || Number(weight) >= 600) next.bold = true;
    else if (weight === "normal" || (Number(weight) > 0 && Number(weight) < 600)) next.bold = false;
    if (tag === "I" || tag === "EM" || el.style.fontStyle === "italic") next.italic = true;
    else if (el.style.fontStyle === "normal") next.italic = false;
    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      next.href = SAFE_HREF.test(href) ? href : null;
    }
    const colour = toHex(el.style.color) ?? (tag === "FONT" ? toHex(el.getAttribute("color")) : null);
    if (colour) next.colour = colour;
    const block = BLOCK.has(tag);
    if (block && runs.length && runs[runs.length - 1].text !== "\n") newline();
    el.childNodes.forEach((child) => walk(child, next));
    if (block && runs.length && runs[runs.length - 1].text !== "\n") newline();
  };
  root.childNodes.forEach((child) => walk(child, { bold: false, italic: false, href: null, colour: null }));

  const lines: Run[][] = [[]];
  for (const run of runs) {
    if (run.text === "\n") lines.push([]);
    else {
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.bold === run.bold && last.italic === run.italic && last.href === run.href && last.colour === run.colour) last.text += run.text;
      else line.push({ ...run });
    }
  }
  return lines
    .map((line) => lineMarkup(line, plain))
    .join("\n")
    .replace(/\s+$/, "");
}

/** Markup -> the editor's HTML: plain tags and colour spans the serializer reads back. */
function editorHtml(markup: string) {
  return inlineToHtml(markup, {
    link: (href, label) => `<a href="${href}">${label}</a>`,
    colour: (hex, inner) => `<span style="color:${hex}">${inner}</span>`,
  });
}

function normaliseHref(value: string) {
  const v = value.trim();
  if (!v) return "";
  if (SAFE_HREF.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  if (/^\+?[\d\s().-]{6,}$/.test(v)) return `tel:${v.replace(/[^\d+]/g, "")}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return `https://${v}`;
  return "";
}

function exec(command: string, value?: string) {
  document.execCommand("styleWithCSS", false, "true");
  document.execCommand(command, false, value);
}

export function DesignTextField({
  value,
  onChange,
  theme,
  colour,
  size = 14,
  placeholder = "Text",
}: {
  value: string;
  onChange: (value: string) => void;
  theme: DesignTheme;
  /** The block's own colour: text in it carries no colour mark. */
  colour: string;
  size?: number;
  placeholder?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const saved = useRef<Range | null>(null);
  const [panel, setPanel] = useState<"link" | "colour" | null>(null);
  const [inLink, setInLink] = useState<string | null>(null);

  // Only a change from outside (another block picked, Undo, a template) redraws the field.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || value === emitted.current) return;
    el.innerHTML = editorHtml(value);
    emitted.current = value;
  }, [value]);

  const plain = colour.toLowerCase();
  const read = () => {
    const el = ref.current;
    if (!el) return;
    const markup = serialize(el, plain);
    emitted.current = markup;
    if (markup !== value) onChange(markup);
  };

  /** The selection, if it's inside this field. */
  const range = () => {
    const sel = window.getSelection();
    if (!sel?.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return ref.current?.contains(r.commonAncestorContainer) ? r : null;
  };

  useEffect(() => {
    const track = () => {
      const r = range();
      if (!r) return;
      saved.current = r.cloneRange();
      const node = r.startContainer;
      const anchor = (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement)?.closest("a");
      setInLink(anchor && ref.current?.contains(anchor) ? anchor.getAttribute("href") : null);
    };
    document.addEventListener("selectionchange", track);
    return () => document.removeEventListener("selectionchange", track);
  }, []);

  /** Puts the last selection in this field back, then runs a command on it. */
  const apply = (command: string, arg?: string) => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (saved.current && sel) {
      sel.removeAllRanges();
      sel.addRange(saved.current);
    }
    exec(command, arg);
    read();
  };

  const selectLink = () => {
    const r = range() ?? saved.current;
    const node = r?.startContainer;
    const anchor = (node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : node?.parentElement)?.closest("a");
    if (!anchor || !ref.current?.contains(anchor)) return;
    const whole = document.createRange();
    whole.selectNodeContents(anchor);
    saved.current = whole;
  };

  return (
    <div className="rounded-lg border border-pane-border bg-pane-2 focus-within:border-accent/60">
      <div ref={bar} className="relative flex items-center gap-0.5 border-b border-pane-border px-1.5 py-1">
        <Tool icon={TextBoldIcon} label="Bold" onClick={() => apply("bold")} />
        <Tool icon={TextItalicIcon} label="Italic" onClick={() => apply("italic")} />
        <Tool icon={Link01Icon} label={inLink ? "Change link" : "Link"} active={panel === "link"} onClick={() => setPanel(panel === "link" ? null : "link")} />
        {inLink ? (
          <Tool
            icon={Unlink01Icon}
            label="Remove link"
            onClick={() => {
              selectLink();
              apply("unlink");
            }}
          />
        ) : null}
        <Tool icon={TextColorIcon} label="Colour" active={panel === "colour"} onClick={() => setPanel(panel === "colour" ? null : "colour")} />
        <span className="ml-auto truncate pl-2 pr-1 text-[10.5px] text-pane-muted">Select words to style them</span>
        {panel === "link" ? (
          <LinkPanel
            root={bar}
            initial={inLink ?? ""}
            onDone={(href) => {
              setPanel(null);
              if (!href) return;
              if (inLink) selectLink();
              const r = saved.current;
              if (r && r.collapsed) {
                // Nothing selected: the link's address goes in as its own text.
                const label = href.replace(/^(mailto:|tel:)/, "");
                apply("insertHTML", `<a href="${href.replace(/"/g, "%22")}">${label.replace(/[<>&]/g, "")}</a>`);
              } else apply("createLink", href);
            }}
            onClose={() => setPanel(null)}
          />
        ) : null}
        {panel === "colour" ? (
          <ColourPanel
            root={bar}
            theme={theme}
            plain={plain}
            onPick={(hex) => {
              setPanel(null);
              apply("foreColor", hex);
            }}
            onClose={() => setPanel(null)}
          />
        ) : null}
      </div>
      <div className="relative rounded-b-lg bg-white">
        <div
          ref={ref}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline
          aria-label={placeholder}
          onInput={read}
          onBlur={read}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              exec("insertLineBreak");
              read();
            }
          }}
          onPaste={(e) => {
            e.preventDefault();
            exec("insertText", e.clipboardData.getData("text/plain"));
            read();
          }}
          // Links as they'll go: underlined in the accent (classic) or quiet in the text's colour (modern).
          style={{ fontFamily: FONT_STACKS[theme.font], color: colour, fontSize: size, lineHeight: 1.5, ["--link" as string]: theme.look === "modern" ? colour : theme.accent }}
          className={cn("min-h-[68px] whitespace-pre-wrap break-words px-2.5 py-2 outline-none [&_a]:text-[var(--link)]", theme.look === "modern" ? "[&_a]:no-underline" : "[&_a]:underline")}
        />
        {!value.trim() ? <span className="pointer-events-none absolute left-2.5 top-2 text-[12.5px] text-[#9a9aa3]">{placeholder}</span> : null}
      </div>
    </div>
  );
}

function Tool({ icon, label, onClick, active }: { icon: IconData; label: string; onClick: () => void; active?: boolean }) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        // Keep the selection in the text while a button is pressed.
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClick}
        aria-label={label}
        className={cn(
          "grid size-6 shrink-0 place-items-center rounded-md text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg",
          active && "bg-pane-hover text-pane-fg",
        )}
      >
        <Icon icon={icon} size={13} />
      </button>
    </Tooltip>
  );
}

const PANEL = "absolute left-1 top-full z-20 mt-1 rounded-xl border border-pane-border bg-pane-raised p-2 shadow-menu";

type PanelRoot = React.RefObject<HTMLDivElement | null>;

function LinkPanel({ root, initial, onDone, onClose }: { root: PanelRoot; initial: string; onDone: (href: string) => void; onClose: () => void }) {
  const [text, setText] = useState(initial.replace(/^mailto:/, ""));
  useDismiss(true, root, (open) => !open && onClose());
  const href = normaliseHref(text);
  return (
    <div className={cn(PANEL, "w-[min(300px,calc(100%-8px))]")}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (href) onDone(href);
        }}
        className="flex items-center gap-1.5"
      >
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Web address, email or phone"
          className="h-7 min-w-0 flex-1 rounded-lg border border-pane-border bg-pane-2 px-2 text-[12px] outline-none placeholder:text-pane-muted focus:border-accent/60"
        />
        <button type="submit" disabled={!href} className="h-7 shrink-0 rounded-full bg-pane-fg px-3 text-[12px] font-medium text-pane disabled:opacity-40">
          {initial ? "Change" : "Add"}
        </button>
      </form>
      {text && !href ? <p className="mt-1.5 px-0.5 text-[11px] text-pane-muted">Type a web address (hswilgers.co.za), an email or a phone number.</p> : null}
    </div>
  );
}

function ColourPanel({ root, theme, plain, onPick, onClose }: { root: PanelRoot; theme: DesignTheme; plain: string; onPick: (hex: string) => void; onClose: () => void }) {
  const [custom, setCustom] = useState("");
  useDismiss(true, root, (open) => !open && onClose());
  const swatches: [string, string][] = [
    [plain, "This text's colour"],
    [theme.accent, "Accent"],
    [theme.muted, "Muted"],
    ...COMMON.map((hex): [string, string] => [hex, hex]),
  ];
  const seen = new Set<string>();
  const unique = swatches.filter(([hex]) => !seen.has(hex.toLowerCase()) && seen.add(hex.toLowerCase()));
  return (
    <div className={cn(PANEL, "w-[212px]")}>
      <div className="grid grid-cols-7 gap-1.5">
        {unique.map(([hex, name]) => (
          <Tooltip key={hex} label={name} side="top">
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(hex)}
              aria-label={name}
              className="size-6 rounded-full border border-pane-border transition-transform hover:scale-110"
              style={{ background: hex }}
            />
          </Tooltip>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <label className="relative size-7 shrink-0 cursor-pointer overflow-hidden rounded-full border border-pane-border" style={{ background: toHex(custom) ?? plain }}>
          <input type="color" value={toHex(custom) ?? plain} onChange={(e) => setCustom(e.target.value)} className="absolute inset-0 cursor-pointer opacity-0" aria-label="Any colour" />
        </label>
        <input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="#1a7f37"
          className="h-7 min-w-0 flex-1 rounded-lg border border-pane-border bg-pane-2 px-2 tabular-nums text-[11.5px] outline-none placeholder:text-pane-muted focus:border-accent/60"
        />
        <button
          type="button"
          disabled={!toHex(custom)}
          onClick={() => onPick(toHex(custom)!)}
          className="h-7 shrink-0 rounded-full bg-pane-fg px-2.5 text-[11.5px] font-medium text-pane disabled:opacity-40"
        >
          Use
        </button>
      </div>
    </div>
  );
}

/** A few colours that read well on white. */
const COMMON = ["#1b1b1f", "#6f6f7a", "#b42318", "#c4320a", "#b54708", "#c9a227", "#1a7f37", "#0e7c66", "#0b6bcb", "#1d4ed8", "#5b4ff0", "#9333ea", "#be185d", "#ffffff"];
