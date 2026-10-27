// The result of a sign-in, passed back to the app as `/?connect=<result>&via=<slug>`.

/** Sign-in routes: /api/auth/<slug> and /api/auth/<slug>/callback. */
/** OAuth ones redirect through the provider's page; `imap` is a password form posted to /api/auth/imap. */
export type SignInVia = "google" | "microsoft" | "imap";

const CONNECT_ERRORS = ["cancelled", "invalid_state", "failed", "missing_config", "admin_required", "other_provider"] as const;
export type ConnectError = (typeof CONNECT_ERRORS)[number];

export function isConnectError(value: string): value is ConnectError {
  return (CONNECT_ERRORS as readonly string[]).includes(value);
}

/** The company whose sign-in it was, for messages. */
export function signInCompany(via: SignInVia | null) {
  return via === "microsoft" ? "Microsoft" : via === "google" ? "Google" : "Your mail provider";
}

/**
 * What a password sign-in form should do about an error besides showing it: ask for the servers,
 * or (Gmail) point at the step that fixes it: a new app password, IMAP turned off, a browser sign-in.
 */
export type SignInAsk = "servers" | "app_password" | "imap" | "browser";
