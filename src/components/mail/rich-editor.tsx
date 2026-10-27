"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  TextBoldIcon,
  TextItalicIcon,
} from "@hugeicons/core-free-icons";
import { bodyToEditorHtml, bodyToText, escapeInline, escapeLineStart } from "@/lib/mail/body";
import { blurFade } from "@/lib/motion";
import type { Snippet } from "@/lib/settings";
import { comboFromEvent, useShortcuts, type ShortcutAction } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Tooltip } from "../ui/tooltip";

// The compose body: a contenteditable that reads and writes body markup (see lib/mail/body.ts),
// so what's stored and sent is typed text with **bold**, *italic*, [links](…) and lists, never
// pasted HTML. Typing ";" opens the snippet picker.

export type FormatCommand = "bold" | "italic" | "link" | "bulletList" | "numberList";
export type FormatState = Record<Exclude<FormatCommand, "link">, boolean>;
export type RichEditorHandle = {
  focus: () => void;
  insertImage: (id: string) => void;
  command: (command: FormatCommand) => void;
  /**
   * The selected text as markup (the whole body when nothing is selected), with a way to put new
   * markup in its place later (Rewrite). Null when the editor is empty.
   */
  takeSelection: () => { markup: string; whole: boolean; replace: (markup: string) => void } | null;
  /** Replaces everything (Draft with AI). Goes through the browser's editing, so Ctrl+Z brings the old text back. */
  replaceAll: (markup: string) => void;
};

const FORMAT_ACTIONS = new Set<ShortcutAction>(["bold", "italic", "link", "bulletList", "numberList"]);
const NO_FORMAT: FormatState = { bold: false, italic: false, bulletList: false, numberList: false };

// ---------------------------------------------------------------------------
// DOM -> markup
// ---------------------------------------------------------------------------

type Run = { image?: string; text: string; bold: boolean; italic: boolean; href: string | null };
type Line = { kind: "text" | "bullet" | "number"; runs: Run[] };
type Style = Omit<Run, "text">;

const BLOCK = new Set([
  "DIV", "P", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "BLOCKQUOTE", "PRE",
  "TABLE", "TBODY", "TR", "TD", "TH", "SECTION", "ARTICLE", "HEADER", "FOOTER", "FIGURE",
]);
const SKIP = new Set(["STYLE", "SCRIPT", "HEAD", "TITLE", "META", "LINK", "TEMPLATE", "NOSCRIPT", "IMG", "SVG", "VIDEO", "AUDIO", "IFRAME"]);
const SAFE_HREF = /^(https?:\/\/|mailto:|tel:)\S+$/i;

/** True when a <br> only holds its line open (nothing follows it before the block ends). */
function trailingBreak(br: Node, root: Node) {
  let node: Node | null = br;
  while (node && node !== root) {
    let sibling: Node | null = node.nextSibling;
    while (sibling && sibling.nodeType === Node.TEXT_NODE && !sibling.textContent) sibling = sibling.nextSibling;
    if (sibling) return false;
    const parent: Node | null = node.parentNode;
    if (!parent || parent === root || BLOCK.has((parent as Element).tagName)) return true;
    node = parent;
  }
  return true;
}

function emphasis(run: Run) {
  if (run.image) return `![Image](asset:${run.image})`;
  const text = escapeInline(run.text);
  if (!run.bold && !run.italic) return text;
  const [, lead, core, trail] = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  if (!core) return text;
  const mark = run.bold && run.italic ? "***" : run.bold ? "**" : "*";
  return `${lead}${mark}${core}${mark}${trail}`;
}

