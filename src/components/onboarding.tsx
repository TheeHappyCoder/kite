"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  Alert02Icon,
  AppleIcon,
  ArrowLeft01Icon,
  ArrowRight01Icon,
  CheckmarkCircle02Icon,
  GoogleIcon,
  LockIcon,
  MailAtSign01Icon,
  MicrosoftIcon,
  ServerStack01Icon,
  Tick01Icon,
} from "@hugeicons/core-free-icons";
import { signInCompany, type ConnectError, type SignInVia } from "@/lib/mail/connect";
import { blurFade } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { GmxLogo, GoogleLogo, ICloudLogo, MicrosoftLogo, ZohoLogo } from "./brand-logos";
import { Icon, type IconData } from "./icon";
import { KeyCombo } from "./ui/kbd";

import { CopyIcon } from "./ui/copy";
import { GmailSignIn } from "./gmail-sign-in";
import { PasswordSignIn, type PasswordHint } from "./password-sign-in";
import { Spinner } from "./ui/spinner";

type Provider = "google" | "microsoft" | "icloud" | "yahoo" | "fastmail" | "imap";
type Detection = {
  provider: Provider;
  workspace: boolean;
  domain: string;
  supported: boolean;
  /** Set for addresses that sign in with an app password (IMAP). */
  password: PasswordHint | null;
  googleConfigured: boolean;
  microsoftConfigured: boolean;
};



export type OnboardingStart =
  | { step: "welcome" }
  /** Sign in again with a password (an IMAP account whose password stopped working). */
  | { step: "password"; email: string }
  | { step: "syncing" }
  | { step: "error"; reason: ConnectError; via: SignInVia };

type Step =
  | { step: "welcome" }
  | { step: "password"; email: string }
  | { step: "provider"; email: string; detection: Detection }
  | { step: "syncing" }
  | { step: "done"; count: number }
  | { step: "error"; reason: ConnectError; via: SignInVia };

const PROVIDERS: Record<Provider, { name: string; icon: IconData; logo?: () => React.ReactNode }> = {
  google: { name: "Google", icon: GoogleIcon, logo: () => <GoogleLogo size={20} /> },
  microsoft: { name: "Microsoft", icon: MicrosoftIcon, logo: () => <MicrosoftLogo size={18} /> },
  icloud: { name: "iCloud", icon: AppleIcon },
  yahoo: { name: "Yahoo", icon: MailAtSign01Icon },
  fastmail: { name: "Fastmail", icon: MailAtSign01Icon },
  imap: { name: "IMAP", icon: ServerStack01Icon },
};

function errorCopy(reason: ConnectError, via: SignInVia): { title: string; body: string } {
  const company = signInCompany(via);
  switch (reason) {
    case "cancelled":
      return {
        title: "No problem, nothing was connected",
        body: `You closed the ${company} window before allowing access. Kite didn't receive or store anything.`,
      };
    case "invalid_state":
      return {
        title: "That sign-in link expired",
        body: "For your security each sign-in link works once and only for 10 minutes. Start again and it will go through.",
      };
    case "failed":
      return {
        title: `${company} didn't finish the hand-off`,
        body: "The sign-in succeeded but Kite couldn't complete the connection. This is usually temporary, so try again.",
      };
    case "missing_config":
      return {
        title: `${company} sign-in is unavailable`,
        body: `Kite couldn't reach its ${company} sign-in right now. Nothing was connected. Try again in a few minutes.`,
      };
    case "admin_required":
      return {
        title: "Your organisation needs to approve Kite",
        body: "Work and school accounts let an administrator decide which apps can read mail, and Kite isn't on your organisation's list yet. Nothing was connected. Ask your IT admin to approve Kite, then try again. Personal Outlook.com and Hotmail addresses don't need this.",
      };
    case "other_provider":
      return {
        title: "This address is already connected",
        body: "Kite already reads this address through Google, so nothing changed. To switch, disconnect it in Settings → Accounts first.",
      };
  }
}

