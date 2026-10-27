"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Attachment01Icon, Cancel01Icon, Search01Icon, Tick02Icon, ViewIcon } from "@hugeicons/core-free-icons";
import { askedFor, askedMatch, type AskedKind } from "@/lib/mail/asked-for";
import type { Account, FileItem, Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { Segmented } from "../design/block-editor";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { FilePreview, FileThumb, type FileRef } from "./file-preview";
import { demoFiles, KINDS, matches, type Kind } from "./files-view";

/** What the compose window knows about the conversation it answers. */
export type AttachContext = {
  /** Kite thread id of the conversation being answered. */
  threadId?: string;
  /** The account and Gmail thread a reopened reply draft belongs to. */
  accountId?: string;
  remoteThreadId?: string;
  /** New text of the message being answered, for the "asked for" ordering. Never leaves the browser. */
  ask?: string;
};

type Candidates = { conversation: FileItem[]; people: FileItem[]; recent: FileItem[] };
type Group = { id: string; label: string; files: FileItem[] };

export const fileKey = (f: Pick<FileItem, "accountId" | "messageId" | "partId" | "name">) => `${f.accountId}:${f.messageId}:${f.partId ?? f.name}`;

/** Demo mail has no store behind it: the same groups, built from the sample threads. */
function demoCandidates(threads: Thread[], threadId: string | undefined, people: string[], query: string, kind: Kind): Candidates {
  const all = demoFiles(threads).filter((f) => matches(f, query, kind, "all"));
  const wanted = new Set(people);
  const withPeople = new Set(
    threads.flatMap((t) =>
      t.messages
        .filter((m) => [m.from, ...m.to, ...(m.cc ?? [])].some((c) => wanted.has(c.email.toLowerCase())))
        .map((m) => `${t.id}:${m.id}`),
    ),
  );
  const seen = new Set<string>();
  const take = (files: FileItem[]) => files.filter((f) => !seen.has(fileKey(f)) && !!seen.add(fileKey(f)));
  return {
    conversation: take(all.filter((f) => f.threadId === threadId)),
    people: take(all.filter((f) => withPeople.has(`${f.threadId}:${f.messageId}`))),
    recent: take(all),
  };
}

/** Moves files the answered message asks for to the top, keeping their order. */
function groupsOf(candidates: Candidates, asked: AskedKind[]) {
  const notes = new Map<string, string>();
  const askedFiles: FileItem[] = [];
  const rest = (files: FileItem[]) =>
    files.filter((f) => {
      const match = askedMatch(f.name, asked);
      if (!match) return true;
      notes.set(fileKey(f), match.label);
      askedFiles.push(f);
      return false;
    });
  const groups: Group[] = [
    { id: "conversation", label: "This conversation", files: rest(candidates.conversation) },
    { id: "people", label: "With these people", files: rest(candidates.people) },
    { id: "recent", label: "Recent", files: rest(candidates.recent) },
  ];
  return { groups: [{ id: "asked", label: "Asked for", files: askedFiles }, ...groups].filter((g) => g.files.length), notes };
}

/**
 * "Attach from your files": files Kite already has, ordered for this message (asked-for
 * matches, this conversation, these recipients, recent). The user picks; nothing is
 * attached on its own.
 */
export function AttachPicker({
  live,
  accounts,
  draftAccountId,
  demoThreads,
  context,
  people,
  attached,
  onAttach,
  onUpload,
  onClose,
}: {
  live: boolean;
  accounts: Account[];
  draftAccountId: string;
  demoThreads: Thread[];
  context?: AttachContext;
  /** Current recipients' addresses. */
  people: string[];
  /** Keys (fileKey) of files already on the draft. */
  attached: Set<string>;
  onAttach: (files: FileItem[]) => void;
  onUpload: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [kind, setKind] = useState<Kind>("all");
  const [result, setResult] = useState<{ key: string; candidates: Candidates } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [active, setActive] = useState(0);
  /** Where a Shift-click or Shift+arrow range starts. */
  const [anchor, setAnchor] = useState<number | null>(null);
  const [preview, setPreview] = useState<FileRef | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previewOpen = useRef(false);

  useEffect(() => {
    previewOpen.current = !!preview;
  });

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(timer);
  }, [query]);

  const peopleKey = people.map((p) => p.toLowerCase()).sort().join(",");
  const key = `${kind}:${debounced}:${peopleKey}:${context?.threadId ?? ""}:${context?.remoteThreadId ?? ""}`;
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (context?.threadId) params.set("thread", context.threadId);
    if (context?.accountId && context.remoteThreadId) {
      params.set("account", context.accountId);
      params.set("remote", context.remoteThreadId);
    }
    if (peopleKey) params.set("people", peopleKey);
    if (kind !== "all") params.set("kind", kind);
    if (debounced) params.set("q", debounced);
    fetch(`/api/files/attach?${params}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: Candidates) => setResult({ key, candidates: { conversation: data.conversation ?? [], people: data.people ?? [], recent: data.recent ?? [] } }))
      .catch(() => {});
    return () => controller.abort();
  }, [live, key, context?.threadId, context?.accountId, context?.remoteThreadId, peopleKey, kind, debounced]);

  // Close on a click outside (the preview dialog sits outside, so it doesn't count while open).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (previewOpen.current || root.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const asked = useMemo(() => askedFor(context?.ask ?? ""), [context?.ask]);
  const candidates = useMemo(
    () => (live ? (result?.candidates ?? null) : demoCandidates(demoThreads, context?.threadId, peopleKey ? peopleKey.split(",") : [], debounced, kind)),
    [live, result, demoThreads, context?.threadId, peopleKey, debounced, kind],
  );
  const { groups, notes } = useMemo(() => groupsOf(candidates ?? { conversation: [], people: [], recent: [] }, asked), [candidates, asked]);
  const rows = groups.flatMap((g) => g.files);
  const loading = live && !result;
  const current = Math.min(active, Math.max(0, rows.length - 1));
  const byKey = new Map(rows.map((f) => [fileKey(f), f] as const));
  const picked = selected.flatMap((k) => (byKey.has(k) ? [byKey.get(k)!] : []));
  const multiple = accounts.length > 1;

  const toggle = (file: FileItem, index = rows.indexOf(file)) => {
    const k = fileKey(file);
    setAnchor(index);
    if (attached.has(k)) return;
    setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  };
  /** Keys of the rows between two indexes, leaving out files already attached. */
  const keysBetween = (a: number, b: number) =>
    rows
      .slice(Math.min(a, b), Math.max(a, b) + 1)
      .map(fileKey)
      .filter((k) => !attached.has(k));
  /** List-style clicks: plain selects just this file, Ctrl/Cmd toggles it, Shift selects a range (Ctrl+Shift adds it). */
  const clickRow = (e: React.MouseEvent, file: FileItem, index: number) => {
    setActive(index);
    if (e.shiftKey) {
      const range = keysBetween(anchor ?? index, index);
      if (anchor === null) setAnchor(index);
      setSelected((s) => (e.ctrlKey || e.metaKey ? [...s, ...range.filter((k) => !s.includes(k))] : range));
      return;
    }
    if (e.ctrlKey || e.metaKey) return toggle(file, index);
    setAnchor(index);
    const k = fileKey(file);
    setSelected(attached.has(k) ? [] : [k]);
  };
  const attach = (files: FileItem[]) => {
    const fresh = files.filter((f) => !attached.has(fileKey(f)));
    if (fresh.length) onAttach(fresh);
    onClose();
  };
  const refOf = (file: FileItem): FileRef => ({ accountId: file.accountId, messageId: live ? file.messageId : null, attachment: file, subject: file.subject, threadId: file.threadId, from: file.from });
  const move = (index: number) => {
    setActive(index);
    list.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Attach from your files"
      // Focusable, so clicking a row keeps the keyboard (arrows, Space, Enter) in the picker.
      tabIndex={-1}
      className="blur-fade-up outline-none absolute inset-x-3 bottom-full z-10 mb-2 flex max-h-[min(480px,calc(100vh-180px))] flex-col overflow-hidden rounded-2xl border border-pane-border bg-pane text-pane-fg shadow-2xl"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (preview) setPreview(null);
          else onClose();
          return;
        }
        if (preview) return;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!rows.length) return;
          if (e.shiftKey) {
            // Shift+arrows grow the selection from where it started, without wrapping.
            const next = Math.max(0, Math.min(rows.length - 1, current + (e.key === "ArrowDown" ? 1 : -1)));
            if (anchor === null) setAnchor(current);
            setSelected(keysBetween(anchor ?? current, next));
            move(next);
            return;
          }
          move((current + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length);
        } else if (e.key === " " && rows[current] && (e.target as HTMLElement).tagName !== "INPUT") {
          e.preventDefault();
          toggle(rows[current]);
        } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          if (picked.length) attach(picked);
          else if (rows[current]) attach([rows[current]]);
        }
      }}
    >
      <div className="flex flex-col gap-2 border-b border-pane-border p-2.5">
        <div className="flex min-w-0 items-center gap-1.5">
          <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-pane-border bg-pane px-3 text-[13px] transition-colors focus-within:border-accent/60">
            <Icon icon={Search01Icon} size={15} className="shrink-0 text-pane-muted" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              placeholder="Search your files by name, subject or sender"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
            />
          </label>
          <Tooltip label="Close" side="top" className="inline-flex shrink-0">
            <button aria-label="Close" onClick={onClose} className="grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
              <Icon icon={Cancel01Icon} size={15} />
            </button>
          </Tooltip>
        </div>
        <div className="-mx-0.5 overflow-x-auto px-0.5">
          <div className="w-max">
            <Segmented
              value={kind}
              options={KINDS}
              onChange={(k) => {
                setKind(k);
                setActive(0);
              }}
            />
          </div>
        </div>
      </div>

      <div ref={list} role="listbox" aria-multiselectable className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {loading ? (
          Array.from({ length: 4 }, (_, i) => <div key={i} className="m-1 h-11 animate-pulse rounded-xl bg-pane-2" />)
        ) : rows.length ? (
          groups.map((group) => (
            <div key={group.id} className="mb-1">
              <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-pane-muted">{group.label}</p>
              {group.files.map((file) => {
                const index = rows.indexOf(file);
                const k = fileKey(file);
                const isAttached = attached.has(k);
                const isSelected = selected.includes(k);
                const note = notes.get(k);
                const account = multiple && file.accountId !== draftAccountId ? accounts.find((a) => a.id === file.accountId) : undefined;
                return (
                  <div
                    key={k}
                    data-row={index}
                    role="option"
                    aria-label={`${file.name}, from ${file.from.name || file.from.email}${note ? `, asked for: ${note}` : ""}${isAttached ? ", attached" : ""}`}
                    aria-selected={isSelected}
                    aria-disabled={isAttached}
                    onMouseMove={() => index !== current && setActive(index)}
                    onMouseDown={(e) => e.shiftKey && e.preventDefault()}
                    onClick={(e) => clickRow(e, file, index)}
                    onDoubleClick={() => !isAttached && attach([file])}
                    className={cn(
                      "group flex min-w-0 cursor-default select-none items-center gap-2.5 rounded-xl px-2 py-1.5",
                      index === current && "bg-pane-hover",
                      isAttached && "opacity-55",
                    )}
                  >
                    <span
                      role="checkbox"
                      aria-checked={isSelected}
                      aria-label={`Select ${file.name}`}
                      onClick={(e) => {
                        // The circle adds or removes this file without touching the rest.
                        e.stopPropagation();
                        setActive(index);
                        toggle(file, index);
                      }}
                      className={cn(
                        "grid size-4 shrink-0 place-items-center rounded-full border transition-colors",
                        isSelected || isAttached ? "border-accent bg-accent text-white" : "border-pane-border",
                      )}
                    >
                      {isSelected || isAttached ? <Icon icon={Tick02Icon} size={11} /> : null}
                    </span>
                    <FileThumb file={refOf(file)} size={15} className="size-8 shrink-0 overflow-hidden rounded-lg bg-pane-2" />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[12.5px] font-medium" title={file.name}>
                          {file.name}
                        </span>
                        {note ? <span className="shrink-0 rounded-full bg-accent-soft px-1.5 text-[10.5px] font-medium text-accent">asked for: {note}</span> : null}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-pane-muted">
                        {account ? (
                          <Tooltip label={`From ${account.name} (${account.email})`} side="top" className="inline-flex shrink-0">
                            <span className="size-1.5 rounded-full" style={{ background: account.color }} />
                          </Tooltip>
                        ) : null}
                        <span className="truncate">{file.from.name || file.from.email}</span>
                        <span className="shrink-0">· {formatListDate(file.date)}</span>
                        <span className="shrink-0">· {isAttached ? "Attached" : file.size}</span>
                      </span>
                    </span>
                    <Tooltip label="Preview" side="left" className="inline-flex shrink-0">
                      <button
                        aria-label={`Preview ${file.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreview(refOf(file));
                        }}
                        className="grid size-7 place-items-center rounded-full text-pane-muted opacity-0 transition-opacity hover:bg-pane-2 hover:text-pane-fg focus-visible:opacity-100 group-hover:opacity-100"
                      >
                        <Icon icon={ViewIcon} size={14} />
                      </button>
                    </Tooltip>
                  </div>
                );
              })}
            </div>
          ))
        ) : (
          <div className="blur-fade flex flex-col items-center gap-1.5 px-6 py-10 text-center">
            <Icon icon={Attachment01Icon} size={22} className="text-pane-muted opacity-60" />
            <p className="text-[12.5px] font-medium">{debounced || kind !== "all" ? "No files match" : "No files yet"}</p>
            <p className="max-w-xs text-[11.5px] text-pane-muted">
              {debounced || kind !== "all" ? "Try another name, or search by who sent it." : "Files from your mail show up here as Kite downloads it."}
            </p>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2 border-t border-pane-border px-2.5 py-2">
        <button
          onClick={() => {
            onClose();
            onUpload();
          }}
          className="flex h-8 min-w-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
        >
          <Icon icon={Attachment01Icon} size={14} className="shrink-0" />
          <span className="truncate">From this computer…</span>
        </button>
        <button onClick={onClose} className="ml-auto h-8 shrink-0 rounded-full border border-pane-border px-3.5 text-[12.5px] hover:bg-pane-hover">
          Cancel
        </button>
        <button
          disabled={!picked.length}
          onClick={() => attach(picked)}
          className="h-8 shrink-0 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90 disabled:opacity-40"
        >
          {picked.length > 1 ? `Attach ${picked.length} files` : "Attach"}
        </button>
      </div>

      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
