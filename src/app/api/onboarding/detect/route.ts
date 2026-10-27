import { NextResponse } from "next/server";
import { mxHosts } from "@/server/dns";
import { oauthBySlug, passwordBySlug } from "@/server/providers/registry";

export const runtime = "nodejs";

export type DetectedProvider = "google" | "microsoft" | "icloud" | "yahoo" | "fastmail" | "imap";

const DOMAINS: Record<string, DetectedProvider> = {
  "gmail.com": "google",
  "googlemail.com": "google",
  "outlook.com": "microsoft",
  "hotmail.com": "microsoft",
  "live.com": "microsoft",
  "msn.com": "microsoft",
  "icloud.com": "icloud",
  "me.com": "icloud",
  "mac.com": "icloud",
  "yahoo.com": "yahoo",
  "ymail.com": "yahoo",
  "fastmail.com": "fastmail",
};

const MX_HINTS: [RegExp, DetectedProvider][] = [
  [/google\.com$|googlemail\.com$/i, "google"],
  [/outlook\.com$|protection\.outlook\.com$/i, "microsoft"],
  [/icloud\.com$/i, "icloud"],
  [/yahoodns\.net$/i, "yahoo"],
  [/messagingengine\.com$/i, "fastmail"],
];

export async function GET(request: Request) {
  const email = new URL(request.url).searchParams.get("email")?.trim().toLowerCase() ?? "";
  const domain = email.split("@")[1];
  if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  let provider: DetectedProvider = DOMAINS[domain] ?? "imap";
  let workspace = false;
  if (!DOMAINS[domain]) {
    // Custom domain: the MX records reveal who hosts the mailbox.
    try {
      const hosts = await mxHosts(domain);
      const hit = MX_HINTS.find(([pattern]) => hosts.some((host) => pattern.test(host)));
      if (hit) {
        provider = hit[1];
        workspace = provider === "google" || provider === "microsoft";
      }
    } catch {
      // No MX or DNS failure: fall back to generic IMAP.
    }
  }

  // Everything but Microsoft signs in with an app password (IMAP), Gmail and Workspace included
  // (Gmail mode, no CASA). Google sign-in (the Gmail API) stays for Kite's test users only.
  const oauth = provider === "microsoft";
  const password = oauth ? null : await passwordBySlug("imap")?.auth.hint(email).catch(() => null);
  return NextResponse.json({
    provider,
    workspace,
    domain,
    supported: oauth || !!password,
    password: password ?? null,
    googleConfigured: !!oauthBySlug("google")?.auth.configured(),
    microsoftConfigured: !!oauthBySlug("microsoft")?.auth.configured(),
  });
}
