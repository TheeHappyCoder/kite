import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { getAccount, getToken, getTokenScope, saveToken } from "../../db";
import { warmKey } from "../../secrets";
import { getPreferences } from "../../settings";
import { ReconnectRequired, SignInError } from "../../mail/errors";
import type { OAuthAuth, TokenSet } from "../../mail/provider";

// Microsoft sign-in (Entra ID v2 endpoint, "common": work and school accounts plus personal
// Outlook.com / Hotmail / Live). Kite is registered as a public client (mobile and desktop), so
// there is no client secret: the auth code is bound to this sign-in with PKCE instead.

/** offline_access gives a refresh token; User.Read the address and name; Mail.* the mailbox. */
const BASE_SCOPES = ["offline_access", "User.Read", "Mail.ReadWrite", "Mail.Send"];
/**
 * The category list with colours (masterCategories), and making and deleting categories. Asked for
 * at sign-in; accounts connected before it keep working without (read-only ones have the old Read).
 */
const CATEGORY_SCOPE = "MailboxSettings.ReadWrite";
const CATEGORY_READ = "MailboxSettings.Read";
const MICROSOFT_SCOPES = [...BASE_SCOPES, CATEGORY_SCOPE].join(" ");
/** Answering invites in the calendar (opt-in: Settings → Accounts, or Connect on an invite card). */
const CALENDAR_SCOPE = "Calendars.ReadWrite";

/** Whether the account granted a scope (Microsoft reports them bare or as Graph URLs). */
function granted(accountId: string, scope: string) {
  const want = scope.toLowerCase();
  return (getTokenScope(accountId) ?? "").split(/\s+/).some((s) => s.toLowerCase() === want || s.toLowerCase().endsWith(`/${want}`));
}

/** Whether Kite may read the account's category list (accounts connected before categories may not). */
export const canReadCategories = (accountId: string) => granted(accountId, CATEGORY_SCOPE) || granted(accountId, CATEGORY_READ);

/** Whether Kite may make and delete categories in the account's list. */
export const canEditCategories = (accountId: string) => granted(accountId, CATEGORY_SCOPE);

/** Whether Kite may answer invites in the account's calendar. */
export const canUseCalendar = (accountId: string) => granted(accountId, CALENDAR_SCOPE);

/** What to ask for at sign-in: the calendar only once the user turned it on. */
const signInScopes = () => [MICROSOFT_SCOPES, ...(getPreferences().calendar ? [CALENDAR_SCOPE] : [])].join(" ");

/** What a refresh may ask for: only scopes this account granted (anything new needs consent again). */
const grantedScopes = (accountId: string) =>
  [...BASE_SCOPES, ...[CATEGORY_SCOPE, CATEGORY_READ, CALENDAR_SCOPE].filter((s) => granted(accountId, s))].join(" ");

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;
const MAX_RETRIES = 2;

function microsoftConfig() {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  return clientId ? { clientId } : null;
}

function callbackUrl(origin: string) {
  return new URL("/api/auth/microsoft/callback", origin).toString();
}

async function tokenRequest(params: Record<string, string>, scope = signInScopes()) {
  const config = microsoftConfig();
  if (!config) throw new SignInError("missing_config");
  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, scope, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok && !!data.access_token, data };
}

async function refresh(refreshToken: string, scope: string): Promise<TokenSet | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { ok, data } = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken }, scope);
      if (ok) return data;
      if (data.error === "invalid_grant" || data.error === "interaction_required") return null; // expired or revoked: reconnect
      throw new Error(data.error_description ?? data.error ?? "Token refresh failed");
    } catch (error) {
      if (attempt === MAX_RETRIES) {
        console.error("Microsoft token refresh failed:", error instanceof Error ? error.message : error);
        return null;
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  return null;
}

/**
 * A valid Graph access token for an Outlook account, refreshed when close to expiry. Microsoft
 * hands out a new refresh token on every refresh and the old one stops working after a while
 * (about 90 days of not being used), so the new one is always stored.
 */
export async function getAccessToken(accountId: string) {
  if (getAccount(accountId)?.provider !== "outlook") throw new Error("Not an Outlook account");
  await warmKey();
  const token = getToken(accountId);
  if (!token) throw new ReconnectRequired(accountId);
  if (Date.now() < token.expires_at - REFRESH_BUFFER_MS) return token.access_token;
  if (!token.refresh_token) throw new ReconnectRequired(accountId);

  // Ask only for what the account granted: a scope added since would need the user's consent again.
  const refreshed = await refresh(token.refresh_token, grantedScopes(accountId));
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

/** Who signed in: Graph's /me (personal accounts often have no `mail`, the sign-in name is the address). */
async function fetchProfile(accessToken: string) {
  const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName,givenName", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Microsoft profile lookup failed (${res.status})`);
  const me = (await res.json()) as { mail?: string | null; userPrincipalName?: string; displayName?: string | null; givenName?: string | null };
  const email = [me.mail, me.userPrincipalName].find((v) => !!v && /^[^\s@]+@[^\s@]+$/.test(v));
  return { email: email ?? null, name: me.givenName || me.displayName || null };
}

export const microsoftAuth: OAuthAuth = {
  kind: "oauth",
  slug: "microsoft",
  configured: () => microsoftConfig() != null,
  async begin({ origin, state, hint }) {
    const config = microsoftConfig();
    if (!config) throw new SignInError("missing_config");
    // PKCE: the verifier stays in a cookie, Microsoft gets only its hash.
    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = new URL(`${AUTHORITY}/authorize`);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: callbackUrl(origin),
      response_type: "code",
      response_mode: "query",
      scope: signInScopes(),
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      prompt: "select_account",
      ...(hint ? { login_hint: hint } : {}),
    }).toString();
    return { url, secrets: { verifier } };
  },
  async finish({ code, origin, secrets }) {
    if (!secrets.verifier) throw new SignInError("invalid_state");
    const { ok, data } = await tokenRequest({
      grant_type: "authorization_code",
      code,
      code_verifier: secrets.verifier,
      redirect_uri: callbackUrl(origin),
    });
    if (!ok) throw new Error(data.error_description ?? data.error ?? "Token exchange failed");
    const profile = await fetchProfile(data.access_token);
    if (!profile.email) throw new Error("Microsoft did not return an email address");
    return { email: profile.email, name: profile.name ?? profile.email.split("@")[0], tokens: data };
  },
  /**
   * Work and school accounts may need an administrator to approve Kite first (it isn't
   * publisher-verified yet): that's expected, not a bug, so it gets its own explanation.
   */
  errorReason(error, description) {
    if (/AADSTS(65001|90094|90095|900941)|admin/i.test(description)) return "admin_required";
    if (error === "access_denied" || error === "consent_required") return "cancelled";
    return "failed";
  },
  accessToken: getAccessToken,
  // Public clients can't revoke a single grant; Disconnect removes the tokens and everything else locally.
  revoke: async () => {},
};
