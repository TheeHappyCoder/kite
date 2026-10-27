"use client";

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { EMPTY_BRAND, type BrandKit, type EmailTemplate } from "@/lib/design/brand";
import { DesignTheme } from "@/lib/design/spec";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { uploadAsset } from "../design/assets";
import { ColorField, Segmented } from "../design/block-editor";
import { DesignPreview } from "../design/design-preview";
import { deleteTemplate, loadMailDesigns, saveBrand } from "../design/mail-designs";
import { Group } from "./settings-ui";
import { Spinner } from "../ui/spinner";

const pill = "h-7 shrink-0 rounded-full border border-pane-border px-3 text-[12px] font-medium hover:bg-pane-hover disabled:opacity-40";
const DEFAULTS = DesignTheme.parse({});

/** Settings → Templates: the brand kit new designed emails start from, and saved email templates. */
export function TemplatesSection({ onToast }: { onToast: (message: string) => void }) {
  const [brand, setBrand] = useState<BrandKit | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    loadMailDesigns()
      .then((data) => {
        setBrand(data.brand);
        setTemplates(data.templates);
      })
      .catch(() => setBrand(EMPTY_BRAND));
  }, []);

  const commit = (patch: Partial<BrandKit>) => {
    if (!brand) return;
    const next = { ...brand, ...patch };
    setBrand(next);
    saveBrand(next).catch(() => onToast("The brand kit didn't save. Try again."));
  };

  const uploadLogo = async (file: File) => {
    try {
      const asset = await uploadAsset(file);
      commit({ logo: asset.id, logoAlt: brand?.logoAlt || file.name.replace(/\.[^.]+$/, ""), logoWidth: Math.min(asset.width, 200) });
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The upload didn't go through.");
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteTemplate(id);
      setTemplates((list) => list.filter((t) => t.id !== id));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That didn't go through.");
    }
    setConfirm(null);
  };

  return (
    <>
    <Group title="Brand kit" description="New designed emails start with your logo, colours and font." bare>
      <div className="flex flex-col gap-3 rounded-xl border border-pane-border p-4">
        {brand ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-16 shrink-0 text-[12px] text-pane-muted">Logo</span>
              {brand.logo ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local design image */}
                  <img src={`/api/assets/${brand.logo}`} alt={brand.logoAlt || "Logo"} className="h-9 max-w-[140px] rounded object-contain" />
                  <input
                    key={brand.logo}
                    defaultValue={brand.logoAlt}
                    maxLength={200}
                    aria-label="Logo alt text"
                    placeholder="Alt text, e.g. Acme logo"
                    onBlur={(e) => e.target.value !== brand.logoAlt && commit({ logoAlt: e.target.value })}
                    className="h-7 min-w-0 flex-1 basis-40 rounded-lg border border-pane-border bg-pane-2 px-2.5 text-[12px] outline-none focus:border-accent/60"
                  />
                  <button onClick={() => fileInput.current?.click()} className={pill}>
                    Change
                  </button>
                  <button onClick={() => commit({ logo: null, logoAlt: "" })} className={pill}>
                    Remove
                  </button>
                </>
              ) : (
                <button onClick={() => fileInput.current?.click()} className={pill}>
                  Upload logo
                </button>
              )}
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void uploadLogo(file);
                  e.target.value = "";
                }}
              />
            </div>
            {(
              [
                ["accent", "Accent", DEFAULTS.accent],
                ["text", "Text", DEFAULTS.text],
                ["muted", "Muted", DEFAULTS.muted],
              ] as const
            ).map(([key, label, fallback]) => (
              <div key={key} className="flex flex-wrap items-center gap-3">
                <span className="w-16 shrink-0 text-[12px] text-pane-muted">{label}</span>
                <ColorField key={`${key}${brand[key]}`} value={brand[key] ?? undefined} fallback={fallback} onChange={(value) => commit({ [key]: value ?? null })} />
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <span className="w-16 shrink-0 text-[12px] text-pane-muted">Font</span>
              <Segmented value={brand.font} options={[["sans", "Sans"], ["serif", "Serif"], ["mono", "Mono"]]} onChange={(font) => commit({ font })} />
            </div>
          </>
        ) : (
          <p className="flex items-center gap-2 text-[12px] text-pane-muted">
            <Spinner size={13} />
            Loading…
          </p>
        )}
      </div>
    </Group>

    <Group title="Templates" description="Start a new message from one in Design mode." bare>

      {templates.length ? (
        <div className="flex flex-col divide-y divide-pane-border rounded-xl border border-pane-border">
          {templates.map((t, i) => (
            <div key={t.id} className="blur-fade-up flex min-w-0 items-center gap-3 px-3 py-2.5" style={{ "--i": i } as React.CSSProperties}>
              <div className="pointer-events-none h-14 w-24 shrink-0 overflow-hidden rounded-lg border border-pane-border">
                <DesignPreview design={t.design} kind="email" className="w-[400%] origin-top-left scale-[0.25] p-2" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{t.name}</p>
                <p className="truncate text-[12px] text-pane-muted">{t.subject || "No subject"}</p>
              </div>
              <AnimatePresence mode="popLayout" initial={false}>
                {confirm === t.id ? (
                  <motion.div key="confirm" {...blurFade({ x: 6, blur: 4 })} className="flex shrink-0 items-center gap-1.5">
                    <button onClick={() => setConfirm(null)} className={pill}>
                      Keep
                    </button>
                    <button onClick={() => void remove(t.id)} className={cn(pill, "border-transparent bg-pane-fg text-pane hover:bg-pane-fg")}>
                      Delete
                    </button>
                  </motion.div>
                ) : (
                  <motion.button key="delete" {...blurFade({ x: -6, blur: 4 })} onClick={() => setConfirm(t.id)} className={pill}>
                    Delete
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-xl border border-dashed border-pane-border px-4 py-3 text-[12.5px] text-pane-muted">
          No templates yet. In a new message, switch to Design, then choose Save as template.
        </p>
      )}
    </Group>
    </>
  );
}
