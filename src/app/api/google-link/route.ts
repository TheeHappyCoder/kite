import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { getAccount } from "@/server/db";
import { rejectCrossSite } from "@/server/guard";
import { signInCookie } from "@/server/mail/auth";
import { SignInError } from "@/server/mail/errors";
import { beginLink, unlink } from "@/server/mail/google/link";
import { googleConfig } from "@/server/mail/google/oauth";
import { googleLinkable } from "@/server/providers/registry";
import { getPreferences } from "@/server/settings";
import { emitAccounts } from "@/server/sync";

export const runtime = "nodejs";

// The optional Google sign-in of a Gmail-over-IMAP account (server/mail/google/link.ts): GET starts
// it (Google's page, then /api/auth/google/callback), DELETE drops it. The result comes back as
// `/?google=<result>`.

function linkable(id: string | null) {
  const account = id ? getAccount(id) : null;
  return account && googleLinkable(account) ? account : null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const account = linkable(url.searchParams.get("account"));
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  const home = (result: string) => NextResponse.redirect(new URL(`/?google=${result}`, url.origin));
  if (!googleConfig()) return home("missing_config");

  const state = randomBytes(24).toString("hex");
  let target: URL;
  try {
    const { calendar, senderPhotos } = getPreferences();
    target = beginLink({ accountId: account.id, origin: url.origin, state, wants: { calendar, contactPhotos: senderPhotos } });
  } catch (error) {
    if (error instanceof SignInError) return home(error.reason);
    throw error;
  }
  // Kite's one Google callback finishes this sign-in for the account named in `link`.
  const response = NextResponse.redirect(target);
  const cookie = { httpOnly: true, sameSite: "lax" as const, secure: url.origin.startsWith("https:"), maxAge: 600, path: "/" };
  response.cookies.set(signInCookie("google", "state"), state, cookie);
  response.cookies.set(signInCookie("google", "link"), account.id, cookie);
  return response;
}

export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const account = linkable(new URL(request.url).searchParams.get("account"));
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  await unlink(account.id);
  emitAccounts();
  return NextResponse.json({ ok: true });
}
