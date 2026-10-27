import "server-only";

import { mxHosts, srvRecords } from "../../dns";
import { SignInError } from "../../mail/errors";
import { unlink } from "../../mail/google/link";
import type { MailServers, PasswordAuth, PasswordSignIn } from "../../mail/provider";
import { logSent } from "../../privacy-log";
import { closeConnection, loginRefused, makeClient } from "./client";
import { smtpTransport } from "./compose";
import { forgetFolders } from "./folders";
import { forgetMirror } from "./mirror";
import { presetFor, presetForMx, type Preset } from "./presets";
import { forgetServers, saveServers } from "./servers";

// Signing in to an IMAP account: the address and an app password. Kite finds the servers (a known
// service by domain or MX, else Thunderbird's public settings list, which is sent only the domain,
// else the usual names), logs in to IMAP and SMTP with them, and only then keeps them, the password
// sealed. Every failure is explained in one plain sentence.

type Candidate = { servers: MailServers; preset: Preset | null };

const AUTOCONFIG = "https://autoconfig.thunderbird.net/v1.1/";

/** Server settings from Thunderbird's list for a domain (imap + smtp), or null. */
async function autoconfig(domain: string): Promise<MailServers | null> {
  try {
    logSent("setup", "Thunderbird autoconfig", "Looked up mail servers", domain);
    const res = await fetch(`${AUTOCONFIG}${encodeURIComponent(domain)}`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const xml = await res.text();
    const server = (type: string) => {
      const block = xml.match(new RegExp(`<(incoming|outgoing)Server type="${type}">([\\s\\S]*?)</\\1Server>`))?.[2];
      if (!block) return null;
      const tag = (name: string) => block.match(new RegExp(`<${name}>([^<]+)</${name}>`))?.[1]?.trim();
      const host = tag("hostname");
      const port = Number(tag("port"));
      if (!host || !port || host.includes("%")) return null;
      return { host, port, secure: tag("socketType") === "SSL" };
    };
    const imap = server("imap");
    const smtp = server("smtp");
    return imap && smtp ? { imap, smtp } : null;
  } catch {
    return null;
  }
}

/**
 * Servers the domain publishes itself (RFC 6186, plus RFC 8314's implicit TLS records): IMAPS / IMAP
 * and submissions / submission. Only the domain's DNS names are looked up. Null unless both are there.
 */
async function srv(domain: string): Promise<MailServers | null> {
  const first = async (secure: string, starttls: string) => {
    const [tls, plain] = await Promise.all([srvRecords(`_${secure}._tcp.${domain}`), srvRecords(`_${starttls}._tcp.${domain}`)]);
    if (tls[0]) return { ...tls[0], secure: true };
    if (plain[0]) return { ...plain[0], secure: false };
    return null;
  };
  try {
    const [imap, smtp] = await Promise.all([first("imaps", "imap"), first("submissions", "submission")]);
    return imap && smtp ? { imap, smtp } : null;
  } catch {
    return null;
  }
}

/** Where an address's mail might live, most likely first. */
async function candidates(email: string): Promise<Candidate[]> {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  const known = presetFor(email);
  if (known) return [{ servers: known.servers, preset: known }];
  const viaMx = await mxHosts(domain).then(presetForMx, () => null);
  if (viaMx) return [{ servers: viaMx.servers, preset: viaMx }];
  const [published, found] = await Promise.all([srv(domain), autoconfig(domain)]);
  const guesses: MailServers[] = ["imap", "mail"].map((prefix) => ({
    imap: { host: `${prefix}.${domain}`, port: 993, secure: true },
    smtp: { host: `${prefix === "imap" ? "smtp" : "mail"}.${domain}`, port: 465, secure: true },
  }));
  return [...(published ? [published] : []), ...(found ? [found] : []), ...guesses].map((servers) => ({ servers, preset: null }));
}

type ImapTry = { result: "ok" | "gmail" | "unreachable" } | { result: "refused"; text: string };

/**
 * Tries to log in to IMAP. "refused": the server said no to the password (with its words, for
 * Gmail's cases); "unreachable": no server answered; "gmail": it worked and the server speaks Gmail's
 * extensions (Gmail and Workspace on any domain).
 */
async function tryImap(servers: MailServers, user: string, pass: string): Promise<ImapTry> {
  const client = makeClient(servers, user, pass);
  client.on("error", () => {});
  try {
    await client.connect();
    const gmail = client.capabilities.has("X-GM-EXT-1");
    await client.logout().catch(() => client.close());
    return { result: gmail ? "gmail" : "ok" };
  } catch (error) {
    client.close();
    if (!loginRefused(error)) return { result: "unreachable" };
    const e = error as { response?: unknown; responseText?: unknown; serverResponseCode?: unknown };
    return { result: "refused", text: [e.serverResponseCode, e.response, e.responseText].filter((t) => typeof t === "string").join(" ") };
  }
}

/** SMTP on port 465 (TLS) or 587 (STARTTLS): tries what was given, then the other one. */
async function trySmtp(servers: MailServers, user: string, pass: string): Promise<{ ok: true; smtp: MailServers["smtp"] } | { ok: false; refused: boolean; text: string }> {
  const options = [servers.smtp, { host: servers.smtp.host, port: servers.smtp.port === 465 ? 587 : 465, secure: servers.smtp.port !== 465 }];
  let refused = false;
  let text = "";
  for (const smtp of options) {
    try {
      await smtpTransport({ ...servers, smtp }, user, pass).verify();
      return { ok: true, smtp };
    } catch (error) {
      const e = error as { code?: string; response?: unknown };
      if (e.code === "EAUTH") {
        refused = true;
        if (typeof e.response === "string") text = e.response;
      }
    }
  }
  return { ok: false, refused, text };
}

/** Gmail's servers (any domain), where a refusal is explained by Gmail's own wording. */
const isGmail = (servers: MailServers, preset: Preset | null) => preset?.id === "gmail" || /(^|\.)gmail\.com$/i.test(servers.imap.host);

/**
 * What Gmail's refusal means, from its IMAP or SMTP wording: IMAP turned off (a Workspace admin's
 * switch; personal Gmail can't turn it off any more), a sign-in in the browser first, the normal
 * password instead of an app password, or an app password Google doesn't know (wrong, revoked, or
 * made before 2-Step Verification was turned off, which deletes them all).
 */
export function gmailRefusal(text: string, email: string): SignInError {
  const work = !/@(gmail|googlemail)\.com$/i.test(email);
  if (/not enabled for IMAP|IMAP (access )?is disabled|IMAP access.*disabled/i.test(text)) {
    return new SignInError(
      "failed",
      work
        ? "IMAP is turned off for this account, so mail apps can't read it. Your Google Workspace admin controls this: ask them to allow IMAP for you, then try again."
        : "IMAP is turned off for this account. Turn it on in Gmail's settings (Forwarding and POP/IMAP), then try again.",
      "imap",
    );
  }
  if (/web ?login required|log ?in via your web browser|WebLoginRequired|5\.7\.14/i.test(text)) {
    return new SignInError("failed", "Google wants you to sign in once in your browser first. Open Gmail, sign in, then try again here.", "browser");
  }
  if (/application-specific password required|5\.7\.9/i.test(text)) {
    return new SignInError("failed", "That's your normal Google password. Mail apps need an app password: make one in step 2 and paste that instead.", "app_password");
  }
  return new SignInError(
    "failed",
    work
      ? "Google didn't accept that app password. Make a new one in step 2 and paste it right away. If Google says app passwords aren't available, your admin has turned them off: ask them to allow app passwords."
      : "Google didn't accept that app password. Make a new one in step 2 and paste it right away. App passwords stop working when 2-Step Verification is turned off.",
    "app_password",
  );
}

function passwordAdvice(preset: Preset | null) {
  return preset
    ? `${preset.name} didn't accept that password. Use an ${preset.passwordName} (made in your ${preset.name} account settings), not your normal password.`
    : "The server didn't accept that address and password. Many services need an app password for mail apps: check your account's security settings.";
}

export const imapAuth: PasswordAuth = {
  kind: "password",
  slug: "imap",
  async signIn(input: PasswordSignIn) {
    const email = input.email.trim().toLowerCase();
    // Gmail shows app passwords in groups of four ("abcd efgh ijkl mnop"); they're the letters alone.
    const password = /^[a-z]{4}(\s*[a-z]{4}){3}$/i.test(input.password.trim()) ? input.password.replace(/\s+/g, "") : input.password;
    const list: Candidate[] = input.servers ? [{ servers: input.servers, preset: presetFor(email) }] : await candidates(email);
    let refusedBy: Preset | null | undefined;
    for (const { servers, preset } of list) {
      const users = [servers.username || email, ...(preset?.localPartLogin && !servers.username ? [email.split("@")[0]] : [])];
      for (const user of users) {
        const { result: imap, ...tried } = await tryImap(servers, user, password);
        if (imap === "unreachable") break;
        if (imap === "refused") {
          if (isGmail(servers, preset)) throw gmailRefusal("text" in tried ? tried.text : "", email);
          refusedBy = preset;
          continue;
        }
        const smtp = await trySmtp(servers, user, password);
        if (!smtp.ok) {
          if (smtp.refused && imap === "gmail") throw gmailRefusal(smtp.text, email);
          throw new SignInError(
            "failed",
            smtp.refused
              ? `Kite could read your mail, but the sending server (${servers.smtp.host}) refused the password.`
              : `Kite could read your mail, but couldn't reach the sending server (${servers.smtp.host}). Check its settings below.`,
            "servers",
          );
        }
        const chosen: MailServers = { imap: servers.imap, smtp: smtp.smtp, username: user };
        // Gmail mode (gmail.ts) follows the server, so a Workspace domain Kite didn't recognise still gets it.
        const kept = imap === "gmail" ? "gmail" : (preset?.id ?? null);
        return {
          email,
          name: input.name?.trim() ?? "",
          save(accountId: string) {
            saveServers(accountId, chosen, password, kept);
            // A new password: the old connection (and its folder list) goes.
            void closeConnection(accountId);
            forgetFolders(accountId);
          },
        };
      }
    }
    if (refusedBy !== undefined) throw new SignInError("failed", passwordAdvice(refusedBy));
    const domain = email.split("@")[1] ?? "this address";
    throw new SignInError(
      "failed",
      input.servers ? `Kite couldn't reach ${input.servers.imap.host}. Check the server name and port.` : `Kite couldn't find the mail servers for ${domain}. Enter them below.`,
      "servers",
    );
  },
  async hint(email) {
    const domain = email.split("@")[1]?.toLowerCase() ?? "";
    const preset = presetFor(email) ?? (domain ? await mxHosts(domain).then(presetForMx, () => null) : null);
    return { service: preset?.name ?? null, passwordName: preset?.passwordName ?? "app password", helpUrl: preset?.appPasswordUrl ?? null, preset: preset?.id ?? null };
  },
  async revoke(accountId) {
    // The optional Google sign-in (Gmail mode's calendar and photos) goes with the account.
    await unlink(accountId);
    await closeConnection(accountId);
    forgetFolders(accountId);
    forgetServers(accountId);
    forgetMirror(accountId);
  },
};
