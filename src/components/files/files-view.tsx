"use client";

import { forwardRef, useEffect, useMemo, useRef, useState } from "react";
import { inScope, singleAccount, type AccountScope } from "@/lib/mail/scope";
import { Folder02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import type { Account, Attachment, FileItem, Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { Segmented } from "../design/block-editor";
import { FilePreview, FileThumb, type FileRef } from "./file-preview";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { FirstSyncState, SyncStrip, useFirstSync } from "../mail/first-sync";
import { AccentTitle } from "../ui/accent-title";
export type Kind = Attachment["kind"] | "all";

export const KINDS: [Kind, string][] = [
  ["all", "All"],
  ["image", "Images"],
  ["pdf", "PDFs"],
  ["doc", "Documents"],
  ["sheet", "Sheets"],
  ["other", "Other"],
];

/** Demo mail has no store behind it, so its files are gathered from the sample threads. */
export function demoFiles(threads: Thread[]): FileItem[] {
  return threads
    .flatMap((t) =>
      t.messages.flatMap((m) =>
        (m.attachments ?? []).filter((a) => !a.inline).map((a) => ({ ...a, accountId: t.accountId, threadId: t.id, messageId: m.id, subject: t.subject, from: m.from, date: m.date })),
      ),
    )
    .sort((a, b) => b.date.localeCompare(a.date));
}

export function matches(file: FileItem, query: string, kind: Kind, accountId: string) {
  if (kind !== "all" && file.kind !== kind) return false;
  if (!inScope(accountId, file.accountId)) return false;
  const haystack = `${file.name} ${file.subject} ${file.from.name} ${file.from.email}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((term) => haystack.includes(term));
}

/**
 * Every attachment in the local copy of your mail, newest first: search by name,
 * subject or sender, filter by kind, preview without leaving Kite.
 */
export const FilesView = forwardRef<
  HTMLInputElement,
  {
    live: boolean;
    accounts: Account[];
    accountId: AccountScope;
    demoThreads: Thread[];
    refreshKey: number;
    onOpenEmail: (file: FileRef) => void;
  }
>(function FilesView({ live, accounts, accountId, demoThreads, refreshKey, onOpenEmail }, searchRef) {
  const firstSync = useFirstSync();
  const [indexing, setIndexing] = useState(false);
  const [indexNote, setIndexNote] = useState("");
  const [indexVersion, setIndexVersion] = useState(0);
  const indexAbort = useRef<AbortController | null>(null);
  useEffect(() => () => indexAbort.current?.abort(), [accountId]);
  const indexFiles = async () => {
    const controller = new AbortController(); indexAbort.current = controller;
    setIndexing(true); let offset: number | null = 0, indexed = 0, failed = 0;
    try {
      while (offset !== null && !controller.signal.aborted) {
        const res = await fetch("/api/files", { method: "POST", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ account: accountId, offset }) });
        if (!res.ok) throw new Error("Indexing stopped. Try again.");
        const result: { indexed: number; failed: number; next: number | null } = await res.json();
        if (controller.signal.aborted) return;
        indexed += result.indexed; failed += result.failed; offset = result.next;
        setIndexNote(`${indexed} documents processed${failed ? `; ${failed} could not be read` : ""}. PDFs, DOCX and text files; scanned images need OCR.`);
      }
      setIndexVersion((v) => v + 1);
    } catch (error) { if (!controller.signal.aborted) setIndexNote(error instanceof Error ? error.message : "Indexing stopped."); }
    finally { if (indexAbort.current === controller) setIndexing(false); }
  };
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [result, setResult] = useState<{ key: string; files: FileItem[] } | null>(null);
  const [preview, setPreview] = useState<FileRef | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const key = `${accountId}:${kind}:${debounced}:${refreshKey}:${indexVersion}`;
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    const params = new URLSearchParams({ account: accountId });
    if (kind !== "all") params.set("kind", kind);
    if (debounced) params.set("q", debounced);
    fetch(`/api/files?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { files: FileItem[] }) => setResult({ key, files: data.files ?? [] }))
      .catch(() => {});
    return () => controller.abort();
  }, [live, accountId, kind, debounced, key]);

  const demo = useMemo(() => (live ? [] : demoFiles(demoThreads)), [live, demoThreads]);
  const files = live ? (result?.files ?? []) : demo.filter((f) => matches(f, debounced, kind, accountId));
  const loading = live && !result;
  const multiple = !singleAccount(accountId, accounts);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl bg-pane pane-on-sky text-pane-fg">
      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div className="blur-fade-up mx-auto max-w-[1100px] px-6 pb-12 pt-6">
          <header className="mb-5 flex flex-wrap items-center gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent">
              <Icon icon={Folder02Icon} size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-medium tracking-[-0.035em]"><AccentTitle text="All files" /></h1>
              <p className="text-[13px] text-pane-muted">
                {loading ? "Gathering attachments…" : `${files.length.toLocaleString()} ${files.length === 1 ? "file" : "files"} in the mail on this computer`}
              </p>
            </div>
          </header>
          {firstSync ? <SyncStrip progress={firstSync} className="mx-0 mb-5" /> : null}

          <div className="mb-5 flex flex-wrap items-center gap-3">
            <label className="flex h-10 min-w-[240px] flex-1 items-center gap-2 rounded-full border border-pane-border bg-pane px-3.5 text-[13.5px] transition-colors focus-within:border-accent/60">
              <Icon icon={Search01Icon} size={16} className="text-pane-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Search names, senders or document text"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
              />
            </label>
            {live ? <button className="rounded-full border border-pane-border px-3 py-2 text-xs" onClick={() => indexing ? indexAbort.current?.abort() : void indexFiles()}>{indexing ? "Stop indexing" : "Make documents searchable"}</button> : null}
            <Segmented value={kind} options={KINDS} onChange={setKind} />
          </div>
          {indexNote ? <p role="status" className="mb-3 text-xs text-pane-muted">{indexNote}</p> : null}

          {loading ? (
            <Grid>
              {Array.from({ length: 8 }, (_, i) => (
                <div key={i} className="h-[172px] animate-pulse rounded-xl bg-pane-2" />
              ))}
            </Grid>
          ) : files.length ? (
            <Grid key={`${kind}:${debounced}`}>
              {files.map((file, i) => {
                const ref: FileRef = {
                  accountId: file.accountId,
                  messageId: live ? file.messageId : null,
                  attachment: file,
                  subject: file.subject,
                  threadId: file.threadId,
                  from: file.from,
                };
                const account = multiple ? accounts.find((a) => a.id === file.accountId) : undefined;
                return (
                  <button
                    key={`${file.messageId}:${file.partId ?? file.name}`}
                    {...FLUID_ITEM}
                    onClick={() => setPreview(ref)}
                    className="blur-fade-up group relative flex flex-col overflow-hidden rounded-xl border border-pane-border text-left transition-colors data-[lit]:border-accent/50"
                    style={{ "--i": Math.min(i, 16) } as React.CSSProperties}
                  >
                    <FileThumb file={ref} size={28} className="h-[104px] w-full bg-pane-2 transition-transform duration-300 group-hover:scale-[1.02]" />
                    <span className="flex flex-col gap-0.5 px-3 py-2.5">
                      <span data-sensitive className="truncate text-[12.5px] font-medium" title={file.name}>
                        {file.name}
                      </span>
                      <span className="flex items-center gap-1.5 truncate text-[11.5px] text-pane-muted">
                        {account ? <span className="size-1.5 shrink-0 rounded-full" style={{ background: account.color }} /> : null}
                        <span className="truncate">{file.from.name}</span>
                        <span className="shrink-0">· {formatListDate(file.date)}</span>
                      </span>
                      <span className="text-[11px] text-pane-muted/80">{file.size}</span>
                    </span>
                  </button>
                );
              })}
            </Grid>
          ) : firstSync && !debounced && kind === "all" ? (
            <FirstSyncState progress={firstSync} note="Attachments show up here as your mail comes in." />
          ) : (
            <Empty searching={!!debounced || kind !== "all"} live={live} />
          )}
        </div>
      </div>

      <FilePreview file={preview} onClose={() => setPreview(null)} onOpenEmail={onOpenEmail} />
    </section>
  );
});

function Grid({ children }: { children: React.ReactNode }) {
  return (
    <FluidList axis="xy" tone="pane" className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
      {children}
    </FluidList>
  );
}

function Empty({ searching, live }: { searching: boolean; live: boolean }) {
  return (
    <div className={cn("blur-fade flex flex-col items-center gap-2 py-20 text-center")}>
      <Icon icon={Folder02Icon} size={28} className="text-pane-muted opacity-60" />
      <p className="text-[13px] font-medium">{searching ? "No files match" : "No files yet"}</p>
      <p className="max-w-sm text-[12px] text-pane-muted">
        {searching
          ? "Try another name, or search by who sent it."
          : live
            ? "Attachments show up here as Kite downloads your mail. Recent ones are fetched in the background."
            : "Attachments from your mail will show up here."}
      </p>
    </div>
  );
}
