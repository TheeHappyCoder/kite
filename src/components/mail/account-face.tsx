"use client";

import { useEffect, useRef, useState } from "react";
import type { Account } from "@/lib/mail/types";
import { accountName } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { GoogleLogo, MicrosoftLogo } from "../brand-logos";
import { Spinner } from "../ui/spinner";
import { Avatar } from "./avatar";

/** The colour ring's width, outside the face (the spinner's stroke while syncing). */
const RING = 1.5;

const PROVIDER_MARK: Partial<Record<Account["provider"], (size: number) => React.ReactNode>> = {
  gmail: (size) => <GoogleLogo size={size} />,
  outlook: (size) => <MicrosoftLogo size={size - 1} />,
};

/**
 * An account's picture in its colour ring, with its provider's mark in the corner (Google, Microsoft),
 * so two accounts with the same name still tell apart. `tone`: what it sits on (the dark frame or a pane).
 * `syncing`: the ring itself becomes the spinner (a faint track with an arc running round it), drawn
 * at the face's measured size so it sits exactly where the ring was.
 */
export function AccountFace({
  account,
  tone = "pane",
  syncing,
  marked = true,
  className,
}: {
  account: Account;
  tone?: "frame" | "pane";
  syncing?: boolean;
  /** The provider's mark in the corner; off where the face is small and the ring is enough (the sidebar rail). */
  marked?: boolean;
  className?: string;
}) {
  // Gmail over IMAP is still Gmail: the mark follows the service, not the protocol.
  const mark = marked ? PROVIDER_MARK[account.organisesLike ?? account.provider] : undefined;
  const ref = useRef<HTMLSpanElement>(null);
  const [box, setBox] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!syncing || !el) return;
    const observer = new ResizeObserver(() => setBox(el.offsetWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncing]);
  return (
    // Block-level (flex), so the colour ring draws around the avatar instead of along an inline box.
    <span
      ref={ref}
      className={cn("relative flex shrink-0 rounded-full p-px", tone === "frame" && "bg-white")}
      style={syncing && box ? undefined : { boxShadow: `0 0 0 ${RING}px ${account.color}` }}
    >
      {syncing && box ? (
        <Spinner size={box + RING * 2} stroke={RING} className="pointer-events-none absolute" style={{ left: -RING, top: -RING, color: account.color }} />
      ) : null}
      <Avatar name={accountName(account)} email={account.email} src={account.photo ?? null} className={cn("size-7 text-[10px]", className)} />
      {mark ? (
        <span
          className={cn(
            "absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full",
            tone === "frame" ? "bg-frame-active shadow-[0_0_0_1.5px_var(--frame)]" : "bg-pane-raised shadow-[0_0_0_1px_var(--pane-border)]",
          )}
        >
          {mark(10)}
        </span>
      ) : null}
    </span>
  );
}
