"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Alert02Icon, Image01Icon, TextIcon } from "@hugeicons/core-free-icons";
import { generatedText } from "@/lib/design/compile";
import type { DesignAsset, DesignKind } from "@/lib/design/prompt";
import { Design, designAssets, type Block, type DesignTheme } from "@/lib/design/spec";
import { PALETTES, SIGNATURE_TEMPLATES } from "@/lib/design/templates";
import type { Account } from "@/lib/mail/types";
import { blurFade, springSnappy } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Dialog } from "../ui/dialog";
import { Tooltip } from "../ui/tooltip";
import { firstFrame, listAssets, uploadAsset } from "./assets";
import { BlockList, ColorField, Row, Segmented, type EditorContext } from "./block-editor";
import { DesignPreview, type PreviewMode } from "./design-preview";
import { placeholderImages, unplaced, withRealImages } from "./placeholders";
import { PromptKit } from "./prompt-kit";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
type Tab = "design" | "ai" | "text";

const PREVIEWS: [PreviewMode, string][] = [
  ["gmail", "Gmail"],
  ["outlook", "Outlook"],
  ["images-off", "Images off"],
  ["text", "Text only"],
];

function issues(error: { issues: { path: PropertyKey[]; message: string }[] }) {
  return error.issues.slice(0, 4).map((i) => {
    const where = i.path.filter((p) => typeof p === "number").map((n) => Number(n) + 1);
    return where.length ? `Block ${where.join(" › ")}: ${i.message}` : i.message;
  });
}

export function SignatureEditor({
  open,
  account,
  initial,
  onSave,
  onRemove,
  onClose,
}: {
  open: boolean;
  account: Account;
  initial: Design | null;
  onSave: (design: Design) => Promise<void>;
  onRemove: () => Promise<void>;
  onClose: () => void;
}) {
  return (
    <DesignEditor
      open={open}
      kind="signature"
      title={`Signature for ${account.email}`}
      description="Added under new messages and replies. Images travel inside each email, so nothing needs hosting."
      sender={{ name: account.name, email: account.email }}
      initial={initial}
      saveLabel="Save signature"
      remove={{ label: "Remove signature", confirm: "Remove this signature? New messages won't have one.", run: onRemove }}
      start={(pick, ai, upload) => (
        <Templates who={{ name: account.name || account.email.split("@")[0], email: account.email }} onPick={pick} onAi={ai} onUpload={upload} />
      )}
      onSave={onSave}
      onClose={onClose}
    />
  );
}

/**
 * The design editor (blocks, theme, plain text, your AI) with Gmail / Outlook / images off /
 * text previews. Signatures and designed emails both use it.
 */
