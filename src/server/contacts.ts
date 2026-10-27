import "server-only";

import type { Recipient } from "@/lib/mail/compose";
import { realName, type ContactEntry } from "@/lib/mail/contacts";
import type { Contact } from "@/lib/mail/types";
import { isAutomated, type Acquaintance } from "@/lib/replies";
import { getDb, listAccounts } from "./db";

// Address autocomplete from the local copy: everyone who has written to you or been
// written to. People you've sent mail to rank first, then by how often they appear.

type Entry = ContactEntry;

const CACHE_MS = 2 * 60_000;
type Talk = { started: number; answered: number };
type Built = { entries: Entry[]; talks: Map<string, Talk>; ownNames: Set<string> };
const store = globalThis as unknown as {
  kiteContacts?: Built & { at: number; byEmail: Map<string, Entry> };
};

function build(): Built {
  const own = new Set(listAccounts().map((a) => a.email.toLowerCase()));
  const rows = getDb()
    .prepare(
      `SELECT t.id AS thread, json_extract(m.value, '$.from') AS sender, json_extract(m.value, '$.to') AS recipients,
         json_extract(m.value, '$.cc') AS cc, json_extract(m.value, '$.date') AS date, json_extract(m.value, '$.draft') AS draft
       FROM threads t, json_each(t.list_data, '$.messages') m`,
    )
    .all() as { thread: string; sender: string | null; recipients: string | null; cc: string | null; date: string | null; draft: number | null }[];

  // Per conversation: who wrote in it, and who of them you wrote after (reply tracking's history).
  const talks = new Map<string, Talk>();
  const ownNames = new Set<string>();
  let thread = "";
  let wrote = new Set<string>();
  let answered = new Set<string>();
  const closeThread = () => {
    for (const email of wrote) {
      const talk = talks.get(email) ?? { started: 0, answered: 0 };
      talk.started++;
      if (answered.has(email)) talk.answered++;
      talks.set(email, talk);
    }
    wrote = new Set();
    answered = new Set();
  };
  for (const row of rows) {
    if (row.thread !== thread) {
      closeThread();
      thread = row.thread;
    }
    if (row.draft || !row.sender) continue;
    const from = JSON.parse(row.sender) as Contact;
    const email = from.email?.trim().toLowerCase();
    if (!email) continue;
    if (own.has(email)) {
      wrote.forEach((e) => answered.add(e));
      if (from.name?.trim() && from.name !== "You") ownNames.add(from.name.trim().toLowerCase());
    } else wrote.add(email);
  }
  closeThread();

  const people = new Map<string, Entry>();
  const note = (contact: Contact, date: string, sent: boolean) => {
    const email = contact.email?.trim().toLowerCase();
    if (!email || own.has(email) || !email.includes("@")) return;
    const entry = people.get(email) ?? { email, name: "", sent: 0, seen: 0, last: "" };
    entry.name ||= realName(contact);
    if (sent) entry.sent++;
    else entry.seen++;
    if (date > entry.last) entry.last = date;
    people.set(email, entry);
  };
  for (const row of rows) {
    const from = row.sender ? (JSON.parse(row.sender) as Contact) : null;
    const date = row.date ?? "";
    const others = [...(row.recipients ? (JSON.parse(row.recipients) as Contact[]) : []), ...(row.cc ? (JSON.parse(row.cc) as Contact[]) : [])];
    if (from && own.has(from.email.toLowerCase())) others.forEach((c) => note(c, date, true));
    else if (from) note(from, date, false);
  }
  return { entries: [...people.values()], talks, ownNames };
}

function cached() {
  if (!store.kiteContacts || Date.now() - store.kiteContacts.at > CACHE_MS) {
    const built = build();
    store.kiteContacts = { ...built, at: Date.now(), byEmail: new Map(built.entries.map((e) => [e.email, e])) };
  }
  return store.kiteContacts;
}

/** The names you send under, from your own sent mail (lower-cased). */
export const ownNames = () => cached().ownNames;

const entries = () => cached().entries;

/** Everyone your mail knows (the Contacts view): copies, so the cache isn't changed by callers. */
export function listContacts(): ContactEntry[] {
  return entries().map((e) => ({ ...e }));
}

/** Messages and conversations between you and this address, from the local copy (reply tracking). */
export function acquaintance(email: string): Acquaintance {
  const key = email.trim().toLowerCase();
  const { byEmail, talks } = cached();
  const entry = byEmail.get(key);
  const talk = talks.get(key);
  return { sent: entry?.sent ?? 0, seen: entry?.seen ?? 0, started: talk?.started ?? 0, answered: talk?.answered ?? 0 };
}

/**
 * People whose name or address has `query`. `role` is a search's `from:` or `to:`: only people
 * who have written to you (from) or you have written to (to), ranked by how often; without it,
 * compose's ranking (people you write to first).
 */
export function searchContacts(query: string, limit = 8, role?: "from" | "to"): Recipient[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored = entries().flatMap((e) => {
    const name = e.name.toLowerCase();
    const prefix = e.email.startsWith(q) || name.startsWith(q) || name.split(/\s+/).some((w) => w.startsWith(q));
    if (!prefix && !e.email.includes(q) && !name.includes(q)) return [];
    if ((role === "from" && !e.seen) || (role === "to" && !e.sent)) return [];
    const weight = role === "from" ? e.seen * 6 + e.sent : role === "to" ? e.sent * 6 + e.seen : e.sent * 6 + e.seen;
    // Automated senders are what people search their mail for, so they only sink when writing to someone.
    const score = (prefix ? 1000 : 0) + weight - (!role && isAutomated(e.email) ? 500 : 0);
    return [{ e, score }];
  });
  return scored
    .sort((a, b) => b.score - a.score || b.e.last.localeCompare(a.e.last))
    .slice(0, limit)
    .map(({ e }) => (e.name ? { name: e.name, email: e.email } : { email: e.email }));
}
