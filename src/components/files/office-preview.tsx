"use client";

import { useEffect, useRef, useState } from "react";
import { officePreview } from "@/lib/mail/attachments";
import { OFFICE_MAX_BYTES, readSheets, readSlides, readWord } from "@/lib/preview/read";
import { MAX_ROWS, type Sheet } from "@/lib/preview/sheet-worker";
import { cn } from "@/lib/utils";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { PreviewLoading } from "./preview-loading";
import { FileTypeIcon } from "./file-icon";
import type { FileRef } from "./file-preview";

type Read<T> = { status: "reading" } | { status: "done"; value: T } | { status: "failed" };

/** Fetches the file once and reads it; nothing leaves this computer. Mounted with `key={url}`, so a new file starts clean. */
function useRead<T>(url: string, read: (bytes: ArrayBuffer, signal: AbortSignal) => Promise<T>) {
  const [state, setState] = useState<Read<T>>({ status: "reading" });
  const latest = useRef(read);
  useEffect(() => {
    latest.current = read;
  });
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    fetch(url, { signal })
      .then((res) => {
        if (!res.ok) throw new Error("Couldn't get the file.");
        return res.arrayBuffer();
      })
      .then((bytes) => latest.current(bytes, signal))
      .then((value) => !signal.aborted && setState({ status: "done", value }))
      .catch(() => !signal.aborted && setState({ status: "failed" }));
    return () => controller.abort();
  }, [url]);
  return state;
}

/** A Word, Excel, CSV or PowerPoint file, drawn here. Loaded only when one is opened. */
export default function OfficePreview({ file, url }: { file: FileRef; url: string }) {
  const kind = officePreview(file.attachment);
  if ((file.attachment.bytes ?? 0) > OFFICE_MAX_BYTES) return <Failed file={file} text="This file is too big to preview. Download it to open it in another app." />;
  if (kind === "sheet") return <SheetPreview key={url} file={file} url={url} />;
  if (kind === "word") return <WordPreview key={url} file={file} url={url} />;
  return <SlidesPreview key={url} file={file} url={url} />;
}

function WordPreview({ file, url }: { file: FileRef; url: string }) {
  const state = useRead(url, readWord);
  return <FramePreview file={file} state={state} />;
}

function SlidesPreview({ file, url }: { file: FileRef; url: string }) {
  const box = useRef<HTMLDivElement>(null);
  const state = useRead(url, (bytes) => readSlides(bytes, Math.max(240, (box.current?.clientWidth ?? 900) - 40)));
  return (
    <div ref={box} className="flex min-h-0 flex-1 flex-col">
      <FramePreview file={file} state={state} />
    </div>
  );
}

function FramePreview({ file, state }: { file: FileRef; state: Read<string> }) {
  if (state.status === "reading") return <PreviewLoading />;
  if (state.status === "failed") return <Failed file={file} />;
  // No scripts and no same-origin: the frame can only show the file. Links open in a new window, as they do in mail.
  return <iframe data-sensitive srcDoc={state.value} title={file.attachment.name} sandbox="allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="blur-fade min-h-0 flex-1 border-0" />;
}

