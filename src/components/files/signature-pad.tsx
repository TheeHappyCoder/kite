"use client";

import { useEffect, useRef, useState } from "react";
import { Upload04Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { uploadAsset } from "../design/assets";
import { Segmented } from "../design/block-editor";
import { Icon } from "../icon";
import { Dialog } from "../ui/dialog";
import { Spinner } from "../ui/spinner";

// Draw or upload a signature once. It's trimmed to its ink, saved as a private image in
// data/assets and reused by every Fill & sign until it's changed.

const INK = "#14161f";
const MAX_WIDTH = 1000;

type Mode = "draw" | "upload";

export function SignaturePad({
  open,
  hasSignature,
  onClose,
  onSaved,
  onRemove,
}: {
  open: boolean;
  hasSignature: boolean;
  onClose: () => void;
  onSaved: (assetId: string) => void;
  onRemove: () => void;
}) {
  const [mode, setMode] = useState<Mode>("draw");
  const [empty, setEmpty] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);

  const reset = () => {
    const canvas = canvasRef.current;
    canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    setEmpty(true);
    setError(null);
  };

  // Size the drawing surface to its box at device resolution.
  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frame = requestAnimationFrame(() => {
      const box = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.round(box.width * ratio);
      canvas.height = Math.round(box.height * ratio);
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    const ratio = e.currentTarget.width / box.width;
    return {
      x: (e.clientX - box.left) * ratio,
      y: (e.clientY - box.top) * ratio,
    };
  };

  const stroke = (from: { x: number; y: number }, to: { x: number; y: number }, pressure: number) => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const ratio = window.devicePixelRatio || 1;
    ctx.strokeStyle = INK;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.lineWidth = (1.6 + (pressure || 0.5) * 1.8) * ratio;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  };

  const loadImage = (file: File) => {
    setError(null);
    if (!file.type.startsWith("image/")) {
      setError("Use a picture of your signature (PNG or JPG).");
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d", { willReadFrequently: true });
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
      const w = img.naturalWidth * scale;
      const h = img.naturalHeight * scale;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
      // Paper turns transparent, so a photo of a signature on white sits cleanly on the form.
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const px = data.data;
      for (let i = 0; i < px.length; i += 4) {
        const light = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
        if (light > 190) px[i + 3] = 0;
        else if (light > 150) px[i + 3] = Math.round(px[i + 3] * ((190 - light) / 40));
      }
      ctx.putImageData(data, 0, 0);
      setEmpty(false);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      setError("Kite couldn't read that picture. Try a PNG or JPG.");
    };
    img.src = url;
  };

  const save = async () => {
    const canvas = canvasRef.current;
    if (!canvas || empty) return;
    setSaving(true);
    setError(null);
    try {
      const trimmed = trim(canvas);
      if (!trimmed) throw new Error("Draw your signature first.");
      const blob = await new Promise<Blob | null>((resolve) => trimmed.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("Kite couldn't save that signature. Try again.");
      const asset = await uploadAsset(new File([blob], "signature.png", { type: "image/png" }), { private: true });
      onSaved(asset.id);
      reset();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kite couldn't save that signature. Try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={hasSignature ? "Change your signature" : "Your signature"}
      description="Saved on this computer only and reused each time you sign."
      className="w-[min(600px,calc(100vw-32px))]"
      footer={
        <>
          {hasSignature ? (
            <button onClick={onRemove} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
              Remove saved signature
            </button>
          ) : null}
          <button onClick={onClose} className="ml-auto h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
            Cancel
          </button>
          <button
            onClick={() => void save()}
            disabled={empty || saving}
            className="flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Spinner /> : null}
            {saving ? "Saving…" : "Use this signature"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 px-5 pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Segmented<Mode>
            value={mode}
            options={[
              ["draw", "Draw"],
              ["upload", "Upload"],
            ]}
            onChange={(m) => {
              setMode(m);
              reset();
            }}
          />
          {!empty ? (
            <button onClick={reset} className="ml-auto h-7 rounded-full px-3 text-[12px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
              Clear
            </button>
          ) : null}
        </div>
        <div className="relative h-[180px] overflow-hidden rounded-xl border border-pane-border bg-white">
          <canvas
            ref={canvasRef}
            className={cn("size-full touch-none", mode === "draw" ? "cursor-crosshair" : "")}
            onPointerDown={(e) => {
              if (mode !== "draw") return;
              e.currentTarget.setPointerCapture(e.pointerId);
              last.current = point(e);
              stroke(last.current, { x: last.current.x + 0.1, y: last.current.y }, e.pressure);
              setEmpty(false);
            }}
            onPointerMove={(e) => {
              if (mode !== "draw" || !last.current) return;
              const next = point(e);
              stroke(last.current, next, e.pressure);
              last.current = next;
            }}
            onPointerUp={() => (last.current = null)}
            onPointerCancel={() => (last.current = null)}
          />
          {empty ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-[12.5px] text-neutral-400">
              {mode === "draw" ? (
                "Sign here with your mouse, pen or finger"
              ) : (
                <button
                  onClick={() => fileRef.current?.click()}
                  className="pointer-events-auto flex h-8 items-center gap-1.5 rounded-full border border-neutral-300 px-3 text-neutral-600 hover:bg-neutral-100"
                >
                  <Icon icon={Upload04Icon} size={14} /> Choose a picture of your signature
                </button>
              )}
            </div>
          ) : null}
          <div className="pointer-events-none absolute inset-x-8 bottom-10 border-b border-dashed border-neutral-300" />
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) loadImage(file);
          }}
        />
        {error ? <p className="text-[12.5px] text-warning">{error}</p> : null}
      </div>
    </Dialog>
  );
}

/** The signature's ink with a little margin, scaled down to a sensible size. */
function trim(canvas: HTMLCanvasElement) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const { width, height } = canvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  let top = height,
    left = width,
    right = -1,
    bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (px[(y * width + x) * 4 + 3] > 16) {
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (right < 0) return null;
  const pad = 6;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  const w = Math.min(width, right + pad) - left;
  const h = Math.min(height, bottom + pad) - top;
  const scale = Math.min(1, MAX_WIDTH / w);
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(w * scale));
  out.height = Math.max(1, Math.round(h * scale));
  out.getContext("2d")?.drawImage(canvas, left, top, w, h, 0, 0, out.width, out.height);
  return out;
}
