"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { format } from "date-fns";
import { FileSearchIcon, Mail01Icon } from "@hugeicons/core-free-icons";
import type { AttachmentRef } from "@/lib/mail/compose";
import type { FileItem } from "@/lib/mail/types";
import { blurFade } from "@/lib/motion";
import { Dialog } from "../ui/dialog";
import { FluidList, FLUID_ITEM } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
import { Icon } from "../icon";

// "Where did this file come from?": a file dropped anywhere on Kite but a composer (composers attach it
// and take the drop first), or right-clicked in Explorer (the desktop shell calls `__kiteFindFiles`).
// The file is hashed here; only its fingerprint and name go to Kite's server (/api/files/origin).
// Explorer's "Send back in Kite" runs the same lookup in "reply" mode: the shell has already uploaded
// the file, and its email's conversation opens a reply with it attached (choices first when unsure).

/** Bigger files would sit whole in memory to hash: looked up by name only. */
const MAX_HASH_BYTES = 512 * 1024 * 1024;

/**
 * `part`: the file's email, when the shell knows it (the Kite drive, Windows' download note).
 * `attach` / `attachError`: Send back only: the file uploaded for the reply, or why it couldn't be.
 */
export type FileLookup = { name: string; sha: string | null; part?: { accountId: string; messageId: string; partId: string }; attach?: AttachmentRef; attachError?: string };
export type FileMode = "show" | "reply";
type Origin = { exact: FileItem[]; named: FileItem[] };
type Found = { name: string; origin: Origin; attach?: AttachmentRef; attachError?: string };
type OpenTarget = { threadId: string; accountId: string; subject: string };

async function fingerprint(file: File): Promise<FileLookup> {
  if (file.size > MAX_HASH_BYTES) return { name: file.name, sha: null };
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return { name: file.name, sha: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}

async function lookUp(files: FileLookup[]): Promise<Found[]> {
  const res = await fetch("/api/files/origin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ files: files.map((f) => ({ name: f.name, sha: f.sha ?? undefined, part: f.part })) }),
  });
  const data = (await res.json().catch(() => ({}))) as { results?: Origin[]; error?: string };
  if (!res.ok || !data.results) throw new Error(data.error ?? "Kite couldn't look those files up. Try again.");
  return files.map((f, i) => ({ name: f.name, origin: data.results![i], attach: f.attach, attachError: f.attachError }));
}

/** Send back: the one conversation every file came from, each exactly and only from it; else null (choices first). */
function oneConversation(found: Found[]): FileItem | null {
  if (!found.length || found.some((f) => !f.origin.exact.length || !f.attach)) return null;
  const threads = new Set(found.flatMap((f) => f.origin.exact.map((e) => e.threadId)));
  return threads.size === 1 ? found[0].origin.exact[0] : null;
}

/** One email every file came from (exactly), or null. */
function sameEmail(found: Found[]): FileItem | null {
  const first = found[0]?.origin.exact[0];
  if (!first) return null;
  return found.every((f) => f.origin.exact.some((e) => e.threadId === first.threadId)) ? first : null;
}

/**
 * Drops of files outside composers find their email; `find` runs the same lookup for files hashed
 * elsewhere (the desktop shell). Opens the email at once when there's one exact answer, else a card.
 */