export function Onboarding({
  start,
  connected = false,
  onDismiss,
  onSync,
  onFinish,
}: {
  start: OnboardingStart | null;
  /** Accounts are already connected (adding another): leaving is "Cancel" (or Escape), not the demo. */
  connected?: boolean;
  onDismiss: () => void;
  onSync: () => Promise<number>;
  onFinish: () => void;
}) {
  const [step, setStep] = useState<Step>(start ?? { step: "welcome" });
  const [direction, setDirection] = useState(1);
  const go = (next: Step, dir = 1) => {
    setDirection(dir);
    setStep(next);
  };

  // Sync runs once when we arrive back from Google.
  const syncStarted = useRef(false);
  useEffect(() => {
    if (step.step !== "syncing" || syncStarted.current) return;
    syncStarted.current = true;
    const started = Date.now();
    onSync()
      .then(async (count) => {
        // Keep the progress visible long enough to read.
        await new Promise((r) => setTimeout(r, Math.max(0, 1200 - (Date.now() - started))));
        go({ step: "done", count });
      })
      .catch(() => go({ step: "error", reason: "failed", via: "google" }));
  }, [step, onSync]);

  // Adding another account can be called off with Escape, like any dialog.
  useEffect(() => {
    if (!connected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [connected, onDismiss]);

  if (!start || typeof document === "undefined") return null;
  const leave = connected ? "Cancel" : null;

  return createPortal(
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <motion.div
        className="absolute inset-0 bg-black/40 backdrop-blur-md"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        onClick={connected ? onDismiss : undefined}
      />
      <motion.div
        {...blurFade({ y: 12, blur: 10 })}
        className="relative flex max-h-full w-full max-w-[440px] flex-col overflow-hidden rounded-3xl border border-pane-border bg-pane text-pane-fg shadow-2xl"
      >
        {/* Scrolls inside the card on short windows, so the fade never touches the card's edge. */}
        <div className="scroll-fade min-h-0 overflow-y-auto overflow-x-hidden">
          <AnimatePresence mode="wait" initial={false} custom={direction}>
            <motion.div key={step.step} {...blurFade({ x: 16 * direction, blur: 6 })} className="p-7">
            {step.step === "welcome" ? (
              <Welcome
                onContinue={(email, detection) => go({ step: "provider", email, detection })}
                onDemo={onDismiss}
                leave={leave ?? "Explore the demo first"}
              />
            ) : null}
            {step.step === "provider" ? (
              <ProviderStep
                email={step.email}
                detection={step.detection}
                onBack={() => go({ step: "welcome" }, -1)}
                onDemo={onDismiss}
                leave={leave ?? "Explore the demo instead"}
                onConnected={() => go({ step: "syncing" })}
              />
            ) : null}
            {step.step === "password" ? <PasswordAgain email={step.email} onConnected={() => go({ step: "syncing" })} /> : null}
            {step.step === "syncing" ? <Syncing /> : null}
            {step.step === "done" ? <Done count={step.count} onFinish={onFinish} /> : null}
            {step.step === "error" ? (
              <ErrorStep reason={step.reason} via={step.via} onRetry={() => go({ step: "welcome" }, -1)} onDemo={onDismiss} leave={leave ?? "Explore the demo instead"} />
            ) : null}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </div>,
    document.body,
  );
}

function Mark({ icon = MailAtSign01Icon, tone = "accent" }: { icon?: IconData; tone?: "accent" | "success" | "warning" }) {
  return (
    <div
      className={cn(
        "mb-5 grid size-12 place-items-center rounded-2xl",
        tone === "accent" && "bg-accent-soft text-accent",
        tone === "success" && "bg-success/15 text-success",
        tone === "warning" && "bg-warning/15 text-warning",
      )}
    >
      <Icon icon={icon} size={24} />
    </div>
  );
}

function Title({ children, sub }: { children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <>
      <h2 className="text-[20px] font-semibold leading-tight tracking-tight">{children}</h2>
      {sub ? <p className="mt-1.5 text-[13.5px] leading-relaxed text-pane-muted">{sub}</p> : null}
    </>
  );
}

function PrimaryButton({
  children,
  onClick,
  disabled,
  href,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  href?: string;
}) {
  const className =
    "flex h-11 w-full items-center justify-center gap-2 rounded-full bg-pane-fg text-[14px] font-medium text-pane transition-[opacity,transform] hover:opacity-90 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-40";
  return href ? (
    <a href={href} className={className}>
      {children}
    </a>
  ) : (
    <button onClick={onClick} disabled={disabled} className={className}>
      {children}
    </button>
  );
}

function TextButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="text-[13px] text-pane-muted transition-colors hover:text-pane-fg">
      {children}
    </button>
  );
}