export function DesignEditor({
  open,
  kind,
  title,
  description,
  sender,
  initial,
  saveLabel,
  remove,
  start,
  onSave,
  onClose,
}: {
  open: boolean;
  kind: DesignKind;
  title: string;
  description: string;
  sender: { name: string; email: string };
  initial: Design | null;
  saveLabel: string;
  remove?: { label: string; confirm: string; run: () => Promise<void> };
  /** Shown while there's no design yet: starting points. */
  /** Shown while there's no design yet: starting points. `pick`'s `select` opens a part right away; `upload` adds an image. */
  start?: (pick: (design: Design, select?: string) => void, ai: () => void, upload: (file: File) => Promise<DesignAsset | null>) => React.ReactNode;
  onSave: (design: Design) => Promise<void> | void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Design | null>(initial);
  const [tab, setTab] = useState<Tab>("design");
  const [mode, setMode] = useState<PreviewMode>("gmail");
  const [assets, setAssets] = useState<DesignAsset[]>([]);
  const [stills, setStills] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<"discard" | "remove" | null>(null);
  /** The block being edited: picked in the list or by clicking it in the preview. */
  const [selected, setSelected] = useState<string | null>(null);
  /** A template's placeholder images being added. */
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    listAssets().then(setAssets).catch(() => {});
  }, [open]);

  const parsed = useMemo(() => (draft ? Design.safeParse(draft) : null), [draft]);
  const valid = parsed?.success ? parsed.data : null;
  const [lastValid, setLastValid] = useState<Design | null>(initial);
  const shown = valid ?? lastValid;

  /** Every edit goes through here, so the preview can keep the last valid version while something is half-typed. */
  const change = (next: Design) => {
    setDraft(next);
    const result = Design.safeParse(next);
    if (result.success) setLastValid(result.data);
  };

  // First frames of the GIFs in use, for the Outlook preview and the image inspector.
  const gifs = useMemo(
    () => (draft ? designAssets(draft as Design).filter((id) => assets.find((a) => a.id === id)?.contentType === "image/gif") : []),
    [draft, assets],
  );
  useEffect(() => {
    for (const id of gifs) {
      if (stills[id]) continue;
      void firstFrame(id).then((url) => {
        if (url) setStills((s) => ({ ...s, [id]: url }));
      });
    }
  }, [gifs, stills]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);
  const requestClose = () => (dirty ? setConfirm("discard") : onClose());

  const context: EditorContext = {
    // A part inside columns picked in the preview: "block.column.part".
    part: selected?.split(".").length === 3 ? (selected.split(".").slice(1).map(Number) as [number, number]) : null,
    onPart: (block, column, part) => setSelected(part === null ? String(block) : `${block}.${column}.${part}`),
    theme: draft?.theme ?? Design.parse({ blocks: [{ type: "spacer" }] }).theme,
    assets,
    stills,
    onUpload: async (file) => {
      try {
        const asset = await uploadAsset(file);
        setAssets((list) => [asset, ...list.filter((a) => a.id !== asset.id)]);
        setNotice(null);
        return asset;
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "The upload didn't go through.");
        return null;
      }
    },
  };

  /** A starting point: its placeholder images are added as real ones, so clicking one replaces it. */
  const pickTemplate = async (design: Design, select?: string) => {
    setPicking(true);
    try {
      const { design: real, uploaded } = await withRealImages(design, sender, assets);
      if (uploaded.length) setAssets((list) => [...uploaded, ...list]);
      change(real);
      setSelected(select ?? null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "That starting point didn't load. Try again.");
    } finally {
      setPicking(false);
    }
  };

  const setBlocks = (blocks: Block[]) => draft && change({ ...draft, blocks });
  const setTheme = (patch: Partial<DesignTheme>) => {
    if (!draft) return;
    const next = { ...draft, theme: { ...draft.theme, ...patch } };
    change(next);
    // Placeholder pictures are drawn in the accent: a new accent redraws them.
    if (!patch.accent || patch.accent === draft.theme.accent) return;
    const back = unplaced(next as Design, assets);
    if (JSON.stringify(back) === JSON.stringify(next)) return;
    void withRealImages(back, sender, assets).then(({ design, uploaded }) => {
      if (uploaded.length) setAssets((list) => [...uploaded, ...list]);
      change(design);
    });
  };

  const save = async () => {
    if (!parsed?.success) return;
    setSaving(true);
    try {
      await onSave(parsed.data);
      onClose();
    } catch {
      setNotice("That didn't save. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const removeDesign = async () => {
    if (!remove) return;
    setSaving(true);
    try {
      await remove.run();
      onClose();
    } catch {
      setNotice("That didn't go through. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const errors = parsed && !parsed.success ? issues(parsed.error) : [];

  return (
    <Dialog
      open={open}
      onClose={requestClose}
      title={title}
      description={description}
      className="w-[min(1120px,calc(100vw-32px))]"
      footer={
        <AnimatePresence mode="popLayout" initial={false}>
          {confirm ? (
            <motion.div key="confirm" {...blurFade({ y: 4 })} className="flex w-full items-center gap-2">
              <p className="flex-1 text-[12.5px] text-pane-muted">
                {confirm === "discard" ? "Close without saving your changes?" : remove?.confirm}
              </p>
              <button onClick={() => setConfirm(null)} className={ghostClass}>
                Keep editing
              </button>
              <button onClick={confirm === "discard" ? onClose : removeDesign} disabled={saving} className={primaryClass}>
                {confirm === "discard" ? "Discard changes" : remove?.label}
              </button>
            </motion.div>
          ) : (
            <motion.div key="actions" {...blurFade({ y: 4 })} className="flex w-full items-center gap-2">
              {initial && remove ? (
                <button onClick={() => setConfirm("remove")} className={ghostClass}>
                  {remove.label}
                </button>
              ) : null}
              <AnimatePresence>
                {errors.length ? (
                  <motion.p {...blurFade({ x: -4, blur: 3 })} className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-warning">
                    <Icon icon={Alert02Icon} size={13} className="shrink-0" />
                    <span className="truncate">{errors[0]}</span>
                  </motion.p>
                ) : null}
              </AnimatePresence>
              <button onClick={requestClose} className={cn(ghostClass, "ml-auto")}>
                Cancel
              </button>
              <button onClick={save} disabled={!valid || saving || !dirty} className={primaryClass}>
                {saving ? <Spinner /> : null}
                {saving ? "Saving…" : saveLabel}
              </button>
            </motion.div>
          )}
        </AnimatePresence>
      }
    >
      {/* Keys typed here are for the editor, not the mail shortcuts behind it. */}
      {/* Side by side while both fit; stacked (editor above the preview) in a narrow window. */}
      <div className="@container h-[68vh] min-h-[420px] border-t border-pane-border max-sm:h-[80vh]" onKeyDown={(e) => e.key !== "Escape" && e.stopPropagation()}>
      <div className="flex h-full @max-[820px]:flex-col">
        <div className="flex w-[420px] shrink-0 flex-col border-r border-pane-border @max-[820px]:max-h-[55%] @max-[820px]:min-h-0 @max-[820px]:w-full @max-[820px]:flex-1 @max-[820px]:border-b @max-[820px]:border-r-0">
          <div className="px-4 pt-3">
            <Segmented
              fill
              value={tab}
              options={[["design", "Design"], ["ai", "With your AI"], ["text", "Plain text"]]}
              onChange={setTab}
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div key={tab} {...blurFade({ y: 6 })}>
                {tab === "ai" ? (
                  <PromptKit
                    kind={kind}
                    current={valid}
                    assets={assets}
                    sender={sender}
                    onApply={(design) => {
                      change(design);
                      setTab("design");
                    }}
                  />
                ) : tab === "text" ? (
                  <PlainText draft={draft} onChange={(text) => draft && change({ ...draft, text: text || undefined })} />
                ) : draft ? (
                  <div className="flex flex-col gap-5">
                    <Section title="Style" action={start ? <button onClick={() => { setDraft(null); setSelected(null); }} className="text-[12px] font-medium text-accent hover:opacity-80">Start over</button> : null}>
                      <StyleFields theme={draft.theme} onChange={setTheme} />
                    </Section>
                    <Section title="Parts" note="Click one here or in the preview to change it.">
                      <BlockList
                        blocks={draft.blocks}
                        onChange={setBlocks}
                        context={context}
                        open={selected === null ? null : Number(selected.split(".")[0])}
                        onOpen={(index) => setSelected(index === null ? null : String(index))}
                      />
                    </Section>
                  </div>
                ) : picking ? (
                  <p className="flex items-center gap-2 py-8 text-[12.5px] text-pane-muted">
                    <Spinner size={13} /> Setting it up…
                  </p>
                ) : (
                  start?.((design, select) => void pickTemplate(design, select), () => setTab("ai"), context.onUpload)
                )}
              </motion.div>
            </AnimatePresence>
            <AnimatePresence>
              {notice ? (
                <motion.p {...blurFade({ y: 4 })} className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-[12px] text-warning">
                  {notice}
                </motion.p>
              ) : null}
            </AnimatePresence>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col bg-pane-2">
          <div className="flex items-center gap-3 px-5 pt-3">
            <span className="text-[12px] text-pane-muted">Preview</span>
            <PreviewTabs value={mode} onChange={setMode} />
            {shown && mode !== "text" ? <span className="ml-auto hidden text-[11.5px] text-pane-muted @min-[820px]:inline">Click any part to change it</span> : null}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6 pt-4">
            {shown ? (
              <div className="blur-fade mx-auto max-w-[640px] rounded-xl border border-pane-border bg-white p-5 shadow-sm">
                {kind === "signature" ? (
                  <p className="mb-4 text-[13px] leading-6 text-[#1b1b1f]">
                    Hi Sam,
                    <br />
                    Thanks for the update. Talk soon.
                  </p>
                ) : null}
                <DesignPreview
                  design={shown}
                  mode={mode}
                  stills={stills}
                  kind={kind}
                  className="p-0"
                  selected={tab === "design" ? selected : null}
                  onSelect={(index) => {
                    setTab("design");
                    setSelected(index);
                  }}
                />
              </div>
            ) : (
              <p className="grid h-full place-items-center text-[12.5px] text-pane-muted">Pick a starting point to see it here.</p>
            )}
            <PreviewNote mode={mode} kind={kind} />
          </div>
        </div>
      </div>
      </div>
    </Dialog>
  );
}

const ghostClass = "h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg";
const primaryClass = "flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane disabled:opacity-40";

function PreviewTabs({ value, onChange }: { value: PreviewMode; onChange: (mode: PreviewMode) => void }) {
  return (
    <FluidList axis="x" tone="pill" className="flex items-center rounded-full bg-pane p-[2px] shadow-[inset_0_0_0_1px_var(--pane-border)]">
      {PREVIEWS.map(([id, label]) => (
        <button
          key={id}
          {...FLUID_ITEM}
          onClick={() => onChange(id)}
          className={cn("relative h-6 rounded-full px-2.5 text-[11.5px] transition-[color,background-color,font-weight] duration-150", id === value ? "font-semibold text-pane-fg" : "font-medium text-pane-muted data-[lit]:text-pane-fg")}
        >
          {id === value ? (
            <motion.span
              layoutId="preview-mode"
              transition={springSnappy}
              className="absolute inset-0 rounded-full bg-pane-raised shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]"
            />
          ) : null}
          <span className="relative">{label}</span>
        </button>
      ))}
    </FluidList>
  );
}

const NOTES: Record<PreviewMode, string> = {
  gmail: "How Gmail, Apple Mail and most phones show it.",
  outlook: "Outlook on Windows: square corners and only the first frame of a GIF.",
  "images-off": "What people see before they load images (common in Outlook and at work): your alt text.",
  text: "For text-only clients and notifications. Edit it under Plain text.",
};

function PreviewNote({ mode, kind }: { mode: PreviewMode; kind: DesignKind }) {
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.p key={mode} {...blurFade({ y: 3, blur: 3 })} className="mx-auto mt-3 max-w-[640px] text-[11.5px] text-pane-muted">
        {NOTES[mode]}
        {kind === "email" && mode !== "text" ? " Your signature and any quoted message follow below it." : ""}
      </motion.p>
    </AnimatePresence>
  );
}

/** A titled part of the editor's left side. */
function Section({ title, note, action, children }: { title: string; note?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-pane-muted">{title}</h3>
        {note ? <span className="truncate text-[11.5px] text-pane-muted">{note}</span> : null}
        <span className="ml-auto">{action}</span>
      </div>
      {children}
    </section>
  );
}

/** Colours as palettes that go together, the two fonts as cards; exact colours behind "Custom". */
function StyleFields({ theme, onChange }: { theme: DesignTheme; onChange: (patch: Partial<DesignTheme>) => void }) {
  const current = PALETTES.find((p) => p.theme.text === theme.text && p.theme.muted === theme.muted && p.theme.accent === theme.accent);
  const [custom, setCustom] = useState(!current);
  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        {(["sans", "serif"] as const).map((font) => (
          <button
            key={font}
            onClick={() => onChange({ font })}
            className={cn(
              "flex items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors duration-150",
              theme.font === font ? "border-accent bg-accent-soft/60" : "border-pane-border hover:bg-pane-hover",
            )}
          >
            <span className="text-[22px] leading-none" style={{ fontFamily: font === "serif" ? "Georgia, serif" : "'Segoe UI', system-ui, sans-serif" }}>
              Aa
            </span>
            <span className="flex flex-col">
              <span className="text-[12.5px] font-medium">{font === "sans" ? "Clean" : "Classic"}</span>
              <span className="text-[11px] text-pane-muted">{font === "sans" ? "Sans serif" : "Serif"}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {PALETTES.map((p) => {
          const on = current?.id === p.id && !custom;
          return (
            <Tooltip key={p.id} label={p.name} side="top">
              <button
                aria-label={p.name}
                onClick={() => {
                  setCustom(false);
                  onChange(p.theme);
                }}
                className={cn("flex h-8 items-center gap-0.5 rounded-full border px-1.5 transition-colors duration-150", on ? "border-accent" : "border-pane-border hover:border-pane-muted")}
              >
                <span className="size-4 rounded-full" style={{ background: p.theme.text }} />
                <span className="size-4 rounded-full" style={{ background: p.theme.accent }} />
              </button>
            </Tooltip>
          );
        })}
        <button
          onClick={() => setCustom((c) => !c)}
          className={cn("h-8 rounded-full border px-3 text-[12px] transition-colors duration-150", custom ? "border-accent font-medium" : "border-pane-border text-pane-muted hover:text-pane-fg")}
        >
          Custom
        </button>
      </div>
      <AnimatePresence initial={false}>
        {custom ? (
          <motion.div {...blurFade({ y: -4 })} className="flex flex-col gap-2 rounded-xl bg-pane-2 p-3">
            <Row label="Text">
              <ColorField key={`t${theme.text}`} value={theme.text} fallback="#1b1b1f" onChange={(text) => onChange({ text: text ?? "#1b1b1f" })} />
            </Row>
            <Row label="Quiet">
              <ColorField key={`m${theme.muted}`} value={theme.muted} fallback="#6f6f7a" onChange={(muted) => onChange({ muted: muted ?? "#6f6f7a" })} />
            </Row>
            <Row label="Accent">
              <ColorField key={`a${theme.accent}`} value={theme.accent} fallback="#305dde" onChange={(accent) => onChange({ accent: accent ?? "#305dde" })} />
            </Row>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Templates({
  who,
  onPick,
  onAi,
  onUpload,
}: {
  who: { name: string; email: string };
  onPick: (design: Design, select?: string) => void;
  onAi: () => void;
  onUpload: (file: File) => Promise<DesignAsset | null>;
}) {
  // Drawn once per person (the placeholders are canvases), not on every render.
  const { name, email } = who;
  const cards = useMemo(
    () =>
      SIGNATURE_TEMPLATES.map((t) => {
        const design = t.build({ name, email });
        return { t, design, images: placeholderImages(design.theme, { name, email }) };
      }),
    [name, email],
  );
  return (
    <div className="flex flex-col gap-3">
      <Section title="Already have one?">
        <Ready who={who} onPick={onPick} onUpload={onUpload} />
      </Section>
      <Section title="Or design one" note="Your name and address are already in.">
      <div className="grid grid-cols-1 gap-2.5">
        {cards.map(({ t, design, images }, i) => (
          <button
            key={t.id}
            onClick={() => onPick(design)}
            className="blur-fade-up group flex flex-col overflow-hidden rounded-2xl border border-pane-border text-left transition-[border-color,box-shadow] duration-150 hover:border-accent/60 hover:shadow-[0_8px_24px_-12px_rgb(10_30_70/0.25)]"
            style={{ "--i": i } as React.CSSProperties}
          >
            <div className="pointer-events-none bg-white px-4 py-3.5">
              <DesignPreview design={design} images={images} className="p-0" />
            </div>
            <div className="flex items-baseline gap-2 border-t border-pane-border bg-pane-2 px-4 py-2">
              <span className="text-[12.5px] font-medium">{t.name}</span>
              <span className="truncate text-[11.5px] text-pane-muted">{t.note}</span>
            </div>
          </button>
        ))}
      </div>
      </Section>
      <button onClick={onAi} className="mt-1 text-left text-[12.5px] font-medium text-accent hover:opacity-80">
        Or describe it to your AI →
      </button>
    </div>
  );
}

/**
 * For a signature made somewhere else: a finished image (a company or designer one) as the whole
 * signature, or plain text typed or pasted in. Both are still a design underneath, so they send the
 * same way and can be changed later.
 */
function Ready({
  who,
  onPick,
  onUpload,
}: {
  who: { name: string; email: string };
  onPick: (design: Design, select?: string) => void;
  onUpload: (file: File) => Promise<DesignAsset | null>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [writing, setWriting] = useState(false);
  const [text, setText] = useState(`${who.name}\nYour role · Company\n${who.email}`);

  const takeImage = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    const asset = await onUpload(file);
    setBusy(false);
    if (!asset) return;
    onPick(
      Design.parse({ blocks: [{ type: "image", src: `asset:${asset.id}`, alt: `${who.name}, ${who.email}`, width: Math.min(asset.width, 560) }] }),
      "0",
    );
  };
  const takeText = () => {
    const clean = text.trim();
    if (!clean) return;
    onPick(Design.parse({ blocks: [{ type: "text", text: clean.slice(0, 2000) }] }), "0");
  };

  const card =
    "flex items-center gap-3 rounded-2xl border border-pane-border px-3.5 py-3 text-left transition-[border-color,background-color] duration-150 hover:border-accent/60 hover:bg-pane-2 disabled:opacity-60";
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <button onClick={() => fileRef.current?.click()} disabled={busy} className={card}>
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
            {busy ? <Spinner size={15} /> : <Icon icon={Image01Icon} size={17} />}
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium">{busy ? "Adding it…" : "Use an image"}</span>
            <span className="text-[11.5px] leading-snug text-pane-muted">A finished one, as is</span>
          </span>
        </button>
        <button onClick={() => setWriting((w) => !w)} className={cn(card, writing && "border-accent/60 bg-pane-2")}>
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
            <Icon icon={TextIcon} size={17} />
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium">Just text</span>
            <span className="text-[11.5px] leading-snug text-pane-muted">Type or paste it</span>
          </span>
        </button>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          void takeImage(file);
        }}
      />
      <AnimatePresence initial={false}>
        {writing ? (
          <motion.div {...blurFade({ y: -4 })} className="flex flex-col gap-2 rounded-2xl bg-pane-2 p-3">
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={5}
              className="block w-full resize-y rounded-lg border border-pane-border bg-pane px-3 py-2 text-[13px] leading-5 outline-none focus:border-accent/60"
            />
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[11.5px] text-pane-muted">Links work as [label](https://…).</span>
              <button onClick={takeText} disabled={!text.trim()} className={primaryClass}>
                Use this text
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function PlainText({ draft, onChange }: { draft: Design | null; onChange: (text: string) => void }) {
  if (!draft) return <p className="text-[12.5px] text-pane-muted">Pick a design first.</p>;
  const generated = generatedText(draft);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[12.5px] text-pane-muted">
        Kite writes this from your design. Change it if you want something different for text-only clients.
      </p>
      <textarea
        value={draft.text ?? generated}
        onChange={(e) => onChange(e.target.value === generated ? "" : e.target.value)}
        rows={8}
        className="block w-full resize-y rounded-lg border border-pane-border bg-pane-2 px-2.5 py-2 tabular-nums text-[12px] leading-5 outline-none focus:border-accent/60"
      />
      {draft.text ? (
        <button onClick={() => onChange("")} className="w-fit text-[12px] font-medium text-accent hover:opacity-80">
          Go back to the generated version
        </button>
      ) : null}
    </div>
  );
}