function renderRuns(runs: Run[]) {
  const merged: Run[] = [];
  for (const run of runs) {
    const last = merged[merged.length - 1];
    if (last && !last.image && !run.image && last.bold === run.bold && last.italic === run.italic && last.href === run.href) last.text += run.text;
    else merged.push({ ...run });
  }
  let out = "";
  for (let i = 0; i < merged.length; ) {
    const href = merged[i].href;
    let label = "";
    for (; i < merged.length && merged[i].href === href; i++) label += emphasis(merged[i]);
    out += href && label.trim() ? `[${label}](${href.replace(/\)/g, "%29").replace(/\s/g, "%20")})` : label;
  }
  return out;
}

/** Reads the editor (or pasted HTML) back as body markup. Anything outside the markup's reach is dropped. */
function serializeEditor(root: Node): string {
  const lines: Line[] = [];
  let line: Line | null = null;
  const current = (kind: Line["kind"] = "text") => {
    if (!line) {
      line = { kind, runs: [] };
      lines.push(line);
    }
    return line;
  };
  const end = () => {
    line = null;
  };

  const walk = (node: Node, style: Style, list: "bullet" | "number" | null, inItem: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parts = (node.textContent ?? "").replace(/ /g, " ").replace(/​/g, "").split("\n");
      parts.forEach((part, i) => {
        if (i > 0) end();
        if (part) current().runs.push({ text: part, ...style });
      });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toUpperCase();
    if (tag === "IMG" && /^[0-9a-f]{24}$/.test(el.dataset.kiteImage ?? "") && el.getAttribute("src") === `/api/assets/${el.dataset.kiteImage}`) { current().runs.push({ text: "", image: el.dataset.kiteImage, ...style }); return; }
    if (SKIP.has(tag)) return;
    if (tag === "BR") {
      current();
      if (!trailingBreak(el, root)) end();
      return;
    }
    const next: Style = { ...style };
    const weight = el.style?.fontWeight ?? "";
    const heavy = weight === "bold" || weight === "bolder" || Number(weight) >= 600;
    const light = weight === "normal" || (weight !== "" && Number(weight) > 0 && Number(weight) < 600);
    if (tag === "B" || tag === "STRONG") next.bold = !light;
    else if (heavy) next.bold = true;
    else if (light) next.bold = false;
    if (tag === "I" || tag === "EM") next.italic = el.style?.fontStyle !== "normal";
    else if (el.style?.fontStyle === "italic") next.italic = true;
    if (tag === "A") {
      const href = el.getAttribute("href") ?? "";
      next.href = SAFE_HREF.test(href) ? href : null;
    }
    const children = (listKind = list, item = inItem) => el.childNodes.forEach((child) => walk(child, next, listKind, item));

    if (tag === "UL" || tag === "OL") {
      end();
      children(tag === "UL" ? "bullet" : "number", false);
      end();
    } else if (tag === "LI") {
      end();
      current(list ?? "bullet");
      children(list, true);
      end();
    } else if (BLOCK.has(tag) && !inItem) {
      end();
      children();
      end();
    } else {
      children();
    }
  };
  root.childNodes.forEach((child) => walk(child, { bold: false, italic: false, href: null }, null, false));

  let number = 0;
  return lines
    .map((l) => {
      const text = renderRuns(l.runs);
      if (l.kind === "bullet") {
        number = 0;
        return `- ${text}`;
      }
      if (l.kind === "number") return `${++number}. ${text}`;
      number = 0;
      return escapeLineStart(text);
    })
    .join("\n")
    .replace(/\s+$/, "");
}

/** Editor HTML for inserting markup at the caret: a single plain line goes in without a wrapping block. */
function insertableHtml(markup: string) {
  const html = bodyToEditorHtml(markup);
  return !markup.includes("\n") && html.startsWith("<div>") ? html.slice(5, -6) : html;
}

function normaliseHref(value: string) {
  const v = value.trim();
  if (!v) return "";
  if (SAFE_HREF.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(v)) return `https://${v}`;
  return "";
}

function exec(command: string, value?: string) {
  document.execCommand("styleWithCSS", false, "false");
  document.execCommand("defaultParagraphSeparator", false, "div");
  document.execCommand(command, false, value);
}

