import "server-only";

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { listAccounts, setAccountPicture, type AccountRow } from "./db";
import { txtRecords } from "./dns";
import { providerFor, providers } from "./providers/registry";
import { getPreferences } from "./settings";
import { dataDir } from "./paths";
import { countSent } from "./privacy-log";

// Sender pictures, resolved on the server and cached on disk so lookups happen once
// per sender and never from the browser. Order: your own accounts' profile photos (from their
// provider), photos from your Google contacts (opt-in), then for company senders only (and only
// with privacy.webPictures on): the brand's BIMI logo, a Gravatar, the company's site icon.
// Lookups are counted in the privacy log.

const CACHE_DIR = dataDir("avatars");
const HIT_TTL = 14 * 86_400_000;
const MISS_TTL = 3 * 86_400_000;
const MAX_BYTES = 512 * 1024;

/** Free mail providers: the domain says nothing about who sent it. */
export const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "yahoo.com", "ymail.com", "icloud.com", "me.com", "mac.com", "aol.com", "proton.me",
  "protonmail.com", "pm.me", "gmx.com", "gmx.net", "yandex.com", "mail.com", "fastmail.com",
  "zoho.com", "hey.com", "tutanota.com", "duck.com",
]);

const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

type Avatar = { body: Buffer; contentType: string };

/** notifications@account.netflix.com -> netflix.com; info@shop.co.za stays shop.co.za. */
function registrableDomain(domain: string) {
  const labels = domain.split(".");
  const keep = labels.length > 2 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

async function fetchImage(url: string, accept: RegExp, service?: string): Promise<Avatar | null> {
  if (service) countSent("picture", service);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(4000), redirect: "follow" });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
    if (!accept.test(contentType)) return null;
    const body = Buffer.from(await res.arrayBuffer());
    if (!body.length || body.length > MAX_BYTES) return null;
    return { body, contentType };
  } catch {
    return null;
  }
}

async function bimiLogo(domain: string): Promise<Avatar | null> {
  for (const name of new Set([domain, registrableDomain(domain)])) {
    const record = (await txtRecords(`default._bimi.${name}`).catch(() => [])).find((r) => /^v=BIMI1/i.test(r));
    const url = record?.match(/(?:^|;)\s*l=([^;\s]+)/i)?.[1];
    if (url?.startsWith("https://")) {
      const logo = await fetchImage(url, /^image\/svg\+xml$|^text\/xml$|^application\/xml$/, "Brand logos (BIMI)");
      if (logo) return { ...logo, contentType: "image/svg+xml" };
    }
  }
  return null;
}

function gravatar(email: string) {
  const hash = createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
  return fetchImage(`https://gravatar.com/avatar/${hash}?s=128&d=404`, /^image\//, "Gravatar");
}

function siteIcon(domain: string) {
  return fetchImage(`https://icons.duckduckgo.com/ip3/${registrableDomain(domain)}.ico`, /^image\//, "DuckDuckGo site icons");
}

/** The photo types providers serve, told from the first bytes (a provider's word isn't trusted). */
function imageType(body: Buffer) {
  if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return "image/jpeg";
  if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (body.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (body.subarray(0, 4).toString("latin1") === "RIFF" && body.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

/** Asks the account's provider for its photo and keeps the account's `picture` version in step with it. */
async function providerPhoto(account: AccountRow): Promise<Avatar | null> {
  const body = (await providerFor(account).picture?.(account)) ?? null;
  const contentType = body?.length && body.length <= MAX_BYTES ? imageType(body) : null;
  const version = body && contentType ? createHash("sha256").update(body).digest("hex").slice(0, 10) : "";
  if (version !== account.picture) setAccountPicture(account.id, version);
  return body && contentType ? { body, contentType } : null;
}

/** Looks the account's photo up again now (a new sign-in); throws when the provider can't be reached. */
export function refreshAccountPhoto(account: AccountRow) {
  return cached(`account:${account.id}`, () => providerPhoto(account), true);
}

/** Your own account's photo, from its provider (never a third party). */
function accountPhoto(email: string) {
  const account = listAccounts().find((a) => a.email.toLowerCase() === email.toLowerCase());
  if (!account?.picture) return null;
  return cached(`account:${account.id}`, () => providerPhoto(account).catch(() => undefined));
}

/** Opt-in: the photo in your contacts at the provider. Failures that may pass (quota, offline) aren't remembered as misses. */
function contactPhoto(email: string) {
  const sources = providers().flatMap((p) => (p.contactPhotos?.available() ? [p.contactPhotos] : []));
  if (!getPreferences().senderPhotos || !sources.length) return null;
  return cached(`google:${email.toLowerCase()}`, async () => {
    try {
      let url: string | null = null;
      for (const source of sources) if (!url) url = await source.url(email);
      return url ? ((await fetchImage(url, /^image\//)) ?? undefined) : null;
    } catch {
      return undefined;
    }
  });
}

type Meta = { contentType: string | null; fetchedAt: number };

const inflight = new Map<string, Promise<Avatar | null>>();

/**
 * Looks a picture up once and keeps it (or the miss) on disk. `resolve` returns undefined
 * when the lookup failed for a passing reason: nothing is recorded and a stale copy is
 * served if there is one, so pictures keep working offline.
 */
function cached(key: string, resolve: () => Promise<Avatar | null | undefined>, refresh = false): Promise<Avatar | null> {
  const running = inflight.get(key);
  if (running) return running;
  const run = (async () => {
    mkdirSync(CACHE_DIR, { recursive: true });
    const file = path.join(CACHE_DIR, createHash("sha256").update(key).digest("hex"));
    let stale: Avatar | null = null;
    try {
      const meta = JSON.parse(await readFile(`${file}.json`, "utf-8")) as Meta;
      const hit = meta.contentType ? { body: await readFile(file), contentType: meta.contentType } : null;
      if (!refresh && Date.now() - meta.fetchedAt < (hit ? HIT_TTL : MISS_TTL)) return hit;
      stale = hit;
    } catch {
      // Not cached yet.
    }
    const avatar = await resolve();
    if (avatar === undefined) return stale;
    if (avatar) await writeFile(file, avatar.body);
    await writeFile(`${file}.json`, JSON.stringify({ contentType: avatar?.contentType ?? null, fetchedAt: Date.now() } satisfies Meta));
    return avatar;
  })().finally(() => inflight.delete(key));
  inflight.set(key, run);
  return run;
}

export async function senderAvatar(email: string): Promise<Avatar | null> {
  const domain = email.split("@")[1]?.toLowerCase();
  if (!domain) return null;
  const personal = PERSONAL_DOMAINS.has(domain);

  const own = await accountPhoto(email);
  if (own) return own;
  const contact = await contactPhoto(email);
  if (contact) return contact;
  // Web pictures only for companies: a private person's address (even hashed) never leaves for a
  // picture, and the setting turns web lookups off entirely.
  if (personal || !getPreferences().privacy.webPictures) return null;
  const brand = await cached(`bimi:${registrableDomain(domain)}`, () => bimiLogo(domain));
  if (brand) return brand;
  const photo = await cached(`gravatar:${email.toLowerCase()}`, () => gravatar(email));
  if (photo) return photo;
  return cached(`icon:${registrableDomain(domain)}`, () => siteIcon(domain));
}
