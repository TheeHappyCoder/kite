"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowDown01Icon, LinkSquare02Icon, LockPasswordIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { Icon } from "./icon";
import { Switch } from "./ui/switch";
import { Spinner } from "./ui/spinner";

// Signing in with an address and an app password (IMAP: iCloud, Yahoo, Fastmail, custom domains).
// Kite finds the servers itself; the server settings only open when it couldn't, or on request.

/** What the form says for an address; `preset` "gmail" gets the app-password walkthrough (gmail-sign-in.tsx). */
export type PasswordHint = { service: string | null; passwordName: string; helpUrl: string | null; preset: string | null };

type Server = { host: string; port: string; secure: boolean };

const pill =
  "h-10 min-w-0 rounded-full border border-pane-border bg-pane-2 px-4 text-[13.5px] outline-none transition-colors placeholder:text-pane-muted focus:border-accent/60 focus:bg-pane";

function ServerRow({ label, value, onChange }: { label: string; value: Server; onChange: (value: Server) => void }) {
  return (
    <div>
      <p className="mb-1.5 px-1 text-[12px] font-medium text-pane-muted">{label}</p>
      <div className="flex items-center gap-2">
        <input
          value={value.host}
          onChange={(e) => onChange({ ...value, host: e.target.value.trim() })}
          placeholder="mail.example.com"
          aria-label={`${label} server`}
          spellCheck={false}
          className={cn(pill, "flex-1")}
        />
        <input
          value={value.port}
          onChange={(e) => onChange({ ...value, port: e.target.value.replace(/\D/g, "").slice(0, 5) })}
          inputMode="numeric"
          aria-label={`${label} port`}
          className={cn(pill, "w-[72px] shrink-0 px-3 text-center")}
        />
        <Switch value={value.secure} onChange={(secure) => onChange({ ...value, secure })} label={`${label}: TLS from the start`} size="sm" />
      </div>
    </div>
  );
}

export function PasswordSignIn({
  email,
  hint,
  onConnected,
}: {
  email: string;
  hint: PasswordHint | null;
  /** Signed in: the account is stored and syncing starts. */
  onConnected: () => void;
}) {
  const domain = email.split("@")[1] ?? "";
  const service = hint?.service ?? null;
  const passwordName = hint?.passwordName ?? "app password";
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [imap, setImap] = useState<Server>({ host: `imap.${domain}`, port: "993", secure: true });
  const [smtp, setSmtp] = useState<Server>({ host: `smtp.${domain}`, port: "465", secure: true });
  const [username, setUsername] = useState("");

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    const servers = advanced
      ? {
          imap: { host: imap.host, port: Number(imap.port) || 993, secure: imap.secure },
          smtp: { host: smtp.host, port: Number(smtp.port) || 465, secure: smtp.secure },
          ...(username.trim() ? { username: username.trim() } : {}),
        }
      : undefined;
    try {
      const res = await fetch("/api/auth/imap", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, servers, ...(name.trim() ? { name: name.trim() } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; ask?: "servers" | null };
      if (res.ok && data.ok) {
        onConnected();
        return;
      }
      setError(data.error ?? "Kite couldn't sign in. Try again.");
      if (data.ask === "servers") setAdvanced(true);
    } catch {
      setError("Kite couldn't reach its own server. Try again.");
    }
    setBusy(false);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2 className="text-[20px] font-semibold leading-tight tracking-tight">Sign in to {service ?? domain}</h2>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-pane-muted">
        {service
          ? `${service} asks mail apps like Kite for an ${passwordName}, not your normal password. Make one in your ${service} account settings and paste it here.`
          : "Enter your mail password. If your provider uses two-step sign-in, make an app password in its security settings and use that."}
      </p>
      {hint?.helpUrl ? (
        <a href={hint.helpUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-[13px] font-medium text-accent hover:opacity-80">
          How to make an {passwordName}
          <Icon icon={LinkSquare02Icon} size={14} />
        </a>
      ) : null}

      <label className="mt-5 flex h-11 items-center gap-2.5 rounded-full border border-pane-border bg-pane-2 px-4 transition-colors focus-within:border-accent/60 focus-within:bg-pane">
        <Icon icon={LockPasswordIcon} size={17} className="text-pane-muted" />
        <input
          autoFocus
          type="password"
          autoComplete="off"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
          placeholder={service ? `${service} ${passwordName}` : "Password"}
          aria-label="Password"
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-pane-muted"
        />
      </label>

      <input
        type="text"
        autoComplete="name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Your name, as people see it (optional)"
        aria-label="Your name"
        className={cn(pill, "mt-2 h-11 w-full")}
      />

      <AnimatePresence>
        {error ? (
          <motion.p {...blurFade({ y: -4 })} role="alert" className="mt-2 px-1 text-[12.5px] leading-snug text-warning">
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setAdvanced((v) => !v)}
        aria-expanded={advanced}
        className="mt-3 flex items-center gap-1.5 px-1 text-[12.5px] text-pane-muted transition-colors hover:text-pane-fg"
      >
        <Icon icon={ServerStack01Icon} size={14} />
        Server settings
        <Icon icon={ArrowDown01Icon} size={13} className={cn("transition-transform", advanced && "rotate-180")} />
      </button>
      <AnimatePresence initial={false}>
        {advanced ? (
          <motion.div {...blurFade({ y: -4 })} className="mt-3 space-y-3 rounded-2xl border border-pane-border p-3.5">
            <ServerRow label="Incoming (IMAP)" value={imap} onChange={setImap} />
            <ServerRow label="Outgoing (SMTP)" value={smtp} onChange={setSmtp} />
            <div>
              <p className="mb-1.5 px-1 text-[12px] font-medium text-pane-muted">Login name, if it isn&apos;t your address</p>
              <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder={email} aria-label="Login name" spellCheck={false} className={cn(pill, "w-full")} />
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <button
        type="submit"
        disabled={!password || busy}
        className="mt-5 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-pane-fg text-[14px] font-medium text-pane transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40"
      >
        {busy ? <Spinner size={16} /> : null}
        {busy ? "Signing in…" : "Sign in"}
      </button>
      <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-[12px] text-pane-muted">
        <Icon icon={LockPasswordIcon} size={13} />
        Kept on this computer, sealed. Only your mail server sees it.
      </p>
    </form>
  );
}
