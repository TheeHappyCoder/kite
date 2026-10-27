"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ClipboardPasteIcon, Key01Icon, LinkSquare02Icon, LockPasswordIcon, Tick01Icon } from "@hugeicons/core-free-icons";
import type { SignInAsk } from "@/lib/mail/connect";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import { Spinner } from "./ui/spinner";
import { Tooltip } from "./ui/tooltip";

// Gmail and Google Workspace over IMAP: a few short steps, each with one button that opens the exact
// Google page (2-Step Verification, then App passwords), and a field for the 16 letters, which Kite
// checks with Google right there. Errors come from imap/auth.ts (gmailRefusal) and point at a step.

const google = (path: string, email: string) => `https://myaccount.google.com/${path}?authuser=${encodeURIComponent(email)}`;

/** Google's app passwords are 16 letters, shown in groups of four. */
const lettersOf = (value: string) => value.replace(/\s+/g, "");
const isAppPassword = (value: string) => /^[a-z]{16}$/i.test(lettersOf(value));

/** Brings an error into view in a short window (the card scrolls). Stable, so it runs once per error. */
const reveal = (el: HTMLElement | null) => el?.scrollIntoView({ block: "nearest", behavior: "smooth" });

function OpenButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border border-pane-border bg-pane px-3 text-[12.5px] font-medium transition-[background-color,transform] hover:bg-pane-hover active:scale-[0.97]"
    >
      {children}
      <Icon icon={LinkSquare02Icon} size={13} className="text-pane-muted" />
    </a>
  );
}

function Step({
  n,
  title,
  detail,
  action,
  warn,
  children,
}: {
  n: number;
  title: string;
  detail?: React.ReactNode;
  action?: React.ReactNode;
  /** The step the last error points at. */
  warn?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <li
      className={cn(
        "blur-fade-up rounded-2xl border bg-pane-2 p-3.5 transition-colors",
        warn ? "border-warning/60" : "border-pane-border",
      )}
      style={{ "--i": n } as React.CSSProperties}
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
        <span
          className={cn(
            "grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold",
            warn ? "bg-warning/15 text-warning" : "bg-accent-soft text-accent",
          )}
        >
          {n}
        </span>
        <div className="min-w-0 flex-1 basis-40">
          <p className="text-[13.5px] font-medium leading-6">{title}</p>
          {detail ? <p className="mt-0.5 text-[12.5px] leading-snug text-pane-muted">{detail}</p> : null}
        </div>
        {action}
      </div>
      {children}
    </li>
  );
}

export function GmailSignIn({ email, workspace, onConnected }: { email: string; workspace: boolean; onConnected: () => void }) {
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ text: string; ask: SignInAsk | null } | null>(null);
  const letters = lettersOf(password);
  const ready = isAppPassword(password);
  // Something that can't be an app password (too long, or not only letters): most likely the normal password.
  const notOne = letters.length > 0 && (letters.length > 16 || /[^a-z]/i.test(letters));
  const service = workspace ? "Google Workspace" : "Gmail";

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/imap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password: letters, ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ask?: SignInAsk | null };
      if (res.ok && data.ok) {
        onConnected();
        return;
      }
      setError({ text: data.error ?? "Kite couldn't sign in to Gmail. Try again.", ask: data.ask ?? null });
    } catch {
      setError({ text: "Kite couldn't reach its own server. Try again.", ask: null });
    }
    setBusy(false);
  };

  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => "");
    if (!text) return;
    setPassword(text.trim());
    setError(null);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-[20px] font-semibold leading-tight tracking-tight">Connect with an app password</h2>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-pane-muted">
        {service} lets mail apps in with a 16-letter app password instead of your normal one. It takes about a minute.
      </p>

      <ol className="mt-5 space-y-2">
        <Step
          n={1}
          title="Turn on 2-Step Verification"
          detail="App passwords need it. Already on? Skip ahead."
          action={<OpenButton href={google("signinoptions/twosv", email)}>Open</OpenButton>}
        />
        <Step
          n={2}
          title="Make an app password"
          warn={error?.ask === "app_password"}
          detail={
            <>
              Name it Kite and press Create. Google shows it once.
              {workspace ? " Not available? Your admin has turned app passwords off: ask them to allow them." : " Not available? Do step 1 first."}
            </>
          }
          action={<OpenButton href={google("apppasswords", email)}>Open</OpenButton>}
        />
        <Step n={3} title="Paste it here">
          <label
            className={cn(
              "mt-3 flex h-11 items-center gap-2.5 rounded-full border bg-pane pl-4 pr-1.5 transition-colors focus-within:border-accent/60",
              notOne ? "border-warning/60" : "border-pane-border",
            )}
          >
            <Icon icon={Key01Icon} size={17} className="shrink-0 text-pane-muted" />
            <input
              autoFocus
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setError(null);
              }}
              placeholder="abcd efgh ijkl mnop"
              aria-label="App password"
              data-sensitive
              className="min-w-0 flex-1 bg-transparent tabular-nums text-[14px] tracking-wide outline-none placeholder:tracking-normal placeholder:text-pane-muted"
            />
            <span className={cn("shrink-0 text-[12px] tabular-nums", ready ? "text-success" : "text-pane-muted")} aria-live="polite">
              {ready ? <Icon icon={Tick01Icon} size={16} /> : letters.length ? `${Math.min(letters.length, 99)}/16` : null}
            </span>
            <Tooltip label="Paste">
              <button
                type="button"
                onClick={() => void paste()}
                aria-label="Paste"
                className="grid size-8 shrink-0 place-items-center rounded-full text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
              >
                <Icon icon={ClipboardPasteIcon} size={16} />
              </button>
            </Tooltip>
          </label>
          <AnimatePresence initial={false}>
            {notOne ? (
              <motion.p {...blurFade({ y: -4 })} className="mt-2 px-1 text-[12.5px] leading-snug text-warning">
                An app password is 16 letters. Your normal Google password won&apos;t work here.
              </motion.p>
            ) : null}
          </AnimatePresence>
          <input
            type="text"
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name, as people see it (optional)"
            aria-label="Your name"
            className="mt-2 h-10 w-full min-w-0 rounded-full border border-pane-border bg-pane px-4 text-[13.5px] outline-none transition-colors placeholder:text-pane-muted focus:border-accent/60"
          />
        </Step>
      </ol>

      <AnimatePresence>
        {error ? (
          <motion.div ref={reveal} {...blurFade({ y: -4 })} role="alert" className="mt-3 px-1">
            <p className="text-[12.5px] leading-snug text-warning">{error.text}</p>
            {error.ask === "imap" && !workspace ? (
              <a href="https://mail.google.com/mail/u/0/#settings/fwdandpop" target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:opacity-80">
                Open Gmail settings <Icon icon={LinkSquare02Icon} size={13} />
              </a>
            ) : null}
            {error.ask === "browser" ? (
              <a href="https://mail.google.com/" target="_blank" rel="noreferrer" className="mt-1.5 inline-flex items-center gap-1 text-[12.5px] font-medium text-accent hover:opacity-80">
                Open Gmail <Icon icon={LinkSquare02Icon} size={13} />
              </a>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>

      <button
        type="submit"
        disabled={!ready || busy}
        className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-pane-fg text-[14px] font-medium text-pane transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
      >
        {busy ? <Spinner size={16} /> : null}
        {busy ? "Checking with Google…" : error ? "Try again" : "Connect"}
      </button>
      <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[12px] text-pane-muted">
        <Icon icon={LockPasswordIcon} size={13} />
        Kept on this computer, sealed. Only Google sees it.
      </p>
    </form>
  );
}
