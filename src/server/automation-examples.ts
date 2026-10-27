import "server-only";

import type { AutomationExample, AutomationSender } from "@/lib/automations/pick";
import { listAccounts } from "./db";
import { listContacts } from "./contacts";
import { emailOf, storedThread } from "./rules";
import { searchThreads, senderSummaries } from "./store";

// The automation wizard's material, from the local copy: who writes to you (or who you write to,
// for automations on mail you send), and real emails as Read sees them (the text the fields are
// read from). Read-only; nothing leaves the computer.

/** Everyone who has written to you, most emails first. */
export function automationSenders(limit = 400): AutomationSender[] {
  return senderSummaries("all")
    .filter((s) => s.emails > 0)
    .sort((a, b) => b.emails - a.emails || b.lastDate.localeCompare(a.lastDate))
    .slice(0, limit)
    .map((s) => ({ email: s.email, name: s.name, emails: s.emails, lastDate: s.lastDate }));
}

/** Everyone you've written to, most emails first (`emails` counts what you sent them). */
export function automationRecipients(limit = 400): AutomationSender[] {
  const own = new Set(listAccounts().map((a) => a.email.toLowerCase()));
  return listContacts()
    .filter((c) => c.sent > 0 && !own.has(c.email))
    .sort((a, b) => b.sent - a.sent || b.last.localeCompare(a.last))
    .slice(0, limit)
    .map((c) => ({ email: c.email, name: c.name, emails: c.sent, lastDate: c.last }));
}

/**
 * The newest emails from `senders` (any sender when empty) that match `query`. With `sent`, your
 * own mail to them instead, read as an automation on mail you send reads it.
 */
export function automationExamples({ senders, query, sent = false, limit = 10 }: { senders: string[]; query: string; sent?: boolean; limit?: number }): AutomationExample[] {
  const me = new Map(listAccounts().map((a) => [a.id, a.email.toLowerCase()]));
  const words = `${sent ? "in:sent " : ""}${query}`.trim();
  const searches = senders.length ? senders.slice(0, 20).map((s) => `${sent ? "to" : "from"}:${s} ${words}`.trim()) : query.trim() ? [words] : [];
  const seen = new Set<string>();
  const found = searches
    .flatMap((q) => searchThreads(q, "all", limit))
    .filter((t) => !seen.has(t.id) && seen.add(t.id))
    .sort((a, b) => (b.messages.at(-1)?.date ?? "").localeCompare(a.messages.at(-1)?.date ?? ""))
    .slice(0, limit);
  return found.flatMap((t) => {
    const email = emailOf(storedThread(t), me.get(t.accountId) ?? "", undefined, sent);
    if (!email) return [];
    const { facts } = email;
    return [
      {
        threadId: t.id,
        accountId: t.accountId,
        subject: facts.subject,
        sender: facts.senderName || facts.senderEmail,
        senderEmail: facts.senderEmail,
        date: facts.date,
        text: facts.text.slice(0, 6000),
      },
    ];
  });
}
