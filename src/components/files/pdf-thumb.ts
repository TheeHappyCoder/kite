"use client";

import { useEffect, useState } from "react";
import { loadPdfjs } from "@/lib/pdf/pdfjs";

/** PDFs bigger than this keep their icon: a thumbnail isn't worth fetching that much. */
export const PDF_THUMB_MAX_BYTES = 10 * 1024 * 1024;
/** The first page is drawn this wide (twice the biggest card), whatever the box. */
const WIDTH = 320;

/** One drawing per file for this page load; a failure is remembered as null so it isn't tried again. */
const drawn = new Map<string, Promise<string | null>>();
/** One PDF at a time, so a conversation full of them doesn't fetch and parse them all at once. */
let queue: Promise<unknown> = Promise.resolve();

function draw(url: string) {
  let job = drawn.get(url);
  if (!job) {
    job = queue.then(() => render(url)).catch(() => null);
    queue = job;
    drawn.set(url, job);
  }
  return job;
}

async function render(url: string) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({ url });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: WIDTH / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    void task.destroy();
  }
}

/**
 * The first page of a PDF as a picture, drawn locally with pdf.js once the element is on screen.
 * `url` null (demo mail, too big) never draws. Returns the callback ref to put on the element and the picture.
 */
export function usePdfThumb<T extends Element>(url: string | null) {
  const [node, target] = useState<T | null>(null);
  const [src, setSrc] = useState<{ url: string; src: string | null } | null>(null);

  useEffect(() => {
    if (!url || !node) return;
    let live = true;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void draw(url).then((picture) => live && setSrc({ url, src: picture }));
    }, { rootMargin: "200px" });
    observer.observe(node);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [url, node]);

  return { target, src: src && src.url === url ? src.src : null };
}
