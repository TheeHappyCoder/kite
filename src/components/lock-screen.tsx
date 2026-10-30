"use client";

import { useState } from "react";
import { SquareLock02Icon } from "@hugeicons/core-free-icons";
import { PIN_LENGTH } from "@/lib/lock";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import { Dialog } from "./ui/dialog";
import { CodeInput } from "./ui/code-input";
import { AccentTitle } from "./ui/accent-title";

/**
 * Kite's lock: an opaque cover over the whole app until the PIN is entered. The server checks the
 * PIN (and slows down guessing). Mail stays in place underneath, so unlocking is instant.
 */
export function LockScreen({ open, onUnlock }: { open: boolean; onUnlock: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const verify = async (pin: string) => {
    try {
      const res = await fetch("/api/lock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "verify", pin }),
      });
      if (res.ok) return true;
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "That PIN didn't match.");
    } catch {
      setError("Kite couldn't check the PIN. Try again.");
    }
    return false;
  };

  return (
    <Dialog
      open={open}
      onClose={onUnlock}
      title="Kite is locked"
      cover
      bare
      className="on-sky max-h-none w-full max-w-80 justify-self-center overflow-visible rounded-none border-0 bg-transparent text-frame-fg shadow-none"
    >
      {/* Covers everything (mail, compose windows, toasts) and keeps keys from reaching the app. */}
      <div onKeyDown={(e) => e.stopPropagation()} className="flex flex-col items-center gap-4 px-4 text-center">
        <span className="grid size-12 place-items-center rounded-2xl bg-frame-hover text-frame-fg backdrop-blur-md">
          <Icon icon={SquareLock02Icon} size={22} />
        </span>
        <div>
          <h1 className="text-[22px] font-medium tracking-[-0.035em]"><AccentTitle text="Kite is locked" /></h1>
          <p className="mt-1 text-[12.5px] text-frame-muted">Enter your PIN to open your mail.</p>
        </div>
        <div className="flex h-11 items-center">
          <CodeInput
            length={PIN_LENGTH}
            mask
            autoFocus
            label="PIN"
            okLabel="Unlocked"
            onSubmit={verify}
            onDone={onUnlock}
            onType={() => setError(null)}
          />
        </div>
        <p role="status" className={cn("min-h-4 text-[12px]", error ? "text-warning" : "text-frame-muted")}>
          {error ?? ""}
        </p>
      </div>
    </Dialog>
  );
}