const escapeAttr = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------------------------------------------------------------------------
// Editor
// ---------------------------------------------------------------------------

type SnippetMenu = { query: string; node: Text; offset: number; rect: DOMRect; index: number };
type LinkPrompt = { range: Range | null; rect: DOMRect; value: string; anchor: HTMLAnchorElement | null };

export const RichEditor = forwardRef<
  RichEditorHandle,
  {
    /** Markup shown when the editor mounts (remount with a key to replace it). */
    initial?: string;
    onChange: (markup: string) => void;
    placeholder?: string;
    className?: string;
    snippets?: Snippet[];
    onManageSnippets?: () => void;
    onFormat?: (state: FormatState) => void;
    /** Files pasted into the body (attached rather than inlined). */
    onFiles?: (files: File[]) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void;
    onFocus?: () => void;
    onBlur?: () => void;
    autoFocus?: boolean;
    ariaLabel?: string;
  }
>(function RichEditor(props, ref) {
  const { onChange, onFormat } = props;
  const editorRef = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(!props.initial?.trim());
  const [menu, setMenu] = useState<SnippetMenu | null>(null);
  const [link, setLink] = useState<LinkPrompt | null>(null);
  const shortcuts = useShortcuts();
  const snippets = props.snippets ?? [];
  const matches = menu
    ? [
        ...snippets.filter((s) => s.trigger.toLowerCase().startsWith(menu.query.toLowerCase())),
        ...snippets.filter((s) => !s.trigger.toLowerCase().startsWith(menu.query.toLowerCase()) && s.trigger.toLowerCase().includes(menu.query.toLowerCase())),
      ].slice(0, 6)
    : [];

  useLayoutEffect(() => {
    const el = editorRef.current;
    if (!el) return;
    el.innerHTML = props.initial?.trim() ? bodyToEditorHtml(props.initial) : "";
    if (props.autoFocus) {
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      getSelection()?.removeAllRanges();
      getSelection()?.addRange(range);
    }
    // Read once on mount: the editor owns its content afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const emit = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const markup = serializeEditor(el);
    setEmpty(!markup.trim() && !el.querySelector("li"));
    onChange(markup);
  }, [onChange]);


  const inEditor = (node: Node | null) => !!node && !!editorRef.current?.contains(node);

  const refreshFormat = useCallback(() => {
    if (!onFormat) return;
    if (!inEditor(getSelection()?.anchorNode ?? null)) return onFormat(NO_FORMAT);
    onFormat({
      bold: document.queryCommandState("bold"),
      italic: document.queryCommandState("italic"),
      bulletList: document.queryCommandState("insertUnorderedList"),
      numberList: document.queryCommandState("insertOrderedList"),
    });
  }, [onFormat]);

  /** Looks for ";query" right before the caret. */
  const detectSnippet = useCallback(() => {
    const selection = getSelection();
    const node = selection?.anchorNode;
    if (!selection?.isCollapsed || !node || node.nodeType !== Node.TEXT_NODE || !editorRef.current?.contains(node)) return setMenu(null);
    const before = (node.textContent ?? "").slice(0, selection.anchorOffset);
    const match = before.match(/(?:^|[\s (]);([\w-]{0,24})$/);
    if (!match) return setMenu(null);
    const range = document.createRange();
    range.setStart(node, selection.anchorOffset - match[1].length - 1);
    range.setEnd(node, selection.anchorOffset);
    const rect = range.getBoundingClientRect();
    setMenu((current) => ({
      query: match[1],
      node: node as Text,
      offset: selection.anchorOffset,
      rect,
      index: current && current.query === match[1] ? current.index : 0,
    }));
  }, []);

  useEffect(() => {
    const onSelection = () => {
      if (!inEditor(getSelection()?.anchorNode ?? null)) return;
      refreshFormat();
      detectSnippet();
    };
    document.addEventListener("selectionchange", onSelection);
    return () => document.removeEventListener("selectionchange", onSelection);
  }, [refreshFormat, detectSnippet]);

  const insertSnippet = useCallback((snippet: Snippet) => {
    if (!menu) return;
    const range = document.createRange();
    const start = Math.max(0, menu.offset - menu.query.length - 1);
    range.setStart(menu.node, start);
    range.setEnd(menu.node, Math.min(menu.offset, menu.node.length));
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    exec("insertHTML", insertableHtml(snippet.body));
    setMenu(null);
    emit();
  }, [menu, emit]);

  const openLink = () => {
    const selection = getSelection();
    const range = selection?.rangeCount && inEditor(selection.anchorNode) ? selection.getRangeAt(0).cloneRange() : null;
    const anchor = (range?.startContainer.parentElement?.closest("a") ?? null) as HTMLAnchorElement | null;
    const rect = range?.getBoundingClientRect();
    const box = editorRef.current!.getBoundingClientRect();
    setLink({
      range,
      anchor: anchor && inEditor(anchor) ? anchor : null,
      rect: rect && (rect.width || rect.height) ? rect : new DOMRect(box.left + 12, box.top + 8, 0, 18),
      value: anchor?.getAttribute("href")?.replace(/^mailto:/, "") ?? "",
    });
  };

  const applyLink = (value: string) => {
    const prompt = link;
    setLink(null);
    if (!prompt) return;
    const el = editorRef.current!;
    el.focus();
    const selection = getSelection();
    if (prompt.range) {
      selection?.removeAllRanges();
      selection?.addRange(prompt.range);
    }
    const href = normaliseHref(value);
    if (!href) {
      if (prompt.anchor) {
        if (prompt.range?.collapsed) prompt.anchor.replaceWith(...prompt.anchor.childNodes);
        else exec("unlink");
      }
    } else if (prompt.anchor && prompt.range?.collapsed) {
      prompt.anchor.setAttribute("href", href);
    } else if (!prompt.range || prompt.range.collapsed) {
      const label = value.trim();
      exec("insertHTML", `<a href="${escapeAttr(href)}">${escapeAttr(label)}</a> `);
    } else {
      exec("createLink", href);
    }
    emit();
  };

  const command = (name: FormatCommand) => {
    editorRef.current?.focus();
    if (name === "link") return openLink();
    exec(name === "bulletList" ? "insertUnorderedList" : name === "numberList" ? "insertOrderedList" : name);
    emit();
    refreshFormat();
  };

  /** Puts markup over a range of the editor, as one undoable edit. */
  const insertOver = (range: Range, markup: string) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const selection = getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (markup.trim()) exec("insertHTML", insertableHtml(markup));
    else exec("delete");
    emit();
  };

  const wholeRange = () => {
    const range = document.createRange();
    range.selectNodeContents(editorRef.current!);
    return range;
  };

  useImperativeHandle(ref, () => ({
    insertImage: (id: string) => { if (!/^[0-9a-f]{24}$/.test(id)) return; editorRef.current?.focus(); exec("insertHTML", bodyToEditorHtml(`![Image](asset:${id})`)); emit(); },
    focus: () => editorRef.current?.focus(),
    command,
    takeSelection: () => {
      const el = editorRef.current;
      if (!el) return null;
      const selection = getSelection();
      const markupOf = (range: Range) => {
        const holder = document.createElement("div");
        holder.append(range.cloneContents());
        return serializeEditor(holder);
      };
      let picked = selection?.rangeCount && inEditor(selection.anchorNode) && !selection.isCollapsed ? selection.getRangeAt(0).cloneRange() : null;
      // A selection of only spaces counts as none: the whole body is used.
      if (picked && !markupOf(picked).trim()) picked = null;
      const markup = markupOf(picked ?? wholeRange());
      if (!markup.trim()) return null;
      const range = picked;
      return { markup, whole: !range, replace: (next: string) => insertOver(range ?? wholeRange(), next) };
    },
    replaceAll: (markup: string) => insertOver(wholeRange(), markup),
  }));

  /** "- ", "* " or "1. " typed at the start of a line becomes a list. */
  const autoList = (e: React.FormEvent<HTMLDivElement>) => {
    if ((e.nativeEvent as InputEvent).data !== " ") return false;
    const selection = getSelection();
    const node = selection?.anchorNode;
    if (!node || node.nodeType !== Node.TEXT_NODE || node.parentElement?.closest("li")) return false;
    const before = (node.textContent ?? "").slice(0, selection!.anchorOffset).replace(/ /g, " ");
    const marker = before.match(/^(-|\*|1\.) $/);
    if (!marker || node.previousSibling) return false;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, selection!.anchorOffset);
    selection!.removeAllRanges();
    selection!.addRange(range);
    exec("delete");
    exec(marker[1] === "1." ? "insertOrderedList" : "insertUnorderedList");
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (menu && (matches.length || e.key === "Escape")) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setMenu({ ...menu, index: (menu.index + delta + matches.length) % Math.max(1, matches.length) });
        return;
      }
      if ((e.key === "Enter" || e.key === "Tab") && matches.length) {
        e.preventDefault();
        insertSnippet(matches[Math.min(menu.index, matches.length - 1)]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    const combo = comboFromEvent(e);
    const action = combo ? shortcuts.actionFor(combo) : undefined;
    if (action && FORMAT_ACTIONS.has(action)) {
      e.preventDefault();
      command(action as FormatCommand);
      return;
    }
    props.onKeyDown?.(e);
  };

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length && props.onFiles) {
      e.preventDefault();
      props.onFiles(files);
      return;
    }
    const html = e.clipboardData.getData("text/html");
    const text = e.clipboardData.getData("text/plain");
    e.preventDefault();
    if (html) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const markup = serializeEditor(doc.body);
      if (markup) exec("insertHTML", insertableHtml(markup));
    } else if (text) {
      exec("insertText", text);
    }
    emit();
  };

  return (
    <div className={cn("relative", props.className)}>
      {empty ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 select-none truncate text-pane-muted" style={{ padding: "inherit" }}>
          {props.placeholder}
        </div>
      ) : null}
      <div
        ref={editorRef}
        role="textbox"
        aria-multiline
        aria-label={props.ariaLabel ?? "Message"}
        contentEditable
        suppressContentEditableWarning
        spellCheck
        onInput={(e) => {
          autoList(e);
          emit();
          detectSnippet();
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onFocus={props.onFocus}
        onBlur={() => {
          setMenu(null);
          props.onBlur?.();
        }}
        className="rich-body font-reading min-h-full whitespace-pre-wrap break-words outline-none"
      />

      {typeof document !== "undefined"
        ? createPortal(
            <>
              <AnimatePresence>
                {menu && (matches.length || (!snippets.length && !menu.query)) ? (
                  <motion.div
                    key="snippets"
                    {...blurFade({ y: 4, blur: 4 })}
                    onMouseDown={(e) => e.preventDefault()}
                    style={{ left: Math.min(menu.rect.left, window.innerWidth - 300), top: menu.rect.bottom + 6 }}
                    className="fixed z-[60] w-72 overflow-hidden rounded-xl border border-pane-border bg-pane p-1 text-pane-fg shadow-2xl"
                  >
                    {matches.length ? (
                      <SnippetList snippets={matches} index={Math.min(menu.index, matches.length - 1)} onPick={insertSnippet} onHover={(i) => setMenu({ ...menu, index: i })} />
                    ) : (
                      <div className="px-2.5 py-2 text-[12px] text-pane-muted">
                        No snippets yet.{" "}
                        {props.onManageSnippets ? (
                          <button onClick={props.onManageSnippets} className="font-medium text-accent hover:opacity-80">
                            Add one in Settings
                          </button>
                        ) : null}
                      </div>
                    )}
                  </motion.div>
                ) : null}
              </AnimatePresence>
              <AnimatePresence>
                {link ? (
                  <LinkInput
                    key="link"
                    rect={link.rect}
                    initial={link.value}
                    canRemove={!!link.anchor}
                    onApply={applyLink}
                    onCancel={() => {
                      setLink(null);
                      editorRef.current?.focus();
                    }}
                  />
                ) : null}
              </AnimatePresence>
            </>,
            document.body,
          )
        : null}
    </div>
  );
});

