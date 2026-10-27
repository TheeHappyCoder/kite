"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EMPTY_BRAND, starterDesign, type EmailTemplate } from "@/lib/design/brand";
import type { Design } from "@/lib/design/spec";
import { bodyToText } from "@/lib/mail/body";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { DesignEditor } from "../design/design-editor";
import { DesignPreview } from "../design/design-preview";
import { loadMailDesigns, saveTemplate, type MailDesigns } from "../design/mail-designs";

const pill = "h-7 rounded-full border border-pane-border px-3 text-[12px] font-medium hover:bg-pane-hover disabled:opacity-40";

/**
 * Compose in Design mode: the designed email (click to edit it in the design editor), saving it
 * as a template, or, before there is one, starting points (blank with the brand kit, or a template).
 */
export function DesignedBody({
  design,
  body,
  subject,
  recipients,
  sender,
  onDesign,
  onTemplate,
}: {
  design: Design | undefined;
  /** The plain body written so far: a blank design starts with it. */
  body: string;
  subject: string;
  recipients?: EmailTemplate["recipients"];
  sender: { name: string; email: string };
  onDesign: (design: Design) => void;
  onTemplate: (template: EmailTemplate) => void;
}) {
  const [library, setLibrary] = useState<MailDesigns | null>(null);
  const [failed, setFailed] = useState(false);
  const [editor, setEditor] = useState({ open: false, key: 0 });
  const [naming, setNaming] = useState<string | null>(null);
  const [keepRecipients, setKeepRecipients] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    loadMailDesigns()
      .then(setLibrary)
      .catch(() => setFailed(true));
  }, []);

  const openEditor = () => setEditor((e) => ({ open: true, key: e.key + 1 }));

  const startBlank = () => {
    onDesign(starterDesign(library?.brand ?? EMPTY_BRAND, bodyToText(body)));
    openEditor();
  };

  const saveAs = async () => {
    if (!design || !naming?.trim()) return;
    try {
      const template = await saveTemplate({ name: naming.trim(), subject, design, recipients: keepRecipients ? recipients : undefined });
      setLibrary((l) => (l ? { ...l, templates: [template, ...l.templates] } : l));
      setNaming(null);
      setNotice(`Saved as “${template.name}”. Find it under Settings → Templates.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That didn't save. Try again.");
    }
  };

  return (
    <div className="flex min-w-0 flex-col gap-2">
      {design ? (
        <>
          <button
            type="button"
            aria-label="Edit design"
            onClick={openEditor}
            className="blur-fade block w-full min-w-0 overflow-hidden rounded-xl border border-pane-border text-left transition-colors hover:border-accent/50"
          >
            <DesignPreview design={design} kind="email" className="pointer-events-none max-h-[340px] overflow-hidden p-2" />
          </button>
          <AnimatePresence mode="popLayout" initial={false}>
            {naming !== null ? (
              <motion.form
                key="naming"
                {...blurFade({ y: 3, blur: 3 })}
                onSubmit={(e) => {
                  e.preventDefault();
                  void saveAs();
                }}
                className="flex min-w-0 flex-wrap items-center gap-1.5"
              >
                <label className="text-xs"><input type="checkbox" checked={keepRecipients} onChange={(e) => setKeepRecipients(e.target.checked)} /> Remember To, Cc and Bcc</label>
                <input
                  autoFocus
                  value={naming}
                  maxLength={60}
                  onChange={(e) => setNaming(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      setNaming(null);
                    }
                  }}
                  placeholder="Template name"
                  className="h-7 min-w-0 flex-1 basis-40 rounded-full border border-pane-border bg-pane-2 px-3 text-[12px] outline-none focus:border-accent/60"
                />
                <button type="submit" disabled={!naming.trim()} className={cn(pill, "border-transparent bg-pane-fg text-pane hover:bg-pane-fg")}>
                  Save template
                </button>
                <button type="button" onClick={() => setNaming(null)} className={pill}>
                  Cancel
                </button>
              </motion.form>
            ) : (
              <motion.div key="actions" {...blurFade({ y: 3, blur: 3 })} className="flex flex-wrap items-center gap-1.5">
                <button type="button" onClick={openEditor} className={pill}>
                  Edit design
                </button>
                <button type="button" onClick={() => setNaming(subject.trim().slice(0, 60))} className={pill}>
                  Save as template
                </button>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      ) : (
        <div className="blur-fade flex min-w-0 flex-col gap-2">
          <p className="text-[12.5px] text-pane-muted">
            {failed ? "Templates couldn't be loaded. Start blank instead." : "Start a designed email from your brand kit or a template."}
          </p>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-2">
            <StartCard label="Blank" design={starterDesign(library?.brand ?? EMPTY_BRAND, bodyToText(body))} index={0} onPick={startBlank} />
            {library?.templates.map((t, i) => <StartCard key={t.id} label={t.name} design={t.design} index={i + 1} onPick={() => onTemplate(t)} />)}
          </div>
        </div>
      )}

      <AnimatePresence>
        {notice ? (
          <motion.p {...blurFade({ y: 3, blur: 3 })} className="flex items-start gap-2 text-[12px] text-pane-muted">
            <span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice(null)} className="font-medium text-accent hover:opacity-80">
              OK
            </button>
          </motion.p>
        ) : null}
      </AnimatePresence>

      <DesignEditor
        key={editor.key}
        open={editor.open}
        kind="email"
        title="Designed email"
        description="Your signature and any quoted message are added below it when you send. Images travel inside the email."
        sender={sender}
        initial={design ?? null}
        saveLabel="Use in message"
        onSave={onDesign}
        onClose={() => setEditor((e) => ({ ...e, open: false }))}
      />
    </div>
  );
}

function StartCard({ label, design, index, onPick }: { label: string; design: Design; index: number; onPick: () => void }) {
  return (
    <button
      type="button"
      onClick={onPick}
      className="blur-fade-up flex min-w-0 flex-col gap-1.5 rounded-xl border border-pane-border p-1.5 text-left transition-colors hover:border-accent/50"
      style={{ "--i": index } as React.CSSProperties}
    >
      <div className="pointer-events-none h-[96px] overflow-hidden rounded-lg">
        <DesignPreview design={design} kind="email" className="w-[166%] origin-top-left scale-[0.6] p-2" />
      </div>
      <span className="truncate px-1 text-[12px] font-medium">{label}</span>
    </button>
  );
}
