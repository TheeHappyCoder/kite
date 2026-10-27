import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import * as z from "zod";
import { rejectCrossSite } from "@/server/guard";
import { connectAccount, signInCookie } from "@/server/mail/auth";
import { SignInError } from "@/server/mail/errors";
import { oauthBySlug, passwordBySlug } from "@/server/providers/registry";
import { syncAccount } from "@/server/sync";

export const runtime = "nodejs";

/** Starts "Sign in with <provider>": a one-time state in a short-lived cookie, then the provider's page. */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: slug } = await params;
  const url = new URL(request.url);
  const origin = url.origin;
  const provider = oauthBySlug(slug);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const home = (connect: string) => NextResponse.redirect(new URL(`/?connect=${connect}&via=${slug}`, origin));
  if (!provider.auth.configured()) return home("missing_config");

  const state = randomBytes(24).toString("hex");
  const hint = url.searchParams.get("hint") ?? "";
  let begun;
  try {
    begun = await provider.auth.begin({ origin, state, hint: /^[^\s@]+@[^\s@]+$/.test(hint) ? hint : undefined });
  } catch (error) {
    if (error instanceof SignInError) return home(error.reason);
    throw error;
  }

  const response = NextResponse.redirect(begun.url);
  const cookie = { httpOnly: true, sameSite: "lax" as const, secure: origin.startsWith("https:"), maxAge: 600, path: "/" };
  response.cookies.set(signInCookie(slug, "state"), state, cookie);
  for (const [key, value] of Object.entries(begun.secrets ?? {})) response.cookies.set(signInCookie(slug, key), value, cookie);
  // A Google sign-in for an IMAP account's extras left unfinished (/api/google-link) mustn't claim this one.
  response.cookies.delete(signInCookie(slug, "link"));
  return response;
}

const Server = z.object({ host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:-]+$/), port: z.number().int().min(1).max(65535), secure: z.boolean() });
const PasswordBody = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(1024),
  name: z.string().trim().max(100).optional(),
  servers: z.object({ imap: Server, smtp: Server, username: z.string().trim().max(320).optional() }).optional(),
});

/**
 * Signs in with an address and an app password (IMAP): the provider checks them against the
 * servers before anything is stored. Answers JSON for the form: the account, or a plain error and
 * whether to ask for server settings.
 */
export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { provider: slug } = await params;
  const provider = passwordBySlug(slug);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  const parsed = PasswordBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter your email address and password." }, { status: 400 });
  try {
    const signedIn = await provider.auth.signIn(parsed.data);
    const account = connectAccount(provider, signedIn);
    if (!account) return NextResponse.json({ error: "That address is already connected another way." }, { status: 409 });
    signedIn.save(account.id);
    await provider.auth.connected?.(account);
    // Start reading mail now rather than on the next tick.
    void syncAccount(account.id);
    return NextResponse.json({ ok: true, accountId: account.id });
  } catch (error) {
    if (error instanceof SignInError) return NextResponse.json({ error: error.message, ask: error.ask ?? null }, { status: 400 });
    console.error(`${slug} sign-in failed:`, error instanceof Error ? error.message : error);
    return NextResponse.json({ error: "Kite couldn't sign in. Try again." }, { status: 500 });
  }
}
