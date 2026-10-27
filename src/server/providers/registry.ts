import "server-only";

import type { SignInVia } from "@/lib/mail/connect";
import type { Provider } from "@/lib/mail/types";
import { listAccounts, type AccountRow } from "../db";
import type { CalendarAdapter, ContactPhotos, MailAdapter, MailProvider, OAuthAuth, PasswordAuth } from "../mail/provider";
import { gmailProvider } from "./gmail";
import { imapProvider } from "./imap";
import { outlookProvider } from "./outlook";

// The one place that knows which providers exist. Everything else asks for an account's provider
// here and talks to the MailProvider contract (server/mail/provider.ts). Adding a provider is a new
// folder next to this file, one line below, and its entry in lib/mail/providers.ts.

const PROVIDERS: Partial<Record<Provider, MailProvider>> = {
  gmail: gmailProvider,
  outlook: outlookProvider,
  imap: imapProvider,
};

export function providers() {
  return Object.values(PROVIDERS).filter((p): p is MailProvider => !!p);
}

export function providerFor(account: Pick<AccountRow, "provider">): MailProvider {
  const provider = PROVIDERS[account.provider];
  if (!provider) throw new Error(`No provider for ${account.provider}`);
  return provider;
}

/** The account's mail adapter, or null while Kite only signs in to this provider. */
export function mailFor(account: Pick<AccountRow, "provider">): MailAdapter | null {
  return PROVIDERS[account.provider]?.mail ?? null;
}

/** Like mailFor, for code paths that only run on mail Kite has read (so the adapter exists). */
export function mailOf(account: Pick<AccountRow, "provider">): MailAdapter {
  const mail = mailFor(account);
  if (!mail) throw new Error(`Kite doesn't read ${account.provider} mail yet`);
  return mail;
}

/** The account's calendar, or null when it has none (invites are then answered by email). */
export function calendarFor(account: Pick<AccountRow, "id" | "provider">): CalendarAdapter | null {
  const calendar = PROVIDERS[account.provider]?.calendar;
  return calendar && (calendar.offered?.(account.id) ?? true) ? calendar : null;
}

/** The account's contact photos, or null when it can't have them. */
export function contactPhotosFor(account: Pick<AccountRow, "id" | "provider">): ContactPhotos | null {
  const photos = PROVIDERS[account.provider]?.contactPhotos;
  return photos && (photos.offered?.(account.id) ?? true) ? photos : null;
}

/**
 * Whether the account can add the optional Google sign-in for its calendar and photos
 * (server/mail/google/link.ts): Gmail over IMAP. The Gmail API provider asks in its own sign-in.
 */
export function googleLinkable(account: Pick<AccountRow, "id" | "provider">) {
  return account.provider !== "gmail" && PROVIDERS[account.provider]?.organisesLike?.(account.id) === "gmail";
}

/** The provider behind a sign-in route (/api/auth/<slug>). */
function providerBySlug(slug: string): MailProvider | null {
  return providers().find((p) => p.auth.slug === (slug as SignInVia)) ?? null;
}

/** The OAuth provider behind /api/auth/<slug> (and its callback). */
export function oauthBySlug(slug: string): (MailProvider & { auth: OAuthAuth }) | null {
  const provider = providerBySlug(slug);
  return provider?.auth.kind === "oauth" ? (provider as MailProvider & { auth: OAuthAuth }) : null;
}

/** The password sign-in provider behind POST /api/auth/<slug>. */
export function passwordBySlug(slug: string): (MailProvider & { auth: PasswordAuth }) | null {
  const provider = providerBySlug(slug);
  return provider?.auth.kind === "password" ? (provider as MailProvider & { auth: PasswordAuth }) : null;
}

/** Accounts whose mail Kite reads (a provider that only signs in so far is left out). */
export function mailAccounts() {
  return listAccounts().filter((a) => !!mailFor(a));
}
