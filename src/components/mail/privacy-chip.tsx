"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Alert02Icon,
  CheckmarkBadge01Icon,
  Image01Icon,
  ImageNotFound01Icon,
  Link01Icon,
  SecurityWarningIcon,
  Settings02Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import type { Message } from "@/lib/mail/types";
import { describeTrackers, protectLinks } from "@/lib/mail/privacy";
import type { Preferences } from "@/lib/settings";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { plural } from "@/lib/format";

/** What the reader needs to protect a message: the user's privacy settings and per-sender image choices. */
export type PrivacyPolicy = Pick<Preferences["privacy"], "images" | "cleanLinks"> & {
  /** The user chose to always load images from this address. */
  imagesFrom: (email: string) => boolean;
  setImagesFrom: (email: string, on: boolean) => void;
  openSettings: () => void;
};

export const PrivacyContext = createContext<PrivacyPolicy>({
  images: "ask",
  cleanLinks: true,
  imagesFrom: () => false,
  setImagesFrom: () => {},
  openSettings: () => {},
});

const usePrivacy = () => useContext(PrivacyContext);

/**
 * One message's protection: whether its images load, the cleaned-link count, and what was stripped.
 * `loadOnce` loads this message's images without remembering anything.
 */
export function useMessagePrivacy(message: Message) {
  const policy = usePrivacy();
  const [once, setOnce] = useState(false);
  const trackers = useMemo(() => describeTrackers(message.trackersBlocked), [message.trackersBlocked]);
  const links = useMemo(() => (message.html ? protectLinks(message.html, policy.cleanLinks) : { cleaned: 0, misleading: 0 }), [policy.cleanLinks, message.html]);
  const sender = message.from.email;
  const why: "never" | "all" | "sender" | "once" | "hidden" =
    policy.images === "never" ? "never" : policy.images === "always" ? "all" : policy.imagesFrom(sender) ? "sender" : once ? "once" : "hidden";
  return {
    policy,
    trackers,
    linksCleaned: links.cleaned,
    /** Links whose text names one site but go to another. */
    misleading: links.misleading,
    /** The sender's domain vouched for it (pass), didn't (fail: likely forged), or no verdict. */
    auth: message.auth?.result ?? "none",
    authDomain: message.auth?.domain,
    remoteImages: !!message.remoteImages,
    loadRemote: why === "all" || why === "sender" || why === "once",
    why,
    loadOnce: () => setOnce(true),
  };
}

/** Cleans links in an HTML slice (when the setting is on) and flags misleading ones. */
export function useCleanHtml(html: string) {
  const { cleanLinks: on } = usePrivacy();
  return useMemo(() => protectLinks(html, on).html, [on, html]);
}


/**
 * The quiet privacy chip in a message header: a shield with how much Kite stopped, coloured only
 * when there's a choice to make (images waiting). Opens a small popover that says what and why.
 */