/** Addresses Kite signs in to, shown in turn in the empty field (and the mark above it) on the first screen. */
const SUPPORTED: { domain: string; mark: () => React.ReactNode }[] = [
  { domain: "gmail.com", mark: () => <GoogleLogo size={24} /> },
  { domain: "outlook.com", mark: () => <MicrosoftLogo size={21} /> },
  { domain: "icloud.com", mark: () => <ICloudLogo size={26} /> },
  { domain: "yahoo.com", mark: () => <Icon icon={MailAtSign01Icon} size={24} /> },
  { domain: "fastmail.com", mark: () => <Icon icon={MailAtSign01Icon} size={24} /> },
  { domain: "zoho.com", mark: () => <ZohoLogo size={28} /> },
  { domain: "aol.com", mark: () => <Icon icon={MailAtSign01Icon} size={24} /> },
  { domain: "gmx.com", mark: () => <GmxLogo size={28} /> },
];
const CYCLE_MS = 2200;

/** Steps through SUPPORTED while `active` (and the OS allows motion). */
function useCycle(active: boolean) {
  const reduced = useReducedMotion();
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (!active || reduced) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % SUPPORTED.length), CYCLE_MS);
    return () => clearInterval(timer);
  }, [active, reduced]);
  return index;
}

const swap = { initial: { opacity: 0, filter: "blur(4px)", y: 6 }, animate: { opacity: 1, filter: "blur(0px)", y: 0 }, exit: { opacity: 0, filter: "blur(4px)", y: -6 } };

function Welcome({ onContinue, onDemo, leave }: { onContinue: (email: string, detection: Detection) => void; onDemo: () => void; leave: string }) {
  const [email, setEmail] = useState("");
  const index = useCycle(!email);
  const current = SUPPORTED[index];
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

  const submit = async () => {
    if (!valid || checking) return;
    setChecking(true);
    setError(null);
    try {
      const res = await fetch(`/api/onboarding/detect?email=${encodeURIComponent(email.trim())}`);
      if (!res.ok) throw new Error();
      onContinue(email.trim(), await res.json());
    } catch {
      setError("Couldn't check that address. Check the spelling and try again.");
      setChecking(false);
    }
  };

  return (
    <div>
      {/* White in both themes, so each brand's colours read the same. */}
      <div className="relative mb-5 grid size-12 place-items-center overflow-hidden rounded-2xl bg-white text-accent shadow-[0_0_0_1px_var(--pane-border)]">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={current.domain} {...swap} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }} className="grid place-items-center">
            {current.mark()}
          </motion.span>
        </AnimatePresence>
      </div>
      <Title sub="Type your email address and Kite will work out the rest: which provider, which servers, which sign-in.">
        Let&apos;s bring your mail in
      </Title>
      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex h-11 items-center gap-2.5 rounded-full border border-pane-border bg-pane-2 px-4 transition-colors focus-within:border-accent/60 focus-within:bg-pane">
          <Icon icon={MailAtSign01Icon} size={17} className="text-pane-muted" />
          <span className="relative flex min-w-0 flex-1 items-center">
            <input
              autoFocus
              type="email"
              autoComplete="email"
              aria-label="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
            />
            {/* The placeholder steps through the addresses Kite works with. */}
            {email ? null : (
              <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 flex items-center text-[14px] text-pane-muted">
                you@
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span key={current.domain} {...swap} transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }} className="inline-block">
                    {current.domain}
                  </motion.span>
                </AnimatePresence>
              </span>
            )}
          </span>
        </label>
        <AnimatePresence>
          {error ? (
            <motion.p {...blurFade({ y: -4 })} className="mt-2 px-1 text-[12.5px] text-warning">
              {error}
            </motion.p>
          ) : null}
        </AnimatePresence>
        <div className="mt-4">
          <PrimaryButton disabled={!valid || checking}>
            {checking ? <Spinner size={16} /> : null}
            {checking ? "Checking…" : "Continue"}
            {!checking ? <Icon icon={ArrowRight01Icon} size={16} /> : null}
          </PrimaryButton>
        </div>
      </form>
      <div className="mt-5 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[12px] text-pane-muted">
          <Icon icon={LockIcon} size={13} /> Mail stays on this device
        </span>
        <TextButton onClick={onDemo}>{leave}</TextButton>
      </div>
    </div>
  );
}

