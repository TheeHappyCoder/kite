import "server-only";

import { getAccount, saveToken, setAccountName, setAccountPicture, upsertAccount, type AccountRow } from "../db";
import type { MailProvider, SignedIn } from "./provider";

// Provider-neutral parts of signing in, shared by /api/auth/[provider] and its callback.

/** Cookies one sign-in keeps for 10 minutes: the state, plus any secrets the provider needs (a PKCE verifier). */
export function signInCookie(slug: string, key: string) {
  return `kite_${slug}_oauth_${key}`;
}

/**
 * Stores a finished sign-in: the account (found by address, or new), its sealed OAuth tokens (a
 * password sign-in saves its own secret) and photo.
 * Null when the address is already connected through another provider (tokens are never mixed).
 */
export function connectAccount(provider: MailProvider, signedIn: SignedIn): AccountRow | null {
  const account = upsertAccount({ email: signedIn.email, name: signedIn.name, provider: provider.id });
  if (getAccount(account.id)?.provider !== provider.id) return null;
  // Signing in again can bring a new name (a password sign-in only has one when the user typed it).
  if (signedIn.name && signedIn.name !== account.name) setAccountName(account.id, signedIn.name);
  const { tokens } = signedIn;
  if (tokens) {
    saveToken({
      account_id: account.id,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token ?? null,
      expires_at: Date.now() + tokens.expires_in * 1000,
      scope: tokens.scope ?? null,
    });
  }
  // The photo is looked up again on the next sync (it may have changed since the last sign-in).
  setAccountPicture(account.id, null);
  return account;
}
