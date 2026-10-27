import "server-only";

import type { ConnectError, SignInAsk } from "@/lib/mail/connect";

/** A provider's API refused or failed a request. `service` names it for logs and messages ("Gmail"). */
export class ProviderError extends Error {
  constructor(message: string, public status: number, public service: string) {
    super(message);
  }
}

/** The account's sign-in no longer works (revoked or expired): the user has to reconnect. */
export class ReconnectRequired extends Error {
  constructor(public accountId: string) {
    super("Account needs to be reconnected");
  }
}

/** A label change the user can fix (unknown label, a folder that still holds mail...), explained as it is. Shown as a 400. */
export class LabelError extends Error {
  status = 400;
}

/** The change feed's position is too old (Gmail history after about a week, an expired delta link): start over. */
export class CursorExpired extends Error {}

/**
 * A sign-in that ended with something to tell the user (cancelled, needs admin approval...). A
 * password sign-in puts the plain explanation in `message` and what the form should offer in `ask`
 * (`servers` when Kite couldn't find them; Gmail's cases point at a walkthrough step).
 */
export class SignInError extends Error {
  constructor(
    public reason: ConnectError,
    detail?: string,
    public ask?: SignInAsk,
  ) {
    super(detail ?? reason);
  }
}