/** Reconnecting a password account: the same form, with what the address needs looked up first. */
function PasswordAgain({ email, onConnected }: { email: string; onConnected: () => void }) {
  const [found, setFound] = useState<Partial<Detection> | null | undefined>(undefined);
  useEffect(() => {
    fetch(`/api/onboarding/detect?email=${encodeURIComponent(email)}`)
      .then((r) => r.json() as Promise<Partial<Detection>>)
      .then(setFound)
      .catch(() => setFound(null));
  }, [email]);
  const hint: PasswordHint | null = found?.password ?? null;
  return (
    <div>
      <Mark icon={LockIcon} />
      {found === undefined ? (
        <p className="text-[13px] text-pane-muted">Checking {email}…</p>
      ) : hint?.preset === "gmail" ? (
        <GmailSignIn email={email} workspace={!!found?.workspace} onConnected={onConnected} />
      ) : (
        <PasswordSignIn email={email} hint={hint} onConnected={onConnected} />
      )}
    </div>
  );
}

function ProviderStep({
  email,
  detection,
  onBack,
  onDemo,
  leave,
  onConnected,
}: {
  email: string;
  detection: Detection;
  onBack: () => void;
  onDemo: () => void;
  leave: string;
  onConnected: () => void;
}) {
  const provider = PROVIDERS[detection.provider];
  const microsoft = detection.provider === "microsoft";
  const via: SignInVia = microsoft ? "microsoft" : "google";
  const company = microsoft ? "Microsoft" : "Google";
  const label = detection.workspace
    ? `${detection.provider === "google" ? "Google Workspace" : "Microsoft 365"} for ${detection.domain}`
    : detection.password
      ? (detection.password.service ?? `Mail at ${detection.domain}`)
      : provider.name;

  return (
    <div>
      <BackButton onClick={onBack} />
      <div className="mb-6 flex items-center gap-3 rounded-2xl border border-pane-border bg-pane-2 p-3.5">
        <span className="grid size-10 place-items-center rounded-xl bg-pane shadow-[0_0_0_1px_var(--pane-border)]">
          {provider.logo ? provider.logo() : <Icon icon={provider.icon} size={20} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-medium">{email}</div>
          <div className="text-[12px] text-pane-muted">{label}</div>
        </div>
        <Icon icon={CheckmarkCircle02Icon} size={18} className="text-success" />
      </div>

      {detection.password?.preset === "gmail" ? (
        <>
          <GmailSignIn email={email} workspace={detection.workspace} onConnected={onConnected} />
          {/* The Gmail API is for Kite's test users only (Google lists them; no CASA for everyone else). */}
          {detection.googleConfigured ? (
            <div className="mt-3 text-center">
              <a href={`/api/auth/google?hint=${encodeURIComponent(email)}`} className="text-[12.5px] text-pane-muted transition-colors hover:text-pane-fg">
                Kite tester? Sign in with Google instead
              </a>
            </div>
          ) : null}
        </>
      ) : detection.password ? (
        <PasswordSignIn email={email} hint={detection.password} onConnected={onConnected} />
      ) : detection.supported ? (
        <>
          <Title sub={`${company} will ask you to allow Kite to read, organise and send mail for this account. Kite never sees your password.`}>
            Continue with {detection.workspace ? (microsoft ? "Microsoft 365" : "Google Workspace") : company}
          </Title>
          <ul className="mt-5 space-y-2.5 text-[13px]">
            {[
              "Read and organise your mail so it can show it here",
              "Send the replies you write in Kite",
              "Disconnect any time from Settings",
            ].map((item) => (
              <li key={item} className="flex items-start gap-2.5">
                <Icon icon={Tick01Icon} size={16} className="mt-px shrink-0 text-success" />
                <span className="text-pane-fg/85">{item}</span>
              </li>
            ))}
          </ul>
          {microsoft && detection.workspace ? (
            <p className="mt-4 text-[12px] leading-relaxed text-pane-muted">
              Work and school accounts sometimes need an administrator to approve Kite first. If Microsoft says so, nothing is
              wrong: ask your IT admin, or use a personal address.
            </p>
          ) : null}
          <div className="mt-6">
            <PrimaryButton href={`/api/auth/${via}?hint=${encodeURIComponent(email)}`}>
              <span className="grid size-6 place-items-center rounded-full bg-white">
                {microsoft ? <MicrosoftLogo size={14} /> : <GoogleLogo size={15} />}
              </span>
              Continue with {company}
            </PrimaryButton>
          </div>
          {IS_DEV && !(microsoft ? detection.microsoftConfigured : detection.googleConfigured) ? <DevNotice via={via} /> : null}
        </>
      ) : (
        <>
          <Title sub={`Kite connects Google and Microsoft accounts today. ${provider.name} support is being built next, and you'll be able to add this address the moment it lands.`}>
            {provider.name} is almost here
          </Title>
          <div className="mt-6 space-y-2">
            <PrimaryButton onClick={onBack}>Use a different address</PrimaryButton>
          </div>
        </>
      )}
      <div className="mt-4 text-center">
        <TextButton onClick={onDemo}>{leave}</TextButton>
      </div>
    </div>
  );
}

/** Development builds only: release builds ship with Kite's own Google OAuth client. */
const IS_DEV = process.env.NODE_ENV !== "production";

function DevNotice({ via }: { via: SignInVia }) {
  const redirect = typeof window !== "undefined" ? `${window.location.origin}/api/auth/${via}/callback` : "";
  return (
    <div className="mt-4 rounded-xl border border-dashed border-warning/50 bg-warning/5 p-3 text-[12px] leading-relaxed text-pane-muted">
      <span className="mr-1.5 rounded bg-warning/15 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-warning">Dev</span>
      {via === "microsoft" ? (
        <>
          The Microsoft app id isn&apos;t in <code>.env.local</code> yet, so this button won&apos;t work. Add{" "}
          <code>MICROSOFT_CLIENT_ID</code> (public client, no secret), register this redirect URI under &quot;Mobile and
          desktop&quot; and restart. Users never see this.
        </>
      ) : (
        <>
          Google keys aren&apos;t in <code>.env.local</code> yet, so this button won&apos;t work. Add{" "}
          <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, enable the Gmail API, register this redirect
          URI and restart. Users never see this.
        </>
      )}
      <CopyField value={redirect} />
    </div>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(value).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        });
      }}
      className="mt-1.5 flex w-full items-center gap-2 rounded-lg border border-pane-border bg-pane-2 px-2.5 py-1.5 text-left tabular-nums text-[11.5px] hover:border-pane-muted/50"
    >
      <span className="min-w-0 flex-1 truncate">{value}</span>
      <CopyIcon copied={copied} className="text-pane-muted" />
    </button>
  );
}

