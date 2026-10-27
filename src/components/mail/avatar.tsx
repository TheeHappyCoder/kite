"use client";

import { useState } from "react";
import { avatarHue, cn, initials } from "@/lib/utils";

/** Remembers misses for this page load so rows don't keep re-requesting them. */
const missing = new Set<string>();

/** `src` overrides the looked-up picture (e.g. an account's cached profile photo); null means initials only. */
export function Avatar({ name, email, src, className }: { name: string; email?: string; src?: string | null; className?: string }) {
  const url = src === undefined ? (email ? `/api/avatar?email=${encodeURIComponent(email)}` : null) : src;
  // Keyed by the picture so a new one (e.g. a photo that just arrived) loads from scratch.
  return <AvatarFace key={url ?? ""} name={name} url={url} className={className} />;
}

function AvatarFace({ name, url, className }: { name: string; url: string | null; className?: string }) {
  const hue = avatarHue(name);
  const [status, setStatus] = useState<"loading" | "loaded" | "missing">(() =>
    !url || missing.has(url) ? "missing" : "loading",
  );

  return (
    <div
      aria-hidden
      className={cn(
        "relative grid size-8 shrink-0 place-items-center overflow-hidden rounded-full text-[11px] font-semibold tracking-wide",
        className,
      )}
      style={{ background: `hsl(${hue} 70% 55% / 0.16)`, color: `hsl(${hue} 65% 52%)` }}
    >
      {initials(name)}
      {url && status !== "missing" ? (
        // eslint-disable-next-line @next/next/no-img-element -- served by Kite's own cached avatar route
        <img
          src={url}
          alt=""
          loading="lazy"
          onLoad={() => setStatus("loaded")}
          onError={() => {
            missing.add(url);
            setStatus("missing");
          }}
          className={cn(
            "absolute inset-0 size-full bg-white object-cover",
            status === "loaded" ? "blur-fade" : "opacity-0",
          )}
          style={{ "--blur-fade-duration": "260ms" } as React.CSSProperties}
        />
      ) : null}
    </div>
  );
}
