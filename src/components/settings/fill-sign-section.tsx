"use client";

import { useEffect, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Delete02Icon } from "@hugeicons/core-free-icons";
import type { Layout } from "@/lib/pdf/layout";
import { cn } from "@/lib/utils";
import { SignaturePad } from "../files/signature-pad";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { ProfileCard } from "./profile-card";
import { Group } from "./settings-ui";

// Settings → Fill & sign: the saved signature, the profile for "Fill from my profile", and the
// layouts remembered for "Sign like last time".

const buttonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors hover:bg-pane-hover disabled:opacity-40";

export function FillSignSection({
  signatureId,
  onSignature,
  onToast,
}: {
  signatureId: string | null;
  onSignature: (assetId: string | null) => Promise<void>;
  onToast: (message: string) => void;
}) {
  const [padOpen, setPadOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [layouts, setLayouts] = useState<Layout[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/fill-sign/layouts", { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { layouts: Layout[] }) => setLayouts(data.layouts))
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const remove = async (id: string) => {
    setConfirmDelete(null);
    const res = await fetch(`/api/fill-sign/layouts/${id}`, { method: "DELETE" }).catch(() => null);
    if (res?.ok) setLayouts((list) => list?.filter((l) => l.id !== id) ?? null);
    else onToast("Kite couldn't forget that layout. Try again.");
  };

  return (
    <>
      <Group title="Your signature" bare>
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-pane-border px-4 py-3">
        <div className="grid h-14 w-40 max-w-full shrink-0 place-items-center rounded-lg bg-white px-2">
          {signatureId ? (
            // eslint-disable-next-line @next/next/no-img-element -- the user's own signature from data/assets
            <img src={`/api/assets/${signatureId}`} alt="Your saved signature" className="max-h-12 max-w-full object-contain" />
          ) : (
            <span className="text-[12px] text-black/40">No signature yet</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-medium">Saved signature</p>
          <p className="mt-0.5 text-[12px] leading-snug text-pane-muted">
            {signatureId ? "Placed when you sign a PDF. Kept on this computer only." : "Draw or upload it once, then place it on any PDF."}
          </p>
        </div>
        {confirmRemove ? (
          <div className="blur-fade flex items-center gap-1.5">
            <span className="text-[12.5px] text-pane-muted">Remove it?</span>
            <button onClick={() => setConfirmRemove(false)} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
              Keep
            </button>
            <button
              onClick={() => {
                setConfirmRemove(false);
                void onSignature(null).catch(() => onToast("Kite couldn't remove the signature. Try again."));
              }}
              className="h-8 rounded-full bg-pane-fg px-3 text-[12.5px] font-medium text-pane hover:opacity-90"
            >
              Remove
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <button onClick={() => setPadOpen(true)} className={buttonClass}>
              {signatureId ? "Change" : "Add signature"}
            </button>
            {signatureId ? (
              <button onClick={() => setConfirmRemove(true)} className={cn(buttonClass, "border-transparent text-pane-muted")}>
                Remove
              </button>
            ) : null}
          </div>
        )}
      </div>
      </Group>

      <ProfileCard onToast={onToast} />

      <Group title="Remembered layouts" description="Forms Kite can sign like last time, by sender." bare>
        {layouts === null ? (
          <div className="h-14 animate-pulse rounded-xl bg-pane-2" />
        ) : layouts.length ? (
          <div className="flex flex-col divide-y divide-pane-border rounded-xl border border-pane-border">
            {layouts.map((layout, i) => (
              <div key={layout.id} className="blur-fade flex items-center gap-3 px-4 py-2.5" style={{ "--i": i } as React.CSSProperties}>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{layout.name}</p>
                  <p className="truncate text-[12px] text-pane-muted">
                    {layout.sender} · {layout.usedAt ? `last used ${formatDistanceToNow(new Date(layout.usedAt), { addSuffix: true })}` : "not used yet"}
                  </p>
                </div>
                {confirmDelete === layout.id ? (
                  <div className="blur-fade flex shrink-0 items-center gap-1.5">
                    <button
                      onClick={() => setConfirmDelete(null)}
                      className="h-7 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                    >
                      Keep
                    </button>
                    <button
                      onClick={() => void remove(layout.id)}
                      className="h-7 rounded-full bg-pane-fg px-3 text-[12.5px] font-medium text-pane hover:opacity-90"
                    >
                      Forget
                    </button>
                  </div>
                ) : (
                  <Tooltip label="Forget this layout">
                    <button
                      onClick={() => setConfirmDelete(layout.id)}
                      aria-label={`Forget the ${layout.name} layout for ${layout.sender}`}
                      className="grid size-8 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                    >
                      <Icon icon={Delete02Icon} size={15} />
                    </button>
                  </Tooltip>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-dashed border-pane-border px-4 py-3 text-[12.5px] text-pane-muted">
            None yet. After you save a signed copy, choose Remember to sign the same form from that sender in one click next time.
          </p>
        )}
      </Group>

      <SignaturePad
        open={padOpen}
        hasSignature={!!signatureId}
        onClose={() => setPadOpen(false)}
        onRemove={() => {
          setPadOpen(false);
          void onSignature(null).catch(() => onToast("Kite couldn't remove the signature. Try again."));
        }}
        onSaved={(id) => {
          setPadOpen(false);
          void onSignature(id).catch(() => onToast("Kite couldn't save the signature. Try again."));
        }}
      />
    </>
  );
}