export function PrivacyChip({ message, state }: { message: Message; state: ReturnType<typeof useMessagePrivacy> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const { trackers, linksCleaned, misleading, auth, authDomain, remoteImages, why, policy } = state;
  const stopped = trackers.total + linksCleaned;
  const waiting = remoteImages && why === "hidden";
  // Warnings outrank everything: a forged sender or links that lie about where they go.
  const warn = auth === "fail" || misleading > 0;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [open]);

  if (!stopped && !remoteImages && !warn) return null;

  const summary = [
    auth === "fail" ? "sender not verified" : "",
    misleading ? `${plural(misleading, "misleading link")}` : "",
    trackers.total ? `${plural(trackers.total, "tracker")} stopped` : "",
    linksCleaned ? `${plural(linksCleaned, "link")} cleaned` : "",
    remoteImages && !state.loadRemote ? "images off" : "",
  ]
    .filter(Boolean)
    .join(" · ");
  const name = message.from.name || message.from.email;

  return (
    <div ref={root} className="relative shrink-0">
      <Tooltip label={summary ? summary[0].toUpperCase() + summary.slice(1) : "Privacy"} side="bottom">
        <button
          aria-label="Privacy"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "flex h-7 items-center gap-1 rounded-full px-2 text-[12px] font-medium tabular-nums transition-colors",
            warn
              ? "bg-warning/15 text-warning hover:opacity-85"
              : waiting
                ? "bg-accent-soft text-accent hover:opacity-85"
                : "text-pane-muted hover:bg-pane-hover hover:text-pane-fg",
            open && !waiting && !warn && "bg-pane-hover text-pane-fg",
          )}
        >
          <Icon icon={warn ? SecurityWarningIcon : Shield01Icon} size={14} />
          {stopped ? <span>{stopped}</span> : null}
          {waiting ? <Icon icon={ImageNotFound01Icon} size={14} className="ml-0.5" /> : null}
        </button>
      </Tooltip>

      <AnimatePresence>
        {open ? (
          <motion.div
            {...blurFade({ y: -4, blur: 4 })}
            role="dialog"
            aria-label="Privacy for this message"
            className="absolute right-0 top-9 z-20 w-80 max-w-[calc(100vw-32px)] rounded-2xl border border-pane-border bg-pane-raised p-1.5 text-[12.5px] shadow-2xl"
          >
            {auth === "fail" ? (
              <Row icon={SecurityWarningIcon} tone="warning" title="Sender not verified">
                {`${authDomain ?? "The sender's domain"} didn't confirm it sent this. It may be forged: be careful with links, files and requests for money or passwords.`}
              </Row>
            ) : auth === "pass" ? (
              <Row icon={CheckmarkBadge01Icon} title="Verified sender">
                {authDomain} confirmed it sent this
              </Row>
            ) : null}

            {misleading ? (
              <Row icon={Alert02Icon} tone="warning" title={plural(misleading, "misleading link")}>
                The text names one site but the link goes to another. Hover it in the email to see where.
              </Row>
            ) : null}

            <Row icon={Shield01Icon} title={trackers.total ? `${plural(trackers.total, "tracker")} removed` : "No trackers found"}>
              {trackers.total ? (
                <>
                  {trackers.named.join(", ")}
                  {trackers.unknown.length ? (
                    <span title={trackers.unknown.join(", ")} className="underline decoration-dotted underline-offset-2">
                      {trackers.named.length ? ", " : ""}
                      {trackers.unknown.length === 1 ? (trackers.named.length ? "an unknown one" : "An unknown service") : `${trackers.unknown.length} unknown`}
                    </span>
                  ) : null}
                  {" · "}they report when you open mail
                </>
              ) : (
                "Nothing here reports when you open it"
              )}
            </Row>

            {linksCleaned ? (
              <Row icon={Link01Icon} title={`${plural(linksCleaned, "link")} cleaned`}>
                Tracking removed from the address
              </Row>
            ) : null}

            {remoteImages ? (
              <Row
                icon={state.loadRemote ? Image01Icon : ImageNotFound01Icon}
                title={state.loadRemote ? "Images on" : "Images off"}
                tone={waiting ? "accent" : undefined}
                actions={
                  why === "hidden" ? (
                    <>
                      <PopButton
                        onClick={() => {
                          state.loadOnce();
                          setOpen(false);
                        }}
                      >
                        Load once
                      </PopButton>
                      <PopButton
                        primary
                        onClick={() => {
                          policy.setImagesFrom(message.from.email, true);
                          setOpen(false);
                        }}
                      >
                        Always for {name.length > 18 ? "this sender" : name}
                      </PopButton>
                    </>
                  ) : why === "sender" ? (
                    <PopButton onClick={() => policy.setImagesFrom(message.from.email, false)}>Stop</PopButton>
                  ) : why === "never" ? (
                    <PopButton onClick={policy.openSettings}>Settings</PopButton>
                  ) : null
                }
              >
                {why === "hidden"
                  ? "Loading them tells the sender you opened this"
                  : why === "never"
                    ? "Off for all mail in Settings"
                    : why === "sender"
                      ? `Always on for ${name}`
                      : why === "all"
                        ? "On for all mail in Settings"
                        : "Loaded for this message"}
              </Row>
            ) : null}

            <button
              onClick={() => {
                setOpen(false);
                policy.openSettings();
              }}
              className="mt-0.5 flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={Settings02Icon} size={13} />
              Privacy settings
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function Row({
  icon,
  title,
  tone,
  actions,
  children,
}: {
  icon: typeof Shield01Icon;
  title: string;
  tone?: "accent" | "warning";
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-2.5 rounded-xl px-2.5 py-2">
      <Icon icon={icon} size={15} className={cn("mt-0.5 shrink-0", tone === "accent" ? "text-accent" : tone === "warning" ? "text-warning" : "text-pane-muted")} />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-pane-fg">{title}</div>
        <div className="mt-0.5 leading-snug text-pane-muted">{children}</div>
        {actions ? <div className="mt-2 flex flex-wrap gap-1.5">{actions}</div> : null}
      </div>
    </div>
  );
}

function PopButton({ primary, onClick, children }: { primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "h-7 max-w-full truncate rounded-full px-3 text-[12px] font-medium transition-colors",
        primary ? "bg-pane-fg text-pane hover:opacity-85" : "border border-pane-border text-pane-fg hover:bg-pane-hover",
      )}
    >
      {children}
    </button>
  );
}
