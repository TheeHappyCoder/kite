"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { formatDistanceToNow } from "date-fns";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { accountName, type Account } from "@/lib/mail/types";
import { blurFade } from "@/lib/motion";
import { type StorageInfo } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { AccountFace } from "../mail/account-face";
import { AccountLook } from "./account-look";
import { signInCompany } from "@/lib/mail/connect";
import { accountSpec, permissionHref, serviceName } from "@/lib/mail/providers";
import { Tooltip } from "../ui/tooltip";
import { Confirm, Note, ToggleRow, buttonClass } from "./settings-ui";
import { Spinner } from "../ui/spinner";
import { syncCount, useAccountSync } from "../mail/first-sync";
import { request } from "./settings-ui";

/**
 * "Reconnect" links for accounts whose sign-in is missing a permission, under a short why. Gmail over
 * IMAP gets "Connect Google" instead: its optional Google sign-in asks for it.
 */
function ReconnectNote({ why, accounts }: { why: string; accounts: Account[] }) {
  return (
    <AnimatePresence initial={false}>
      {accounts.length ? (
        <motion.div {...blurFade({ y: -4 })}>
          <Note>
            {why}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {accounts.map((account) => {
                const verb = account.googleLink !== undefined ? "Connect Google" : "Reconnect";
                return (
                  <a key={account.id} href={permissionHref(account)} className={cn(buttonClass, "border-accent/50 text-accent")}>
                    {accounts.length === 1 ? verb : `${verb} for ${accountName(account)}`}
                  </a>
                );
              })}
            </div>
          </Note>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function SenderPhotos({ value, accounts, onChange }: { value: boolean; accounts: Account[]; onChange: (value: boolean) => void }) {
  // Accounts whose sign-in doesn't include contacts yet. Until they reconnect, Kite uses the other sources.
  const missing = value ? accounts.filter((a) => a.contactPhotos === false) : [];
  return (
    <ToggleRow
      label="Photos from Google contacts"
      detail={value ? "Kite asks Google only about senders you see, and keeps the photos here." : "Show the photo from your Google contacts next to people who email you."}
      value={value}
      onChange={onChange}
    >
      <ReconnectNote
        why="Google needs your permission first: tick the contacts boxes when it asks. Until then Kite uses logos and Gravatar."
        accounts={missing}
      />
    </ToggleRow>
  );
}

export function CalendarAccess({ value, accounts, onChange }: { value: boolean; accounts: Account[]; onChange: (value: boolean) => void }) {
  // Accounts whose sign-in doesn't include the calendar yet. Until they reconnect, invite cards ask first.
  const missing = value ? accounts.filter((a) => a.calendar === false) : [];
  return (
    <ToggleRow
      label="Use your calendar"
      detail={
        value
          ? "Events show in Today and Calendar; invite answers and Add to calendar go to your calendar. Kite never answers or adds by itself."
          : "Show your events, answer invites in your calendar and add events from mail."
      }
      value={value}
      onChange={onChange}
    >
      <ReconnectNote
        why="Allow calendar access first. Until then Today has no events for these accounts."
        accounts={missing}
      />
      <MailCalendarNote accounts={accounts.filter((a) => a.mailCalendar)} />
    </ToggleRow>
  );
}

/** Accounts without a calendar Kite can reach get Kite's mail calendar: say plainly what it can and can't do. */
function MailCalendarNote({ accounts }: { accounts: Account[] }) {
  if (!accounts.length) return null;
  return (
    <Note>
      {accounts.map(accountName).join(", ")} {accounts.length === 1 ? "has" : "have"} no calendar Kite can reach, so Kite builds one from the invites in
      your mail: ones you answered Yes or Maybe, and ones you haven&rsquo;t answered yet. It can&rsquo;t see events that never came by email, and events you
      add stay in Kite, not on your phone.
      {accounts.some((a) => a.googleLink === false) ? " For Gmail, Connect Google on the account above to use Google Calendar instead." : null}
    </Note>
  );
}

export function AccountRow({
  account,
  demo,
  reconnect,
  info,
  onDisconnected,
  onChange,
  onError,
  onSignInAgain,
}: {
  account: Account;
  demo: boolean;
  reconnect: boolean;
  info?: StorageInfo["accounts"][number];
  onDisconnected: () => void;
  onChange: (patch: Partial<Account>) => void;
  onError: (message: string) => void;
  onSignInAgain: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [look, setLook] = useState(false);
  const [name, setName] = useState(account.nickname ?? "");

  /** Saves the name shown in Kite's sidebar and switcher. Empty goes back to the Google name. */
  const saveName = async () => {
    const nickname = name.trim() || null;
    if (nickname === (account.nickname ?? null)) return;
    const before = account.nickname ?? null;
    onChange({ nickname });
    if (demo) return;
    try {
      await request(`/api/accounts`, "PATCH", { id: account.id, nickname });
    } catch (error) {
      onChange({ nickname: before });
      setName(before ?? "");
      onError(error instanceof Error && error.message !== "Request failed" ? error.message : "Couldn't rename the account. Try again.");
    }
  };
  const [busy, setBusy] = useState(false);
  const spec = accountSpec(account);
  const syncing = useAccountSync(account.id);
  const status = demo
    ? "Demo account"
    : syncing && !reconnect
      ? `Syncing · ${syncCount(syncing)}`
    : reconnect
      ? spec.signIn === "imap"
        ? "Your mail server stopped accepting the password. Reconnect to keep syncing."
        : `${signInCompany(spec.signIn)} stopped letting Kite in. Reconnect to keep syncing.`
      : info
        ? `${info.threads.toLocaleString()} conversations${info.syncedAt ? ` · synced ${formatDistanceToNow(new Date(info.syncedAt), { addSuffix: true })}` : ""}`
        : serviceName(account);

  const disconnect = async () => {
    setBusy(true);
    try {
      await request(`/api/accounts?id=${encodeURIComponent(account.id)}`, "DELETE");
      onDisconnected();
    } catch {
      onError("Couldn't disconnect. Try again.");
      setBusy(false);
    }
  };

  const highlight = reconnect || !!account.reconnectFor;
  return (
    <div className="flex flex-col gap-2.5 px-4 py-3.5" data-sensitive>
      <div className="flex flex-wrap items-center gap-x-3.5 gap-y-2">
        <Tooltip label={look ? "Done" : "Colour and picture"}>
          <button aria-label="Colour and picture" aria-expanded={look} onClick={() => setLook((v) => !v)} className="rounded-full transition-transform duration-150 hover:scale-105">
            <AccountFace account={account} syncing={!!syncing && !reconnect} className="size-9 text-[12px]" />
          </button>
        </Tooltip>
        <div className="min-w-0 flex-1 basis-48">
          <input
            value={name}
            maxLength={40}
            aria-label={`Name for ${account.email} in Kite`}
            placeholder={account.name || "Name this account"}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => void saveName()}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(account.nickname ?? "");
                requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
              }
            }}
            className="-mx-1.5 h-7 w-full max-w-[260px] rounded-md border border-transparent bg-transparent px-1.5 text-[13.5px] font-semibold outline-none transition-colors placeholder:text-pane-fg hover:border-pane-border focus:border-accent/60 focus:placeholder:text-pane-muted"
          />
          <p className="truncate text-[12px] text-pane-muted">
            {account.email} <span className="opacity-60">·</span> {serviceName(account)}
          </p>
          <p className={cn("mt-0.5 flex items-center gap-1 truncate text-[12px]", reconnect ? "text-warning" : "text-pane-muted")}>
            {reconnect ? <Icon icon={Alert02Icon} size={13} className="shrink-0" /> : syncing ? <Spinner size={12} className="shrink-0 text-accent" /> : null}
            {status}
          </p>
        </div>
        {demo ? null : (
          <div className="flex shrink-0 items-center gap-1.5">
            {spec.signIn === "imap" ? (
              // A password account signs in again in Kite's own form.
              <button onClick={onSignInAgain} className={cn(buttonClass, highlight && "border-accent/50 text-accent")}>
                Reconnect
              </button>
            ) : (
              <a href={`/api/auth/${spec.signIn}?hint=${encodeURIComponent(account.email)}`} className={cn(buttonClass, highlight && "border-accent/50 text-accent")}>
                Reconnect
              </a>
            )}
            <button onClick={() => setConfirming(true)} disabled={confirming} className={buttonClass}>
              Disconnect
            </button>
          </div>
        )}
      </div>
      <AnimatePresence initial={false}>{look ? <AccountLook account={account} demo={demo} onChange={onChange} onError={onError} /> : null}</AnimatePresence>
      {account.reconnectFor && !reconnect && !demo ? <Note>{account.reconnectFor}</Note> : null}
      {account.googleLink !== undefined && !demo ? <GoogleLink account={account} onError={onError} /> : null}
      <AnimatePresence initial={false}>
        {confirming ? (
          <Confirm action="Disconnect" busy={busy} onCancel={() => setConfirming(false)} onConfirm={() => void disconnect()}>
            Kite signs out and removes this account&apos;s mail from this computer. Nothing changes in {serviceName(account)}.
          </Confirm>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/**
 * Gmail over IMAP: the optional Google sign-in for what IMAP can't give (the account's photo, its
 * calendar, photos from its contacts). Never asks for mail, never required.
 */
function GoogleLink({ account, onError }: { account: Account; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const unlink = async () => {
    setBusy(true);
    try {
      await request(`/api/google-link?account=${encodeURIComponent(account.id)}`, "DELETE");
    } catch {
      onError("Couldn't disconnect Google. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-pane-2 px-3 py-2 text-[12px]">
      <span className="min-w-0 flex-1 basis-56 text-pane-muted">
        {account.googleLink
          ? "Google sign-in connected for your photo, calendar and contact photos. It can't read your mail."
          : "Connect Google for your photo, calendar and contact photos. Optional, and it can't read your mail."}
      </span>
      {account.googleLink ? (
        <button onClick={() => void unlink()} disabled={busy} className={cn(buttonClass, "flex items-center gap-1.5")}>
          {busy ? <Spinner size={12} /> : null}
          Disconnect Google
        </button>
      ) : (
        <a href={permissionHref(account)} className={buttonClass}>
          Connect Google
        </a>
      )}
    </div>
  );
}
