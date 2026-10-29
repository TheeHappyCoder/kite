"use client";

import { useRef, useState } from "react";
import { motion } from "motion/react";
import { ShuffleIcon, Tick02Icon, Upload01Icon } from "@hugeicons/core-free-icons";
import { ACCOUNT_COLORS, COLOR_NAMES, facePhoto, gradientAvatar, gradientSeeds, type AccountFaceChoice } from "@/lib/mail/account-face";
import { accountName, type Account } from "@/lib/mail/types";
import { serviceName } from "@/lib/mail/providers";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { squareImage, uploadAsset } from "../design/assets";
import { Icon } from "../icon";
import { Avatar } from "../mail/avatar";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";



const tileClass = "relative grid size-8 shrink-0 place-items-center rounded-full outline-offset-2 transition-[outline-color] duration-150";

/**
 * Settings → Accounts: the account's ring colour and its picture (the provider's photo, initials,
 * a generated gradient, or an image of your own, kept on this computer).
 */
export function AccountLook({
  account,
  demo,
  onChange,
  onError,
}: {
  account: Account;
  demo: boolean;
  onChange: (patch: Partial<Account>) => void;
  onError: (message: string) => void;
}) {
  const [page, setPage] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const face = account.face ?? null;
  const name = accountName(account);

  const save = async (patch: { color?: string; face?: AccountFaceChoice }) => {
    const before: Partial<Account> = { color: account.color, face: account.face ?? null, photo: account.photo ?? null };
    // Shown at once; the server's answer settles the picture (an upload's address, the provider's photo).
    onChange({ ...patch, ...(patch.face !== undefined ? { photo: facePhoto(patch.face, account.providerPhoto ?? null) } : {}) });
    if (demo) return;
    try {
      const res = await fetch("/api/accounts", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: account.id, ...patch }) });
      const data = (await res.json().catch(() => ({}))) as { error?: string; color?: string; face?: string | null; photo?: string | null };
      if (!res.ok) throw new Error(data.error);
      onChange({ color: data.color, face: data.face, photo: data.photo });
    } catch (error) {
      onChange(before);
      onError(error instanceof Error && error.message ? error.message : "Couldn't change the account. Try again.");
    }
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const asset = await uploadAsset(await squareImage(file, "account.webp"), { private: true });
      await save({ face: `asset:${asset.id}` });
    } catch (error) {
      onError(error instanceof Error ? error.message : "The upload didn't go through. Try again.");
    } finally {
      setUploading(false);
    }
  };

  const picked = (choice: AccountFaceChoice) => (choice === face ? { outline: `2px solid ${account.color}` } : { outline: "2px solid transparent" });
  const seeds = gradientSeeds(account.email, page);

  return (
    <motion.div {...blurFade({ y: -4 })} className="flex flex-col gap-3 rounded-lg bg-pane-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-14 shrink-0 text-[12px] text-pane-muted">Colour</span>
        <div className="flex min-w-0 flex-wrap gap-1.5">
          {ACCOUNT_COLORS.map((color) => {
            const on = color === account.color;
            return (
              <Tooltip key={color} label={COLOR_NAMES[color]}>
                <button
                  aria-label={`${COLOR_NAMES[color]} ring`}
                  aria-pressed={on}
                  onClick={() => (on ? undefined : void save({ color }))}
                  className="grid size-6 place-items-center rounded-full transition-transform duration-150 hover:scale-110"
                  style={{ background: color }}
                >
                  {on ? <Icon icon={Tick02Icon} size={12} className="blur-fade text-white drop-shadow" /> : null}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="w-14 shrink-0 text-[12px] text-pane-muted">Picture</span>
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Tooltip label={account.providerPhoto ? `Photo from ${serviceName(account)}` : "Initials"}>
            <button aria-label="Use the default picture" onClick={() => void save({ face: null })} className={tileClass} style={picked(null)}>
              <Avatar name={name} src={account.providerPhoto ?? null} className="size-8 text-[11px]" />
            </button>
          </Tooltip>
          {account.providerPhoto ? (
            <Tooltip label="Initials">
              <button aria-label="Use initials" onClick={() => void save({ face: "initials" })} className={tileClass} style={picked("initials")}>
                <Avatar name={name} src={null} className="size-8 text-[11px]" />
              </button>
            </Tooltip>
          ) : null}
          {face?.startsWith("asset:") ? (
            <Tooltip label="Your picture">
              <span className={tileClass} style={picked(face)}>
                <Avatar name={name} src={account.photo ?? null} className="size-8 text-[11px]" />
              </span>
            </Tooltip>
          ) : null}
          {seeds.map((seed, i) => {
            const choice = `gradient:${seed}` as const;
            return (
              <Tooltip key={seed} label="Gradient">
                <button
                  aria-label={`Gradient ${i + 1}`}
                  onClick={() => void save({ face: choice })}
                  className={cn(tileClass, "blur-fade")}
                  style={{ ...picked(choice), "--i": i } as React.CSSProperties}
                >
                  <Avatar name={name} src={gradientAvatar(seed)} className="size-8" />
                </button>
              </Tooltip>
            );
          })}
          <Tooltip label="More gradients">
            <button aria-label="More gradients" onClick={() => setPage((p) => p + 1)} className="grid size-8 place-items-center rounded-full border border-pane-border text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg">
              <Icon icon={ShuffleIcon} size={14} />
            </button>
          </Tooltip>
          <Tooltip label={demo ? "Upload (not in the demo)" : "Upload a picture"}>
            <button
              aria-label="Upload a picture"
              disabled={demo || uploading}
              onClick={() => fileRef.current?.click()}
              className="grid size-8 place-items-center rounded-full border border-pane-border text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg disabled:opacity-40"
            >
              {uploading ? <Spinner size={13} /> : <Icon icon={Upload01Icon} size={14} />}
            </button>
          </Tooltip>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) void upload(file);
            }}
          />
        </div>
      </div>
      <p className="text-[11.5px] text-pane-muted">Only in Kite, on this computer. {serviceName(account)} keeps its own picture.</p>
    </motion.div>
  );
}
