"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { compileHtml, compileText, type CompileOptions } from "@/lib/design/compile";
import type { DesignKind } from "@/lib/design/prompt";
import { assetId, type Design } from "@/lib/design/spec";
import { cn } from "@/lib/utils";

export type PreviewMode = "gmail" | "outlook" | "images-off" | "text";

/** Where an image source points in Kite's own previews (`images`: drawn placeholders, by id). */
function previewImage(src: string, stills?: Record<string, string>, outlook?: boolean, images?: Record<string, string>) {
  const id = assetId(src);
  if (!id) return src;
  if (images?.[id]) return images[id];
  return outlook && stills?.[id] ? stills[id] : `/api/assets/${id}`;
}

/** Marks the selected block or part in the frame. */
function markSelected(doc: Document | null | undefined, path: string | null | undefined) {
  doc?.querySelectorAll("tr[data-kite-block], tr[data-kite-part]").forEach((row) => {
    row.toggleAttribute("data-selected", (row.getAttribute("data-kite-part") ?? row.getAttribute("data-kite-block")) === path);
  });
}

/** Hover and selection marks for the editor (the frame has no scripts: Kite draws these from outside). */
const SELECT_STYLE = `tr[data-kite-block]{cursor:pointer}
tr[data-kite-block]>td{outline:1.5px solid transparent;outline-offset:4px;border-radius:6px;transition:outline-color .15s}
tr[data-kite-block]:hover>td{outline-color:rgba(48,93,222,.35)}
tr[data-kite-part]>td{outline:1.5px solid transparent;outline-offset:2px;border-radius:4px;transition:outline-color .15s}
tr[data-kite-part]:hover>td{outline-color:rgba(48,93,222,.35)}
tr[data-kite-block]:has(tr[data-kite-part]:hover)>td{outline-color:transparent}
tr[data-selected]>td{outline:2px solid #305dde!important}`;

/**
 * Renders a compiled design in a sandboxed frame, the way a mail client would.
 * No scripts; images only from Kite itself, https and data: (first-frame stills).
 */
export function DesignPreview({
  design,
  mode = "gmail",
  stills,
  kind = "signature",
  images,
  selected,
  onSelect,
  className,
}: {
  design: Design;
  /** A signature's text version starts with the "-- " separator. */
  kind?: DesignKind;
  mode?: PreviewMode;
  /** First frames of GIFs (asset id → data URL), shown in the Outlook preview. */
  stills?: Record<string, string>;
  /** Drawn placeholder images (lib/design/templates.ts PLACEHOLDERS), by id. */
  images?: Record<string, string>;
  /** The editor: the selected top-level block, and a click on one selects it. */
  /** A path: "2" (a block) or "0.1.0" (block, column, part). */
  selected?: string | null;
  onSelect?: (path: string) => void;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(40);
  const selectRef = useRef(onSelect);
  const selectedRef = useRef(selected);
  useEffect(() => {
    selectRef.current = onSelect;
    selectedRef.current = selected;
  });
  const selectable = !!onSelect;

  const srcDoc = useMemo(() => {
    if (mode === "text") return null;
    const options: CompileOptions = {
      image: (src) => previewImage(src, stills, mode === "outlook", images),
      outlook: mode === "outlook",
      imagesOff: mode === "images-off",
      marks: selectable,
    };
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; form-action 'none';">
<meta name="referrer" content="no-referrer"><base target="_blank">
<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}body{padding:${selectable ? 6 : 1}px}${selectable ? SELECT_STYLE : ""}</style>
</head><body>${compileHtml(design, options)}</body></html>`;
  }, [design, mode, stills, images, selectable]);

  // The selected block's mark, kept in step without reloading the frame.
  useEffect(() => {
    const doc = ref.current?.contentDocument;
    markSelected(doc, selected);
  }, [selected, srcDoc]);

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (doc?.documentElement) setHeight(Math.max(24, doc.documentElement.scrollHeight));
    };
    const onLoad = () => {
      measure();
      const doc = frame.contentDocument;
      // A click selects the block it landed in (links don't open while designing).
      doc?.addEventListener("click", (event) => {
        if (!selectRef.current) return;
        const row = (event.target as Element | null)?.closest?.("tr[data-kite-part], tr[data-kite-block]");
        event.preventDefault();
        const path = row?.getAttribute("data-kite-part") ?? row?.getAttribute("data-kite-block");
        if (path) selectRef.current(path);
      });
      markSelected(doc, selectedRef.current);
      const body = frame.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(measure);
        observer.observe(body);
      }
      // Images finishing late change the height.
      frame.contentDocument?.querySelectorAll("img").forEach((img) => img.addEventListener("load", measure));
    };
    frame.addEventListener("load", onLoad);
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  if (mode === "text") {
    return (
      <pre className={cn("whitespace-pre-wrap rounded-lg bg-white px-3 py-2 tabular-nums text-[12px] leading-5 text-[#1b1b1f]", className)}>
        {kind === "signature" ? `-- \n${compileText(design)}` : compileText(design)}
      </pre>
    );
  }

  return (
    <div className={cn("rounded-lg bg-white p-3", className)}>
      <iframe
        ref={ref}
        title={kind === "signature" ? "Signature preview" : "Email preview"}
        srcDoc={srcDoc ?? undefined}
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className="block w-full border-0"
        style={{ height }}
      />
    </div>
  );
}
