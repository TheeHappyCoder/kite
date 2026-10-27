"use client";

import { useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { bodyToText } from "@/lib/mail/body";
import { blurFade } from "@/lib/motion";
import { Snippet } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { FormatBar, RichEditor, type FormatState, type RichEditorHandle } from "../mail/rich-editor";

const buttonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors hover:bg-pane-hover disabled:opacity-40";

/** Snippets: reusable text typed with ";trigger" in any message. Stored in preferences. */
export function SnippetsSection({ snippets, onSave }: { snippets: Snippet[]; onSave: (snippets: Snippet[]) => Promise<void> }) {
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const save = async (snippet: Snippet) => {
    const exists = snippets.some((s) => s.id === snippet.id);
    await onSave(exists ? snippets.map((s) => (s.id === snippet.id ? snippet : s)) : [...snippets, snippet]);
    setEditing(null);
  };

  return (
    <div className="flex flex-col gap-3">
      {snippets.length ? (
        <div className="flex flex-col divide-y divide-pane-border rounded-xl border border-pane-border">
          {snippets.map((snippet, i) =>
            editing !== "new" && editing?.id === snippet.id ? (
              <SnippetForm key={snippet.id} initial={snippet} others={snippets} onSave={save} onCancel={() => setEditing(null)} />
            ) : (
              <div key={snippet.id} className="blur-fade-up flex items-center gap-3 px-4 py-3" style={{ "--i": i } as React.CSSProperties}>
                <span className="shrink-0 rounded-full bg-accent-soft px-2 py-0.5 tabular-nums text-[12px] text-accent">;{snippet.trigger}</span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-pane-muted">{bodyToText(snippet.body).replace(/\s+/g, " ")}</span>
                <AnimatePresence mode="popLayout" initial={false}>
                  {confirming === snippet.id ? (
                    <motion.div key="confirm" {...blurFade({ x: 6, blur: 4 })} className="flex items-center gap-1.5">
                      <button onClick={() => setConfirming(null)} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
                        Keep
                      </button>
                      <button
                        onClick={() => {
                          setConfirming(null);
                          void onSave(snippets.filter((s) => s.id !== snippet.id));
                        }}
                        className="h-8 rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane"
                      >
                        Delete
                      </button>
                    </motion.div>
                  ) : (
                    <motion.div key="actions" {...blurFade({ x: -6, blur: 4 })} className="flex items-center gap-1.5">
                      <button onClick={() => setEditing(snippet)} className={buttonClass}>
                        Edit
                      </button>
                      <button onClick={() => setConfirming(snippet.id)} className={buttonClass}>
                        Delete
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            ),
          )}
        </div>
      ) : null}
      {editing === "new" ? (
        <div className="rounded-xl border border-pane-border">
          <SnippetForm others={snippets} onSave={save} onCancel={() => setEditing(null)} />
        </div>
      ) : (
        <button onClick={() => setEditing("new")} className={cn(buttonClass, "self-start")}>
          New snippet
        </button>
      )}
    </div>
  );
}

function SnippetForm({
  initial,
  others,
  onSave,
  onCancel,
}: {
  initial?: Snippet;
  others: Snippet[];
  onSave: (snippet: Snippet) => Promise<void>;
  onCancel: () => void;
}) {
  const [trigger, setTrigger] = useState(initial?.trigger ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [format, setFormat] = useState<FormatState>({ bold: false, italic: false, bulletList: false, numberList: false });
  const editor = useRef<RichEditorHandle>(null);

  const submit = async () => {
    const parsed = Snippet.safeParse({ id: initial?.id ?? crypto.randomUUID(), trigger: trigger.trim(), body });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check the snippet");
    if (others.some((s) => s.id !== parsed.data.id && s.trigger.toLowerCase() === parsed.data.trigger.toLowerCase())) {
      return setError(`;${parsed.data.trigger} is already a snippet. Pick another word.`);
    }
    setBusy(true);
    try {
      await onSave(parsed.data);
    } catch {
      setError("That didn't save. Try again.");
      setBusy(false);
    }
  };

  return (
    <div className="blur-fade-up flex flex-col gap-3 p-4">
      <label className="flex items-center gap-2 self-start rounded-full border border-pane-border px-3 focus-within:border-accent/50">
        <span className="tabular-nums text-[13px] text-accent">;</span>
        <input
          autoFocus
          value={trigger}
          onChange={(e) => {
            setTrigger(e.target.value.replace(/\s/g, ""));
            setError(null);
          }}
          placeholder="thanks"
          aria-label="Trigger word"
          className="h-8 w-40 bg-transparent tabular-nums text-[13px] outline-none placeholder:text-pane-muted"
        />
      </label>
      <div className="rounded-xl border border-pane-border focus-within:border-accent/50">
        <RichEditor
          ref={editor}
          initial={initial?.body}
          onChange={(markup) => {
            setBody(markup);
            setError(null);
          }}
          onFormat={setFormat}
          placeholder="The text this snippet adds"
          ariaLabel="Snippet text"
          className="max-h-60 min-h-24 overflow-y-auto px-3 py-2 text-[13px] leading-6"
        />
        <div className="border-t border-pane-border px-2 py-1">
          <FormatBar editor={editor} state={format} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <p className={cn("flex-1 text-[12px]", error ? "text-warning" : "text-pane-muted")}>
          {error ?? "Type ; and the word in any message to add this text."}
        </p>
        <button onClick={onCancel} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
          Cancel
        </button>
        <button onClick={() => void submit()} disabled={busy} className="h-8 rounded-full bg-accent px-3.5 text-[12.5px] font-medium text-accent-fg disabled:opacity-60">
          Save
        </button>
      </div>
    </div>
  );
}
