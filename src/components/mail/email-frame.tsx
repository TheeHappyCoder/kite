"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { highlightSearch, useSearchQuery } from "./search-highlight";
import { holdRemoteImages } from "@/lib/mail/privacy";
import { frameFont, useFonts } from "@/lib/use-fonts";

/**
 * Renders an HTML email in a sandboxed iframe. Scripts never run (no allow-scripts),
 * a CSP blocks every network request except the message's own inline images (served
 * by Kite) and images the user chose to load, links open in a new tab, and no
 * referrer is sent. allow-same-origin is only there so
 * the parent can measure the content height; without scripts it grants the email nothing.
 *
 * Mail that sets no font of its own reads in the reading font (Settings → Appearance); its @font-face
 * rules are copied in, which is why fonts may load from Kite itself ('self').
 *
 * Changes (expanding a quote, loading images) render into a second, hidden frame and swap
 * in once it has loaded and been measured, so the visible frame never blanks or jumps.
 */
export function EmailFrame({ html, loadRemote }: { html: string; loadRemote: boolean }) {
  const reading = useFonts().reading;
  const srcDoc = useMemo(() => {
    const remote = loadRemote ? " https: http:" : "";
    const font = frameFont(reading);
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid: 'self'${remote}; style-src 'unsafe-inline'${remote}; font-src data: 'self'${remote}; media-src 'none'; form-action 'none';">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>
  ${font.faces}
  html,body{margin:0;padding:0;background:#fff;color:#1b1b1f;font:14px/1.55 ${font.family},-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-feature-settings:${font.features};overflow-wrap:anywhere}
  body{padding:2px}
  /* Many newsletters pin html and body to 100% of the frame, which would keep the frame at its first height: these outrank them. */
  html:root,html:root>body{height:auto!important;min-height:0!important;max-height:none!important;overflow:visible!important}
  img{max-width:100%;height:auto}
  table{max-width:100%}
  pre{white-space:pre-wrap}
  ::highlight(kite-search){background:#fde68a;color:#171717}
  a{color:#5b4ff0}
  img[data-kite-held]{background:#f1f1f4;border-radius:4px;color:#8b8b95;font-size:12px}
  a[data-kite-misleading]{outline:2px dashed #d97706;outline-offset:2px;border-radius:2px}
</style></head><body>${loadRemote ? html : holdRemoteImages(html)}</body></html>`;
  }, [html, loadRemote, reading]);

  // Two slots: the visible one and the other one, which loads the next document (or keeps the
  // previous one, so collapsing a quote again swaps back instantly).
  const [frames, setFrames] = useState<Frames>({ docs: [srcDoc, null], ready: [false, false], heights: [120, 120], active: 0 });
  const { active } = frames;
  const other = (1 - active) as 0 | 1;
  if (frames.docs[active] !== srcDoc) {
    if (frames.docs[other] !== srcDoc) setFrames(withSlot(frames, other, { doc: srcDoc, ready: false }));
    else if (frames.ready[other]) setFrames({ ...frames, active: other });
  }

  return (
    <div className="overflow-hidden rounded-xl bg-white p-3 dark:p-4">
      <div className="relative">
        {([0, 1] as const).map((slot) =>
          frames.docs[slot] === null ? null : (
            <FrameSlot
              key={slot}
              srcDoc={frames.docs[slot]!}
              active={slot === active}
              height={frames.heights[slot]}
              onHeight={(height, loaded) =>
                setFrames((current) => withSlot(current, slot, { height, ready: loaded || current.ready[slot] }))
              }
            />
          ),
        )}
      </div>
    </div>
  );
}

type Frames = { docs: [string, string | null]; ready: [boolean, boolean]; heights: [number, number]; active: 0 | 1 };

function withSlot(frames: Frames, slot: 0 | 1, change: { doc?: string; ready?: boolean; height?: number }): Frames {
  const docs: Frames["docs"] = [...frames.docs];
  const ready: Frames["ready"] = [...frames.ready];
  const heights: Frames["heights"] = [...frames.heights];
  if (change.doc !== undefined) docs[slot] = change.doc;
  if (change.ready !== undefined) ready[slot] = change.ready;
  if (change.height !== undefined) heights[slot] = change.height;
  return { ...frames, docs, ready, heights };
}

function FrameSlot({
  srcDoc,
  active,
  height,
  onHeight,
}: {
  srcDoc: string;
  active: boolean;
  height: number;
  /** `loaded` is true for the measurement taken when the document finished loading. */
  onHeight: (height: number, loaded: boolean) => void;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const query = useSearchQuery();
  useEffect(() => { const body = ref.current?.contentDocument?.body; if (body) highlightSearch(body, query); }, [query]);
  const report = useRef(onHeight);
  const latestQuery = useRef(query);
  useEffect(() => {
    report.current = onHeight;
    latestQuery.current = query;
  });

  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    let observer: ResizeObserver | null = null;
    // The root element's box, not scrollHeight: that never drops below the frame itself, so short bodies stayed tall.
    // Content still spilling out of the frame (floats, positioned parts) is caught by scrollHeight.
    const measure = () => {
      const root = frame.contentDocument?.documentElement;
      if (!root) return null;
      const box = Math.ceil(root.getBoundingClientRect().height);
      return Math.max(24, root.scrollHeight > root.clientHeight ? Math.max(box, root.scrollHeight) : box);
    };
    const onLoad = () => {
      const h = measure();
      if (h !== null) report.current(h, true);
      const body = frame.contentDocument?.body;
      if (body) {
        highlightSearch(body, latestQuery.current);
        observer = new ResizeObserver(() => {
          const next = measure();
          if (next !== null) report.current(next, false);
        });
        observer.observe(body);
      }
    };
    frame.addEventListener("load", onLoad);
    // Already loaded before this ran: measure now, or the frame would keep its placeholder height.
    const doc = frame.contentDocument;
    if (doc?.URL === "about:srcdoc" && doc.readyState === "complete") onLoad();
    return () => {
      frame.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [srcDoc]);

  return (
    <iframe
      ref={ref}
      title="Email content"
      aria-hidden={!active || undefined}
      tabIndex={active ? undefined : -1}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      className={active ? "block w-full border-0" : "pointer-events-none invisible absolute inset-x-0 top-0 w-full border-0"}
      style={{ height }}
    />
  );
}
