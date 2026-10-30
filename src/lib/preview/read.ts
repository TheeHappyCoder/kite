import type { Sheet, SheetReply, SheetRequest } from "./sheet-worker";

// Office files drawn on this computer. Nothing here sends anything anywhere: the bytes come from
// Kite's own attachment route, and Word and PowerPoint come out as HTML for a sandboxed frame.

export const OFFICE_MAX_BYTES = 25 * 1024 * 1024;
const UNPACKED_MAX_BYTES = 400 * 1024 * 1024;
const SHEET_TIMEOUT_MS = 60_000;

/** A small file can unpack to gigabytes: the zip's own index says how big it claims to be, before it's opened. */
function unpacksTooBig(bytes: ArrayBuffer) {
  const view = new DataView(bytes);
  if (view.byteLength < 22 || view.getUint32(0, true) !== 0x04034b50) return false;
  for (let end = view.byteLength - 22; end >= Math.max(0, view.byteLength - 65_557); end--) {
    if (view.getUint32(end, true) !== 0x06054b50) continue;
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    let total = 0;
    for (let i = 0; i < count && at + 46 <= view.byteLength && view.getUint32(at, true) === 0x02014b50; i++) {
      total += view.getUint32(at + 24, true);
      at += 46 + view.getUint16(at + 28, true) + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    }
    return total > UNPACKED_MAX_BYTES;
  }
  return false;
}

export function refuseHuge(bytes: ArrayBuffer) {
  if (bytes.byteLength > OFFICE_MAX_BYTES || unpacksTooBig(bytes)) throw new Error("This file is too big to preview.");
}

/** One worker per file: it's stopped when the sheet arrives, when the preview closes, or if it takes too long. */
export function readSheets(bytes: ArrayBuffer, csv: boolean, signal: AbortSignal): Promise<Sheet[]> {
  refuseHuge(bytes);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./sheet-worker.ts", import.meta.url), { type: "module" });
    const finish = () => {
      clearTimeout(timer);
      worker.terminate();
    };
    const timer = setTimeout(() => {
      finish();
      reject(new Error("This file took too long to read."));
    }, SHEET_TIMEOUT_MS);
    signal.addEventListener("abort", finish, { once: true });
    worker.onmessage = (event: MessageEvent<SheetReply>) => {
      finish();
      if (event.data.error !== undefined) reject(new Error(event.data.error));
      else resolve(event.data.sheets);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish();
      reject(new Error("Couldn't read this file."));
    };
    worker.postMessage({ bytes, csv } satisfies SheetRequest, [bytes]);
  });
}

/**
 * Word: pages built off-screen and handed over as text. Pictures come as data: URLs, and embedded
 * HTML (alt chunks) and fonts are left out, so the document brings nothing the frame would have to run.
 */
export async function readWord(bytes: ArrayBuffer) {
  refuseHuge(bytes);
  const { renderAsync } = await import("docx-preview");
  const body = document.createElement("div");
  const styles = document.createElement("div");
  await renderAsync(bytes, body, styles, {
    className: "docx",
    inWrapper: true,
    ignoreFonts: true,
    breakPages: true,
    useBase64URL: true,
    renderAltChunks: false,
    renderChanges: false,
    renderComments: false,
    experimental: false,
  });
  return frameDocument(styles.innerHTML, body.innerHTML, `.docx-wrapper{background:transparent!important;padding:24px 16px!important;box-sizing:border-box}.docx-wrapper>section.docx{${PAGE}margin-bottom:20px!important}`);
}

/** PowerPoint: every slide fitted to `width`, one under the other. */
export async function readSlides(bytes: ArrayBuffer, width: number) {
  refuseHuge(bytes);
  const { pptxToHtml } = await import("@jvmr/pptx-to-html");
  const height = Math.round((width * 9) / 16);
  const slides = await pptxToHtml(bytes, { width, height, scaleToFit: true, letterbox: true });
  if (!slides.length) throw new Error("There are no slides in this file.");
  const body = slides.map((slide) => `<section class="slide-page" style="width:${width}px;height:${height}px">${slide}</section>`).join("");
  // A slide that isn't 16:9 sits centred on the frame's own background instead of the library's black bars.
  return frameDocument("", body, `body{padding:20px}.slide-page{position:relative;overflow:hidden;margin:0 auto 16px;border-radius:8px}.slide-container{background:transparent!important}.slide-container>.slide{${PAGE}}`);
}

/** A sheet of paper resting on the stage. */
const PAGE = "border-radius:6px;box-shadow:0 1px 2px rgb(0 0 0/.08),0 10px 30px rgb(0 0 0/.1)!important;";

/**
 * The frame's whole document. Its policy stops every request, so opening a file never tells its sender.
 * A sandboxed frame can't see Kite's tokens: the stage takes the current theme's colour when it's made.
 */
function frameDocument(head: string, body: string, css: string) {
  const stage = getComputedStyle(document.body).getPropertyValue("--pane-2").trim() || "#f6f6f6";
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; form-action 'none';">
<meta name="referrer" content="no-referrer">
<base target="_blank">
${head}<style>html,body{margin:0;padding:0;background:${stage}}html{scrollbar-width:thin;scrollbar-color:rgb(128 128 128/.4) transparent}${css}</style></head><body>${body}</body></html>`;
}
