import "server-only";

import type { MailServers } from "../../mail/provider";

// Mail services Kite knows the servers of, so signing in is only the address and an app password.
// Each needs an app password (made in the service's account settings) because they refuse a
// normal password from mail apps once two-step sign-in is on.

export type Preset = {
  id: string;
  name: string;
  domains: string[];
  servers: MailServers;
  /** Where to make an app password. */
  appPasswordUrl: string;
  /** What the service calls its password for apps, for the sign-in form and errors. */
  passwordName: string;
  /** Try the address's local part as the login name if the full address is refused. */
  localPartLogin?: boolean;
};

const tls = (host: string, port = 993) => ({ host, port, secure: true });
const smtp = (host: string, port: number) => ({ host, port, secure: port === 465 });

const PRESETS: Preset[] = [
  {
    // Gmail and Google Workspace over IMAP (labels, threads and search through Gmail's extensions:
    // gmail.ts). The Gmail API provider stays for test users; public sign-ins come here, no CASA.
    id: "gmail",
    name: "Gmail",
    domains: ["gmail.com", "googlemail.com"],
    servers: { imap: tls("imap.gmail.com"), smtp: smtp("smtp.gmail.com", 465) },
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
    passwordName: "app password",
  },
  {
    id: "icloud",
    name: "iCloud Mail",
    domains: ["icloud.com", "me.com", "mac.com"],
    servers: { imap: tls("imap.mail.me.com"), smtp: smtp("smtp.mail.me.com", 587) },
    appPasswordUrl: "https://support.apple.com/en-us/102654",
    passwordName: "app-specific password",
    localPartLogin: true,
  },
  {
    id: "yahoo",
    name: "Yahoo Mail",
    domains: ["yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.co.za", "yahoo.fr", "yahoo.de", "yahoo.co.in"],
    servers: { imap: tls("imap.mail.yahoo.com"), smtp: smtp("smtp.mail.yahoo.com", 465) },
    appPasswordUrl: "https://help.yahoo.com/kb/SLN15241.html",
    passwordName: "app password",
  },
  {
    id: "aol",
    name: "AOL Mail",
    domains: ["aol.com", "aim.com"],
    servers: { imap: tls("imap.aol.com"), smtp: smtp("smtp.aol.com", 465) },
    appPasswordUrl: "https://help.aol.com/articles/Create-and-manage-app-password",
    passwordName: "app password",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    domains: ["fastmail.com", "fastmail.fm", "fastmail.net", "messagingengine.com"],
    servers: { imap: tls("imap.fastmail.com"), smtp: smtp("smtp.fastmail.com", 465) },
    appPasswordUrl: "https://www.fastmail.help/hc/en-us/articles/360058752854",
    passwordName: "app password",
  },
  {
    id: "zoho",
    name: "Zoho Mail",
    domains: ["zoho.com", "zohomail.com"],
    servers: { imap: tls("imap.zoho.com"), smtp: smtp("smtp.zoho.com", 465) },
    appPasswordUrl: "https://www.zoho.com/mail/help/adminconsole/two-factor-authentication.html",
    passwordName: "app-specific password",
  },
  {
    id: "gmx",
    name: "GMX",
    domains: ["gmx.com", "gmx.net", "gmx.de", "gmx.co.uk"],
    servers: { imap: tls("imap.gmx.com"), smtp: smtp("mail.gmx.com", 587) },
    appPasswordUrl: "https://support.gmx.com/security/2fa/application-specific-passwords.html",
    passwordName: "app password",
  },
];

export const presetById = (id: string | null | undefined) => PRESETS.find((p) => p.id === id) ?? null;

/** The service an address belongs to by its domain, or null for a custom domain. */
export function presetFor(email: string): Preset | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  return PRESETS.find((p) => p.domains.includes(domain)) ?? null;
}

/** A service hosting a custom domain, from its MX hosts (e.g. Fastmail's messagingengine.com). */
export function presetForMx(hosts: string[]): Preset | null {
  const hints: [RegExp, string][] = [
    [/(^|\.)google\.com$|googlemail\.com$/i, "gmail"],
    [/icloud\.com$/i, "icloud"],
    [/yahoodns\.net$/i, "yahoo"],
    [/messagingengine\.com$/i, "fastmail"],
    [/zoho\.(com|eu|in)$/i, "zoho"],
  ];
  const hit = hints.find(([pattern]) => hosts.some((host) => pattern.test(host.replace(/\.$/, ""))));
  return hit ? presetById(hit[1]) : null;
}
