import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { refreshAccountPhoto } from "@/server/avatars";
import { getAccount } from "@/server/db";
import { connectAccount, signInCookie } from "@/server/mail/auth";
import { SignInError } from "@/server/mail/errors";
import { finishLink } from "@/server/mail/google/link";
import { googleLinkable, oauthBySlug } from "@/server/providers/registry";
import { emitAccounts } from "@/server/sync";

export const runtime = "nodejs";

/** Where the provider sends the browser back: checks the state, stores the account, reports `?connect=<result>`. */
export async function GET(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider: slug } = await params;
  const provider = oauthBySlug(slug);
  if (!provider) return NextResponse.json({ error: "Unknown provider" }, { status: 404 });

  const url = new URL(request.url);
  const home = new URL("/", url.origin);
  home.searchParams.set("via", slug);
  const cookieStore = await cookies();
  const prefix = signInCookie(slug, "");
  const kept = cookieStore.getAll().filter((c) => c.name.startsWith(prefix));
  const secrets = Object.fromEntries(kept.map((c) => [c.name.slice(prefix.length), c.value]));
  const { state: expected, link, ...rest } = secrets;

  const finish = (result: string) => {
    home.searchParams.set("connect", result);
    const response = NextResponse.redirect(home);
    for (const cookie of kept) response.cookies.delete(cookie.name);
    return response;
  };

  // The optional Google sign-in of a Gmail-over-IMAP account (GET /api/google-link) shares this
  // callback, the one Google knows: it adds to that account instead of connecting one.
  if (slug === "google" && link) {
    const linked = (result: string) => {
      const response = NextResponse.redirect(new URL(`/?google=${result}`, url.origin));
      for (const cookie of kept) response.cookies.delete(cookie.name);
      return response;
    };
    const account = getAccount(link);
    if (!account || !googleLinkable(account)) return linked("failed");
    if (url.searchParams.get("error")) return linked("cancelled");
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state || !expected || state !== expected) return linked("invalid_state");
    try {
      const result = await finishLink({ accountId: account.id, code, origin: url.origin });
      if (result === "ok") {
        await refreshAccountPhoto(getAccount(account.id)!).catch(() => {});
        emitAccounts();
      }
      return linked(result);
    } catch (err) {
      console.error("Google sign-in for the extras failed:", err instanceof Error ? err.message : err);
      return linked(err instanceof SignInError ? err.reason : "failed");
    }
  }

  const error = url.searchParams.get("error");
  if (error) {
    const description = url.searchParams.get("error_description") ?? "";
    if (description) console.error(`${provider.auth.slug} sign-in returned:`, error, description.split("\n")[0]);
    return finish(provider.auth.errorReason(error, description));
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || !expected || state !== expected) return finish("invalid_state");

  try {
    const signedIn = await provider.auth.finish({ code, origin: url.origin, secrets: rest });
    // The same address connected through another provider stays as it is: tokens are never mixed.
    const account = connectAccount(provider, signedIn);
    if (!account) return finish("other_provider");
    await provider.auth.connected?.(account);
    return finish("ok");
  } catch (err) {
    if (err instanceof SignInError) return finish(err.reason);
    console.error(`${provider.auth.slug} connection failed:`, err instanceof Error ? err.message : err);
    return finish("failed");
  }
}
