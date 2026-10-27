import "server-only";

import { getAccount, getToken, getTokenScope, saveToken } from "../../db";
import { warmKey } from "../../secrets";
import { getPreferences } from "../../settings";
import { ReconnectRequired, SignInError } from "../../mail/errors";
import {
  CALENDAR_SCOPES,
  CONTACT_PHOTO_SCOPES,
  PROFILE_SCOPES,
  consentUrl,
  decodeIdToken,
  exchangeCode,
  googleConfig,
  refreshTokens,
  revokeToken,
  type GoogleAccess,
} from "../../mail/google/oauth";
import type { OAuthAuth } from "../../mail/provider";

// Gmail API sign-in (Kite's own test users): the shared Google OAuth pieces (server/mail/google)
// plus the Gmail scopes (modify for archive/star/read, send for replies).

const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send"];

/** Opt-in per rule ("Also run in Gmail"): create and delete the Gmail filters Kite makes for rules. */
export const GMAIL_FILTER_SCOPES = ["https://www.googleapis.com/auth/gmail.settings.basic"];

/** Scopes to ask for at sign-in. Optional ones are only requested once the user turns them on. */
function scopesFor({ contactPhotos, gmailFilters, calendar }: { contactPhotos: boolean; gmailFilters: boolean; calendar: boolean }) {
  return [
    ...PROFILE_SCOPES,
    ...GMAIL_SCOPES,
    ...(contactPhotos ? CONTACT_PHOTO_SCOPES : []),
    ...(gmailFilters ? GMAIL_FILTER_SCOPES : []),
    ...(calendar ? CALENDAR_SCOPES : []),
  ];
}

/** Whether the account's token was granted every scope listed. */
export function hasScopes(accountId: string, scopes: string[]) {
  const granted = new Set(getTokenScope(accountId)?.split(/\s+/) ?? []);
  return scopes.every((s) => granted.has(s));
}

const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Returns a valid access token for the account, refreshing it when close to expiry. */
export async function getAccessToken(accountId: string) {
  // Never send another provider's tokens to Google.
  if (getAccount(accountId)?.provider !== "gmail") throw new Error("Not a Gmail account");
  // Waits for the key being unwrapped since startup instead of blocking the server on a second unwrap.
  await warmKey();
  const token = getToken(accountId);
  if (!token) throw new ReconnectRequired(accountId);
  if (Date.now() < token.expires_at - REFRESH_BUFFER_MS) return token.access_token;
  if (!token.refresh_token) throw new ReconnectRequired(accountId);

  const refreshed = await refreshTokens(token.refresh_token).catch((error) => {
    console.error("Google token refresh failed:", error);
    return null;
  });
  if (!refreshed) throw new ReconnectRequired(accountId);
  saveToken({
    account_id: accountId,
    access_token: refreshed.access_token,
    refresh_token: refreshed.refresh_token ?? null,
    expires_at: Date.now() + refreshed.expires_in * 1000,
    scope: refreshed.scope ?? null,
  });
  return refreshed.access_token;
}

/** The shared Google services (calendar, contact photos) through the Gmail sign-in's token. */
export const gmailAccess: GoogleAccess = { token: getAccessToken, granted: hasScopes };

/** Tells Google to drop Kite's access for this account. Best effort: local data is removed either way. */
async function revokeAccess(accountId: string) {
  if (getAccount(accountId)?.provider !== "gmail") return;
  await warmKey();
  const token = getToken(accountId);
  const value = token?.refresh_token ?? token?.access_token;
  if (value) await revokeToken(value);
}

export const googleAuth: OAuthAuth = {
  kind: "oauth",
  slug: "google",
  configured: () => googleConfig() != null,
  async begin({ origin, state, hint }) {
    if (!googleConfig()) throw new SignInError("missing_config");
    // Loaded here: rules.ts reaches this module through the provider registry.
    const { gmailRulesExist } = await import("../../rules");
    // Incremental auth keeps earlier grants, so turning contact photos, the calendar or a rule's
    // "Also run in Gmail" on just adds their scopes.
    const scopes = scopesFor({ contactPhotos: getPreferences().senderPhotos, gmailFilters: gmailRulesExist(), calendar: getPreferences().calendar });
    return { url: consentUrl({ origin, state, scopes, hint, prompt: "consent select_account", incremental: true }) };
  },
  async finish({ code, origin }) {
    const tokens = await exchangeCode(code, origin);
    const profile = decodeIdToken(tokens.id_token);
    if (!profile.email) throw new Error("Google did not return an email address");
    return {
      email: profile.email,
      name: profile.given_name ?? profile.name ?? profile.email.split("@")[0],
      tokens,
    };
  },
  errorReason: () => "cancelled",
  accessToken: getAccessToken,
  revoke: revokeAccess,
  async connected(account) {
    // Rules waiting for permission to run in Gmail get their filters now.
    const { syncFilters } = await import("../../rules");
    await syncFilters({ accountId: account.id });
  },
};