function Syncing() {
  const lines = ["Connecting securely", "Fetching your latest conversations", "Sorting into Important, Other and more"];
  const [visible, setVisible] = useState(1);
  useEffect(() => {
    const t = setInterval(() => setVisible((v) => Math.min(lines.length, v + 1)), 700);
    return () => clearInterval(t);
  }, [lines.length]);
  return (
    <div>
      <div className="mb-5 grid size-12 place-items-center rounded-2xl bg-accent-soft">
        <Spinner size={20} className="text-accent" />
      </div>
      <Title>Setting up your inbox</Title>
      <ul className="mt-5 space-y-2.5">
        {lines.slice(0, visible).map((line, i) => (
          <li key={line} className="blur-fade-left flex items-center gap-2.5 text-[13px]" style={{ "--i": 0 } as React.CSSProperties}>
            {i < visible - 1 ? (
              <Icon icon={Tick01Icon} size={16} className="text-success" />
            ) : (
              <span className="grid size-4 place-items-center">
                <span className="size-1.5 animate-pulse rounded-full bg-accent" />
              </span>
            )}
            <span className={i < visible - 1 ? "text-pane-muted" : undefined}>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Done({ count, onFinish }: { count: number; onFinish: () => void }) {
  const tips: { combos: string[]; text: string }[] = [
    { combos: ["j", "k"], text: "Move through your mail" },
    { combos: ["e"], text: "Archive" },
    { combos: ["z"], text: "Undo anything" },
    { combos: ["mod+k"], text: "Find any action or mailbox" },
    { combos: ["?"], text: "See every shortcut, all editable" },
  ];
  return (
    <div>
      <Mark icon={CheckmarkCircle02Icon} tone="success" />
      <Title sub={count ? `${count} conversations are ready. A few keys worth knowing:` : "Your mail is coming in now. A few keys worth knowing:"}>
        You&apos;re all set
      </Title>
      <ul className="mt-5 space-y-2">
        {tips.map((tip, i) => (
          <li key={tip.text} className="blur-fade-up flex items-center gap-3 text-[13px]" style={{ "--i": i + 1, "--blur-fade-step": "70ms" } as React.CSSProperties}>
            {/* A fixed key column, so every line's text starts in the same place. */}
            <span className="flex w-16 shrink-0 items-center gap-1">
              {tip.combos.map((combo) => (
                <KeyCombo key={combo} combo={combo} keyClassName="h-6 min-w-6 bg-pane-2 text-[11.5px] shadow-[0_0_0_1px_var(--pane-border)]" />
              ))}
            </span>
            <span className="min-w-0 text-pane-fg/85">{tip.text}</span>
          </li>
        ))}
      </ul>
      <div className="mt-7">
        <PrimaryButton onClick={onFinish}>
          Open my inbox <Icon icon={ArrowRight01Icon} size={16} />
        </PrimaryButton>
      </div>
    </div>
  );
}

function ErrorStep({
  reason,
  via,
  onRetry,
  onDemo,
  leave,
}: {
  reason: ConnectError;
  via: SignInVia;
  onRetry: () => void;
  onDemo: () => void;
  leave: string;
}) {
  const copy = errorCopy(reason, via);
  return (
    <div>
      <Mark icon={Alert02Icon} tone={reason === "cancelled" ? "accent" : "warning"} />
      <Title sub={copy.body}>{copy.title}</Title>
      <div className="mt-6">
        <PrimaryButton onClick={onRetry}>Try again</PrimaryButton>
      </div>
      {IS_DEV && reason === "missing_config" ? <DevNotice via={via} /> : null}
      <div className="mt-4 text-center">
        <TextButton onClick={onDemo}>{leave}</TextButton>
      </div>
    </div>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Back"
      className="-ml-1.5 mb-4 grid size-8 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
    >
      <Icon icon={ArrowLeft01Icon} size={17} />
    </button>
  );
}
