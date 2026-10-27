import "server-only";

import type { AccountRow } from "../../db";
import type { ContactPhotos } from "../provider";
import { CONTACT_PHOTO_SCOPES, type GoogleAccess } from "./oauth";

// Sender photos from the user's Google contacts (opt-in), for any account with a Google sign-in
// that has the contacts scopes (the Gmail API provider's own, or a Gmail-over-IMAP account's
// optional one: ./link.ts). Only the address being looked up is sent, and only to Google, which
// already holds these contacts.

const API = "https://people.googleapis.com/v1";
const WARMUP_MS = 30 * 60_000;
/** Searches read a cache the warmup request refreshes; give it a moment before the first search. */
const WARMUP_SETTLE_MS = 1500;

type Endpoint = "people:searchContacts" | "otherContacts:search";
type Photo = { url?: string; default?: boolean; metadata?: { primary?: boolean } };
type Person = { emailAddresses?: { value?: string }[]; photos?: Photo[] };

/** A lookup that failed for a passing reason (rate limit, network, API off): don't remember it as a miss. */
class PeopleUnavailable extends Error {}

/** At most a few lookups at once (across every Google sign-in), so a screenful of new senders stays inside Google's per-minute quota. */
const MAX_CONCURRENT = 3;
let active = 0;
const queue: (() => void)[] = [];

async function limited<T>(fn: () => Promise<T>): Promise<T> {
  // A finished lookup hands its slot straight to the next one waiting.
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => queue.push(r));
  else active++;
  try {
    return await fn();
  } finally {
    const next = queue.shift();
    if (next) next();
    else active--;
  }
}

const warmups = new Map<string, { at: number; done: Promise<void> }>();

async function search(access: GoogleAccess, accountId: string, endpoint: Endpoint, query: string): Promise<Person[]> {
  const params = new URLSearchParams({ query, readMask: "emailAddresses,photos", pageSize: "10" });
  const res = await fetch(`${API}/${endpoint}?${params}`, {
    headers: { authorization: `Bearer ${await access.token(accountId)}` },
    signal: AbortSignal.timeout(6000),
  }).catch(() => null);
  if (!res?.ok) {
    if (res?.status === 403 && process.env.NODE_ENV !== "production") {
      console.warn("People API refused the lookup. Is the People API enabled for Kite's Google Cloud project?");
    }
    throw new PeopleUnavailable(`People API ${res?.status ?? "unreachable"}`);
  }
  const data = (await res.json()) as { results?: { person?: Person }[] };
  return (data.results ?? []).flatMap((r) => (r.person ? [r.person] : []));
}

function warm(access: GoogleAccess, accountId: string, endpoint: Endpoint) {
  const key = `${accountId}:${endpoint}`;
  const current = warmups.get(key);
  if (current && Date.now() - current.at < WARMUP_MS) return current.done;
  const done = search(access, accountId, endpoint, "")
    .then(() => new Promise<void>((r) => setTimeout(r, WARMUP_SETTLE_MS)))
    .catch((error) => {
      warmups.delete(key);
      throw error;
    });
  warmups.set(key, { at: Date.now(), done });
  return done;
}

/** A real photo for the address (Google's default silhouettes and letter tiles are skipped). */
function photoFor(people: Person[], email: string) {
  const person = people.find((p) => p.emailAddresses?.some((e) => e.value?.toLowerCase() === email));
  const photos = (person?.photos ?? []).filter((p) => p.url?.startsWith("https://") && !p.default);
  const photo = photos.find((p) => p.metadata?.primary) ?? photos[0];
  // Ask for a size that stays sharp on retina avatars.
  return photo?.url ? photo.url.replace(/=s\d+(-[a-z]+)?$/, "=s128$1") : null;
}

/**
 * Contact photos through `access`, searching your contacts and then "other contacts" (people
 * you've emailed) in every account of `accounts` whose sign-in allows it. `offered` says which
 * accounts have a Google sign-in at all.
 */
export function googleContactPhotos(access: GoogleAccess, accounts: () => AccountRow[], offered?: (accountId: string) => boolean): ContactPhotos {
  const allowed = () => accounts().filter((a) => access.granted(a.id, CONTACT_PHOTO_SCOPES));
  async function lookup(email: string) {
    const address = email.trim().toLowerCase();
    let failed: unknown = null;
    for (const account of allowed()) {
      for (const endpoint of ["people:searchContacts", "otherContacts:search"] as const) {
        try {
          await warm(access, account.id, endpoint);
          const url = photoFor(await search(access, account.id, endpoint, address), address);
          if (url) return url;
        } catch (error) {
          failed = error;
        }
      }
    }
    if (failed) throw failed instanceof PeopleUnavailable ? failed : new PeopleUnavailable(String(failed));
    return null;
  }
  return {
    ...(offered ? { offered } : {}),
    enabled: (accountId) => access.granted(accountId, CONTACT_PHOTO_SCOPES),
    available: () => allowed().length > 0,
    url: (email) => limited(() => lookup(email)),
  };
}