function SheetPreview({ file, url }: { file: FileRef; url: string }) {
  const csv = /\.csv$/i.test(file.attachment.name) || file.attachment.mimeType === "text/csv";
  const state = useRead(url, (bytes, signal) => readSheets(bytes, csv, signal));
  const [open, setOpen] = useState(0);
  if (state.status === "reading") return <PreviewLoading />;
  if (state.status === "failed") return <Failed file={file} />;
  const sheets = state.value;
  const sheet = sheets[Math.min(open, sheets.length - 1)];
  return (
    <div data-sensitive className="blur-fade flex min-h-0 flex-1 flex-col">
      {sheet && sheet.rows.length ? <SheetTable key={sheet.name} sheet={sheet} /> : <div className="grid min-h-0 flex-1 place-items-center text-[12.5px] text-pane-muted">This sheet is empty.</div>}
      {sheets.length > 1 || sheet?.cut ? (
        <div className="flex shrink-0 items-center gap-3 p-1.5">
          {sheets.length > 1 ? (
            <FluidList tone="pill" axis="x" className="flex min-w-0 gap-0.5 overflow-x-auto">
              {sheets.map((s, i) => (
                <button
                  key={s.name}
                  {...FLUID_ITEM}
                  onClick={() => setOpen(i)}
                  className={cn(
                    "h-7 shrink-0 rounded-full px-3 text-[12px] transition-[color,background-color,font-weight] duration-150",
                    s === sheet ? "bg-pane font-semibold text-pane-fg shadow-sm" : "font-medium text-pane-muted data-[lit]:text-pane-fg",
                  )}
                >
                  {s.name}
                </button>
              ))}
            </FluidList>
          ) : null}
          {sheet?.cut ? <p className="ml-auto shrink-0 pr-2 text-[11.5px] text-pane-muted">First {MAX_ROWS.toLocaleString()} rows. Download it for the rest.</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const ROW_HEIGHT = 28;
const OVERSCAN = 10;
const NUMBER = /^[-+(]?[\p{Sc}\s]*[\d.,\s]+[%)\p{Sc}]?$/u;

function columnName(index: number) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** Widths from the first rows' text, so long sheets don't measure everything. */
function columnWidths(sheet: Sheet) {
  const widths = Array.from({ length: sheet.columns }, () => 8);
  for (const row of sheet.rows.slice(0, 200)) row.forEach((cell, i) => (widths[i] = Math.max(widths[i], Math.min(cell.length + 2, 40))));
  return widths.map((chars) => chars * 7 + 8);
}

/** Only the rows on screen exist, so twenty thousand of them scroll like twenty. */
function SheetTable({ sheet }: { sheet: Sheet }) {
  const [widths] = useState(() => columnWidths(sheet));
  const [view, setView] = useState({ top: 0, height: 700 });
  const frame = useRef(0);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const first = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(sheet.rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN);
  const gutter = 48;
  return (
    <div
      className="min-h-0 flex-1 overflow-auto bg-pane"
      onScroll={(event) => {
        const { scrollTop: top, clientHeight: height } = event.currentTarget;
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => setView({ top, height }));
      }}
    >
      <table className="table-fixed border-separate border-spacing-0 text-[12.5px] text-pane-fg" style={{ width: gutter + widths.reduce((a, b) => a + b, 0) }}>
        <colgroup>
          <col style={{ width: gutter }} />
          {widths.map((width, i) => (
            <col key={i} style={{ width }} />
          ))}
        </colgroup>
        <thead className="sticky top-0 z-10">
          <tr style={{ height: ROW_HEIGHT }}>
            <th className={cn(HEAD, "sticky left-0 z-20")} />
            {widths.map((_, i) => (
              <th key={i} className={HEAD}>
                {columnName(sheet.firstColumn + i)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {first > 0 ? <tr style={{ height: first * ROW_HEIGHT }} /> : null}
          {sheet.rows.slice(first, last).map((row, i) => (
            <tr key={first + i} style={{ height: ROW_HEIGHT }}>
              <th className={cn(HEAD, "sticky left-0 z-[5] tabular-nums")}>{sheet.firstRow + first + i + 1}</th>
              {widths.map((_, c) => {
                const cell = row[c] ?? "";
                return (
                  <td key={c} title={cell.length > 30 ? cell : undefined} className={cn("truncate border-r border-b border-pane-border px-2", cell && NUMBER.test(cell) && "text-right tabular-nums")}>
                    {cell}
                  </td>
                );
              })}
            </tr>
          ))}
          {last < sheet.rows.length ? <tr style={{ height: (sheet.rows.length - last) * ROW_HEIGHT }} /> : null}
        </tbody>
      </table>
    </div>
  );
}

const HEAD = "border-r border-b border-pane-border bg-pane-2 px-1 text-center text-[11.5px] font-medium text-pane-muted";

function Failed({ file, text = "Kite couldn't read this file. It may be locked or damaged. Download it to open it in another app." }: { file: FileRef; text?: string }) {
  return (
    <div className="blur-fade flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 py-14 text-center">
      <FileTypeIcon name={file.attachment.name} mimeType={file.attachment.mimeType} className="h-14" />
      <p className="max-w-sm text-[12.5px] text-pane-muted">{text}</p>
    </div>
  );
}