function SnippetList({ snippets, index, onPick, onHover }: { snippets: Snippet[]; index: number; onPick: (s: Snippet) => void; onHover: (i: number) => void }) {
  return snippets.map((snippet, i) => (
    <button
      key={snippet.id}
      onClick={() => onPick(snippet)}
      onMouseEnter={() => onHover(i)}
      className={cn("flex w-full flex-col rounded-lg px-2.5 py-1.5 text-left", i === index && "bg-pane-hover")}
    >
      <span className="tabular-nums text-[12px] text-accent">;{snippet.trigger}</span>
      <span className="truncate text-[12px] text-pane-muted">{bodyToText(snippet.body).replace(/\s+/g, " ")}</span>
    </button>
  ));
}

function LinkInput({
  rect,
  initial,
  canRemove,
  onApply,
  onCancel,
}: {
  rect: DOMRect;
  initial: string;
  canRemove: boolean;
  onApply: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const valid = !value.trim() || !!normaliseHref(value);
  return (
    <motion.div
      {...blurFade({ y: 4, blur: 4 })}
      style={{ left: Math.min(rect.left, window.innerWidth - 340), top: rect.bottom + 8 }}
      className="fixed z-[60] flex w-80 items-center gap-1.5 rounded-full border border-pane-border bg-pane py-1 pl-3.5 pr-1 text-pane-fg shadow-2xl"
    >
      <Icon icon={Link01Icon} size={14} className="shrink-0 text-pane-muted" />
      <input
        autoFocus
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={onCancel}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            if (valid) onApply(value);
          }
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          }
        }}
        placeholder="Paste a link or email address"
        className="h-7 min-w-0 flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-pane-muted"
      />
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => onApply(value)}
        disabled={!valid}
        className="h-7 rounded-full bg-accent px-3 text-[12px] font-medium text-accent-fg disabled:opacity-40"
      >
        {!value.trim() && canRemove ? "Remove" : "Apply"}
      </button>
    </motion.div>
  );
}

