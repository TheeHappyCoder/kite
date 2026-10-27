"use client";

// pdf.js, loaded only when the Fill & sign editor opens. The worker is bundled from pdf.worker.ts.

let loading: Promise<typeof import("pdfjs-dist")> | null = null;

export function loadPdfjs() {
  loading ??= import("pdfjs-dist").then((pdfjs) => {
    if (!pdfjs.GlobalWorkerOptions.workerPort) {
      pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL("./pdf.worker.ts", import.meta.url), { type: "module" });
    }
    return pdfjs;
  });
  return loading;
}