export function useFileOrigin({ enabled, onOpen, onReply }: { enabled: boolean; onOpen: (target: OpenTarget) => void; onReply: (target: OpenTarget, attachments: AttachmentRef[]) => void }) {
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<{ phase: "idle" } | { phase: "looking" } | { phase: "found"; found: Found[]; mode: FileMode } | { phase: "error"; message: string }>({ phase: "idle" });
  const hide = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handlers = useRef({ onOpen, onReply });
  useEffect(() => {
    handlers.current = { onOpen, onReply };
  });

  const find = useCallback(async (files: FileLookup[] | Promise<FileLookup[]>, mode: FileMode = "show") => {
    setState({ phase: "looking" });
    try {
      const found = await lookUp((await files).slice(0, 20));
      if (mode === "reply") {
        const one = oneConversation(found);
        if (one) {
          setState({ phase: "idle" });
          handlers.current.onReply(one, found.map((f) => f.attach!));
        } else setState({ phase: "found", found, mode });
        return;
      }
      const one = sameEmail(found);
      if (one) {
        setState({ phase: "idle" });
        handlers.current.onOpen(one);
      } else setState({ phase: "found", found, mode });
    } catch (error) {
      setState({ phase: "error", message: error instanceof Error ? error.message : "Kite couldn't look those files up. Try again." });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const files = (e: DragEvent) => !!e.dataTransfer?.types.includes("Files");
    // React's handlers (composers, other drop zones) run first, at the app's root: a drop they took is defaultPrevented.
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      clearTimeout(hide.current);
      // dragover repeats while a drag is over the window; when it stops, the drag left or ended.
      hide.current = setTimeout(() => setDragging(false), 150);
      if (e.defaultPrevented) return setDragging(false);
      e.preventDefault();
      e.dataTransfer!.dropEffect = "link";
      setDragging(true);
    };
    const drop = (e: DragEvent) => {
      if (!files(e) || e.defaultPrevented) return;
      e.preventDefault();
      clearTimeout(hide.current);
      setDragging(false);
      const list = [...(e.dataTransfer?.files ?? [])];
      if (list.length) void find(Promise.all(list.map(fingerprint)));
    };
    document.addEventListener("dragover", over);
    document.addEventListener("drop", drop);
    return () => {
      document.removeEventListener("dragover", over);
      document.removeEventListener("drop", drop);
      clearTimeout(hide.current);
    };
  }, [enabled, find]);

  const close = useCallback(() => setState({ phase: "idle" }), []);
  const ui = (
    <>
      <AnimatePresence>
        {dragging ? (
          <motion.div {...blurFade({ y: 6, blur: 6 })} className="pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center">
            <div className="ink-chrome flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium shadow-2xl">
              <Icon icon={FileSearchIcon} size={16} />
              Drop to find its email
            </div>
          </motion.div>
        ) : null}
        {state.phase === "looking" ? (
          <motion.div {...blurFade({ y: 6, blur: 6 })} className="pointer-events-none fixed inset-x-0 top-6 z-50 flex justify-center">
            <div className="ink-chrome flex items-center gap-2 rounded-full px-4 py-2 text-[13px] font-medium shadow-2xl">
              <Spinner size={14} />
              Finding its email…
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
      <Dialog
        open={state.phase === "found" || state.phase === "error"}
        onClose={close}
        title={
          state.phase === "found" && state.mode === "reply"
            ? "Send back to which email?"
            : state.phase === "found" && state.found.length > 1 ? "Where these files came from" : "Where this file came from"
        }
      >
        {state.phase === "error" ? (
          <p className="px-5 pb-5 text-[13px] text-pane-muted">{state.message}</p>
        ) : state.phase === "found" ? (
          <div className="flex flex-col gap-4 overflow-y-auto px-5 pb-5 scroll-fade">
            {state.found.map((f, i) => (
              <Result
                key={i}
                found={f}
                many={state.found.length > 1}
                reply={state.mode === "reply"}
                onPick={(item) => {
                  close();
                  if (state.mode === "reply" && f.attach) onReply(item, [f.attach]);
                  else onOpen(item);
                }}
              />
            ))}
          </div>
        ) : null}
      </Dialog>
    </>
  );
  return { find, ui };
}

function Result({ found, many, reply, onPick }: { found: Found; many: boolean; reply: boolean; onPick: (item: FileItem) => void }) {
  const { exact, named } = found.origin;
  // Send back can't reply with a file that didn't upload: say why, offer nothing to click.
  const items = reply && !found.attach ? [] : exact.length ? exact : named;
  return (
    <section className="flex min-w-0 flex-col gap-1.5">
      {many ? <h3 data-sensitive="" className="truncate text-[13px] font-semibold">{found.name}</h3> : null}
      <p className="text-[12.5px] text-pane-muted">
        {reply && found.attachError
          ? found.attachError
          : exact.length
          ? exact.length > 1 ? `In ${exact.length} emails:` : "It came with this email:"
          : named.length
            ? "Kite hasn't seen this exact file, but one with the same name came with:"
            : "Kite hasn't seen this file. It finds files once they've been opened or downloaded in Kite."}
      </p>
      {items.length ? (
        <FluidList tone="pane" className="-mx-2 flex flex-col">
          {items.map((item) => (
            <button
              key={`${item.accountId}:${item.messageId}:${item.partId}`}
              {...FLUID_ITEM}
              onClick={() => onPick(item)}
              className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2 text-left transition-[background-color] duration-150 data-[lit]:bg-pane-hover"
            >
              <Icon icon={Mail01Icon} size={18} className="shrink-0 text-pane-muted" />
              <span data-sensitive="" className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-[13px] font-medium">{item.subject || "(no subject)"}</span>
                <span className="truncate text-[12px] text-pane-muted">
                  {item.from.name || item.from.email} · {format(new Date(item.date), "d MMM yyyy")}
                  {exact.length ? "" : ` · ${item.name}`}
                </span>
              </span>
              {reply ? <span className="shrink-0 text-[12px] font-medium text-accent">Reply with this file</span> : null}
            </button>
          ))}
        </FluidList>
      ) : null}
    </section>
  );
}