const FORMAT_BUTTONS: { command: FormatCommand; label: string; icon: IconData }[] = [
  { command: "bold", label: "Bold", icon: TextBoldIcon },
  { command: "italic", label: "Italic", icon: TextItalicIcon },
  { command: "link", label: "Link", icon: Link01Icon },
  { command: "bulletList", label: "Bulleted list", icon: LeftToRightListBulletIcon },
  { command: "numberList", label: "Numbered list", icon: LeftToRightListNumberIcon },
];

/** Formatting buttons for a RichEditor. */
export function FormatBar({ editor, state }: { editor: React.RefObject<RichEditorHandle | null>; state: FormatState }) {
  return (
    <div className="flex items-center gap-0.5">
      {FORMAT_BUTTONS.map((b) => {
        const active = b.command !== "link" && state[b.command];
        return (
          <Tooltip key={b.command} label={b.label} shortcut={b.command} side="top">
            <button
              aria-label={b.label}
              aria-pressed={active}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => editor.current?.command(b.command)}
              className={cn(
                "grid size-8 place-items-center rounded-full transition-colors",
                active ? "bg-accent-soft text-accent" : "text-pane-muted hover:bg-pane-hover hover:text-pane-fg",
              )}
            >
              <Icon icon={b.icon} size={15} />
            </button>
          </Tooltip>
        );
      })}
    </div>
  );
}
