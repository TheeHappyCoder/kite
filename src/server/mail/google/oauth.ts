import "server-only";

import { SignInError } from "../errors";

// Google's OAuth pieces every Google sign-in shares: the Gmail API provider's own sign-in
// (providers/gmail/oauth.ts) and the optional Google sign-in a Gmail-over-IMAP account adds for
// its calendar, contact photos and profile photo (./link.ts). Both use Kite's one Google client
// and its one registered callback (/api/auth/google/callback).

/** Who signed in: the ID token's email and names. Always requested. */
export const PROFILE_SCOPES = ["openid", "email", "profile"];

/** Opt-in (Settings → Accounts): photos people have in your Google contacts, via the People API. */
export const CONTACT_PHOTO_SCOPES = [
  "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/contacts.other.readonly",
];

/** Opt-in (Settings → Accounts, or Connect on an invite card): answer invites in Google Calendar, Today's events. */
export const CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

export function googleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

function callbackUrl(origin: string) {
  return new URL("/api/auth/google/callback", origin).toString();
}

export type GoogleTokens = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  id_token?: string;
};

/**
 * Google's consent page for `scopes`. `incremental` adds them to everything the Google account
 * granted Kite's client before (include_granted_scopes); without it the token holds only `scopes`.
 */
export function consentUrl(input: { origin: string; state: string; scopes: string[]; hint?: string; prompt: string; incremental: boolean }) {
  const { origin, state, scopes, hint, prompt, incremental } = input;
  const config = googleConfig();
  if (!config) throw new SignInError("missing_config");
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl(origin),
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt,
    include_granted_scopes: String(incremental),
    state,
    ...(hint ? { login_hint: hint } : {}),
  }).toString();
  return url;
}

export async function exchangeCode(code: string, origin: string): Promise<GoogleTokens> {
  const config = googleConfig();
  if (!config) throw new SignInError("missing_config");
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: callbackUrl(origin),
      grant_type: "authorization_code",
    }),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "Token exchange failed");
  }
  return data;
}

/** The ID token's claims. It comes straight from Google's token endpoint over TLS, so they can be trusted. */
export function decodeIdToken(idToken?: string): { email?: string; name?: string; given_name?: string; picture?: string } {
  if (!idToken) return {};
  try {
    return JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8"));
  } catch {
    return {};
  }
}

const MAX_RETRIES = 2;

/**
 * A new access token, or null when the grant is gone (revoked: the user must connect again).
 * Throws when Google couldn't be reached after a few tries.
 */
export async function refreshTokens(refreshToken: string): Promise<GoogleTokens | null> {
  const config = googleConfig();
  if (!config) throw new Error("Google sign-in isn't configured");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        }),
      });
      const data = await res.json();
      if (res.ok) return data;
      if (data.error === "invalid_grant") return null;
      throw new Error(data.error_description ?? data.error);
    } catch (error) {
      if (attempt === MAX_RETRIES) throw error;
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
    }
  }
  throw new Error("Google token refresh failed");
}

/** Tells Google to drop Kite's access. Best effort: local data is removed either way. */
export async function revokeToken(token: string) {
  await fetch("https://oauth2.googleapis.com/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ token }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => {});
}

/** The signed-in account's profile photo (from the OpenID userinfo endpoint's URL), null when it has none. */
export async function profilePhoto(accessToken: string) {
  const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`userinfo failed (${res.status})`);
  const { picture } = (await res.json()) as { picture?: string };
  if (!picture?.startsWith("https://")) return null;
  // Google-hosted photos take a size: ask for one that stays sharp on retina avatars.
  const photo = await fetch(picture.replace(/=s\d+(-[a-z]+)?$/, "=s128$1"), { signal: AbortSignal.timeout(8000) });
  if (!photo.ok) throw new Error(`profile photo failed (${photo.status})`);
  return Buffer.from(await photo.arrayBuffer());
}

/** How the shared Google services (calendar, contact photos) reach one account's Google sign-in. */
export type GoogleAccess = {
  /** A valid access token for the account's Google sign-in. */
  token(accountId: string): Promise<string>;
  /** Whether that sign-in was granted every scope listed. */
  granted(accountId: string, scopes: string[]): boolean;
};
