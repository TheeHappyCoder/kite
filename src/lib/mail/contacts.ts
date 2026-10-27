import { isAutomated } from "../replies";
import type { Contact, Thread } from "./types";

/** Addresses that send receipts, alerts and account mail rather than write to you. */
const TRANSACTIONAL =
  /^(no-?reply|do-?not-?reply|notifications?|alerts?|billing|invoices?|receipts?|orders?|auto|mailer|bounces?|postmaster|updates?|security|accounts?|statements?|support|service|info|news(letters?)?|marketing|hello|team|digest)([@+._-]|$)/i;

/** Whether an address belongs to a machine rather than a person (the Contacts view's People list). */
const machineAddress = (email: string) => TRANSACTIONAL.test(email.trim()) || isAutomated(email);

// Contacts: everyone your mail knows, from the local copy (no provider address book). Each entry
// counts messages you sent them and ones they sent you, with the last time either happened. The
// server builds the same entries in SQL (server/contacts.ts); demo mode builds them here.

export type ContactEntry = {
  email: string;
  /** Their name as their mail writes it ("" when it never says). */
  name: string;
  /** Messages you sent them. */
  sent: number;
  /** Messages they sent you. */
  seen: number;
  /** The newest message either way. */
  last: string;
};

export type ContactFilter = "people" | "vip" | "everyone";
export type ContactSort = "frequent" | "name";

/** A name worth showing: not the address again, nor its local part. */
export const realName = (c: Contact) => (c.name && c.name !== c.email && c.name !== c.email.split("@")[0] && c.name !== "You" ? c.name : "");

/** Contacts from threads (demo mode): `own` are your addresses, lower-cased. */
export function contactsFrom(threads: Thread[], own: Set<string>): ContactEntry[] {
  const people = new Map<string, ContactEntry>();
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
  for (const thread of threads)
    for (const m of thread.messages) {
      if (m.draft) continue;
      const mine = own.has(m.from.email.toLowerCase()) || m.from.name === "You";
      if (mine) [...m.to, ...(m.cc ?? [])].forEach((c) => note(c, m.date, true));
      else note(m.from, m.date, false);
    }
  return [...people.values()];
}

/** A machine (receipts, alerts, newsletters) rather than a person you write to. */
const isMachine = (entry: ContactEntry) => machineAddress(entry.email) && entry.sent === 0;

/** What the list shows: filtered, searched (name or address) and sorted. `vip` says who's a VIP. */
export function shownContacts(
  entries: ContactEntry[],
  { filter, sort, query, vip }: { filter: ContactFilter; sort: ContactSort; query: string; vip: (email: string) => boolean },
) {
  const q = query.trim().toLowerCase();
  const list = entries.filter((e) => {
    if (filter === "vip" && !vip(e.email)) return false;
    if (filter === "people" && isMachine(e)) return false;
    return !q || e.email.includes(q) || e.name.toLowerCase().includes(q);
  });
  const label = (e: ContactEntry) => (e.name || e.email).toLowerCase();
  // Most in touch: what you write counts most (you chose to), then what they send, then the newest.
  const weight = (e: ContactEntry) => e.sent * 3 + e.seen;
  return list.sort((a, b) =>
    sort === "name" ? label(a).localeCompare(label(b)) : weight(b) - weight(a) || b.last.localeCompare(a.last),
  );
}

/** The letter a contact files under in A–Z ("#" for anything else). */
export function letterOf(entry: ContactEntry) {
  const first = (entry.name || entry.email).trim().charAt(0).toUpperCase();
  return /\p{L}/u.test(first) ? first : "#";
}
