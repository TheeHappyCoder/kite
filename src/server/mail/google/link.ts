import "server-only";

import { getAccount, getDb, setAccountPicture } from "../../db";
import { seal, unseal, warmKey } from "../../secrets";
import { ProviderError, SignInError } from "../errors";
import {
  CALENDAR_SCOPES,
  CONTACT_PHOTO_SCOPES,
  PROFILE_SCOPES,
  consentUrl,
  decodeIdToken,
  exchangeCode,
  refreshTokens,
  revokeToken,
  type GoogleAccess,
  type GoogleTokens,
} from "./oauth";

// The optional Google sign-in a Gmail-over-IMAP account adds after onboarding, for what IMAP can't
// give: its calendar (`calendar.events`), photos from its Google contacts and its own profile photo.
// Sensitive scopes only (Google verification, no CASA): never a Gmail scope, so "Also run in Gmail"
// stays unavailable. Only the same Google account as the IMAP address is accepted. Tokens are
// sealed in `google_links`, tied to the IMAP account; Disconnect and "Erase everything" remove them.
//
// It shares Kite's one Google callback (/api/auth/google/callback): the start route leaves the
// account id in the sign-in cookies, and the callback hands that sign-in here instead of creating
// an account.

type LinkRow = { account_id: string; email: string; access_token: string; refresh_token: string | null; expires_at: number; scope: string | null };

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

function row(accountId: string) {
  return getDb().prepare("SELECT * FROM google_links WHERE account_id = ?").get(accountId) as LinkRow | undefined;
}

function save(accountId: string, email: string, tokens: GoogleTokens) {
  getDb()
    .prepare(
      `INSERT INTO google_links (account_id, email, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         email = excluded.email,
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, google_links.refresh_token),
         expires_at = excluded.expires_at,
         scope = COALESCE(excluded.scope, google_links.scope)`,
    )
    .run(
      accountId,
      email,
      seal(tokens.access_token),
      tokens.refresh_token ? seal(tokens.refresh_token) : null,
      Date.now() + tokens.expires_in * 1000,
      tokens.scope ?? null,
    );
}

/** Whether the account has its optional Google sign-in. */
export function googleLinked(accountId: string) {
  return !!row(accountId);
}

/**
 * The scopes to ask for: who you are, plus the extras whose settings are on (passed in: settings.ts
 * reaches the provider registry, which loads this module).
 */
function linkScopes(wants: { calendar: boolean; contactPhotos: boolean }) {
  return [...PROFILE_SCOPES, ...(wants.calendar ? CALENDAR_SCOPES : []), ...(wants.contactPhotos ? CONTACT_PHOTO_SCOPES : [])];
}

/**
 * Google's consent page for the account's address. Not incremental: the same Google account may have
 * granted Kite's client Gmail scopes before (the Gmail API sign-in), and this token must never carry
 * them, so it asks for exactly the extras whose settings are on, each time.
 */
export function beginLink({ accountId, origin, state, wants }: { accountId: string; origin: string; state: string; wants: { calendar: boolean; contactPhotos: boolean } }) {
  const account = getAccount(accountId);
  if (!account) throw new SignInError("failed");
  return consentUrl({ origin, state, scopes: linkScopes(wants), hint: account.email, prompt: "consent", incremental: false });
}

/**
 * Keeps the sign-in Google sent back, when it is the account's own Google account. "other_google"
 * when the user picked a different one (its tokens are dropped, nothing kept).
 */
export async function finishLink({ accountId, code, origin }: { accountId: string; code: string; origin: string }): Promise<"ok" | "other_google"> {
  const account = getAccount(accountId);
  if (!account) throw new SignInError("failed");
  const tokens = await exchangeCode(code, origin);
  const email = decodeIdToken(tokens.id_token).email;
  if (!email || email.toLowerCase() !== account.email.toLowerCase()) return "other_google";
  await warmKey();
  save(accountId, email, tokens);
  // The profile photo is looked up again with the new sign-in.
  setAccountPicture(accountId, null);
  return "ok";
}

/** Drops the account's Google sign-in: revoked at Google (best effort) and removed here. */
export async function unlink(accountId: string) {
  const link = row(accountId);
  if (!link) return;
  await warmKey();
  const value = link.refresh_token ? unseal(link.refresh_token) : unseal(link.access_token);
  getDb().prepare("DELETE FROM google_links WHERE account_id = ?").run(accountId);
  setAccountPicture(accountId, null);
  await revokeToken(value);
}

/** A valid access token for the account's Google sign-in. A revoked one is removed (Settings offers Connect again). */
async function token(accountId: string) {
  await warmKey();
  const link = row(accountId);
  const lost = () => new ProviderError("Google stopped letting Kite in. Connect Google again in Settings → Accounts.", 401, "Google");
  if (!link) throw lost();
  if (Date.now() < link.expires_at - REFRESH_BUFFER_MS) return unseal(link.access_token);
  const refreshed = link.refresh_token ? await refreshTokens(unseal(link.refresh_token)) : null;
  if (!refreshed) {
    getDb().prepare("DELETE FROM google_links WHERE account_id = ?").run(accountId);
    throw lost();
  }
  save(accountId, link.email, refreshed);
  return refreshed.access_token;
}

/** The shared Google services (calendar, contact photos, profile photo) through the optional sign-in. */
export const linkAccess: GoogleAccess = {
  token,
  granted(accountId, scopes) {
    const granted = new Set(row(accountId)?.scope?.split(/\s+/) ?? []);
    return scopes.every((s) => granted.has(s));
  },
};
