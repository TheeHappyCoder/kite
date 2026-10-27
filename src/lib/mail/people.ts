import type { Attachment, Contact, Thread } from "./types";

// One person as your mail knows them: conversations together, files they shared, and how
// quickly each side usually replies. Plain derived data from the threads (no AI), computed the
// same way from the local store (server) and from demo threads (client).

type PersonThread = { id: string; accountId: string; subject: string; date: string; count: number };
type PersonFile = {
  accountId: string;
  /** Who sent it (for Fill & sign's "sign like last time"). */
  from?: Contact;
  threadId: string;
  /** Null for demo mail (nothing to download). */
  messageId: string | null;
  subject: string;
  date: string;
  attachment: Attachment;
};

export type PersonSummary = {
  contact: Contact;
  conversations: number;
  /** Messages they sent you and you sent them. */
  received: number;
  sent: number;
  firstDate: string | null;
  lastDate: string | null;
  recent: PersonThread[];
  files: PersonFile[];
  /** Median reply delays in minutes, with how many replies they're based on. */
  youReply: { minutes: number; samples: number } | null;
  theyReply: { minutes: number; samples: number } | null;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** `me` are your own addresses; a message from "You" (demo) counts as yours. */
export function summarizePerson(threads: Thread[], email: string, me: string[], options: { recent?: number; files?: number } = {}): PersonSummary {
  const who = email.toLowerCase();
  const mine = new Set(me.map((m) => m.toLowerCase()));
  const isMe = (c: Contact) => mine.has(c.email.toLowerCase()) || c.name === "You";
  const isThem = (c: Contact) => c.email.toLowerCase() === who;
  const youReply: number[] = [];
  const theyReply: number[] = [];
  const files: PersonFile[] = [];
  const together: PersonThread[] = [];
  let received = 0;
  let sent = 0;
  let name = "";
  let nameDate = "";

  for (const thread of threads) {
    const messages = [...thread.messages].filter((m) => !m.draft).sort((a, b) => a.date.localeCompare(b.date));
    const involved = messages.filter((m) => isThem(m.from) || (isMe(m.from) && [...m.to, ...(m.cc ?? [])].some(isThem)));
    if (!involved.length) continue;
    together.push({ id: thread.id, accountId: thread.accountId, subject: thread.subject, date: involved[involved.length - 1].date, count: messages.length });
    messages.forEach((m, i) => {
      const next = messages[i + 1];
      if (isThem(m.from)) {
        received++;
        if (m.date > nameDate && m.from.name && m.from.name !== m.from.email) {
          name = m.from.name;
          nameDate = m.date;
        }
        for (const attachment of m.attachments ?? []) {
          if (!attachment.inline) {
            files.push({ accountId: thread.accountId, from: m.from, threadId: thread.id, messageId: thread.remoteId ? m.id : null, subject: thread.subject, date: m.date, attachment });
          }
        }
        if (next && isMe(next.from)) youReply.push((Date.parse(next.date) - Date.parse(m.date)) / 60_000);
      } else if (isMe(m.from) && [...m.to, ...(m.cc ?? [])].some(isThem)) {
        sent++;
        if (next && isThem(next.from)) theyReply.push((Date.parse(next.date) - Date.parse(m.date)) / 60_000);
      }
    });
  }

  together.sort((a, b) => b.date.localeCompare(a.date));
  files.sort((a, b) => b.date.localeCompare(a.date));
  const dates = together.map((t) => t.date);
  const stat = (values: number[]) => {
    const valid = values.filter((v) => v >= 0);
    return valid.length ? { minutes: Math.round(median(valid)), samples: valid.length } : null;
  };
  const firstDate = threads
    .flatMap((t) => t.messages.filter((m) => isThem(m.from) || [...m.to, ...(m.cc ?? [])].some(isThem)).map((m) => m.date))
    .sort()[0];
  return {
    contact: { name: name || email, email },
    conversations: together.length,
    received,
    sent,
    firstDate: firstDate ?? null,
    lastDate: dates[0] ?? null,
    recent: together.slice(0, options.recent ?? 5),
    files: files.slice(0, options.files ?? 6),
    youReply: stat(youReply),
    theyReply: stat(theyReply),
  };
}

/** "about 3 hours", "within minutes", "about 2 days". */
export function replyTime(minutes: number) {
  if (minutes < 15) return "within minutes";
  if (minutes < 90) return `in about ${Math.round(minutes / 15) * 15} minutes`;
  const hours = minutes / 60;
  if (hours < 36) return `in about ${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  const days = Math.round(hours / 24);
  return `in about ${days} day${days === 1 ? "" : "s"}`;
}

/** Everyone in a conversation other than you, the main correspondent first. */
export function participants(thread: Thread, me: string[]): Contact[] {
  const mine = new Set(me.map((m) => m.toLowerCase()));
  const seen = new Map<string, Contact>();
  for (const m of thread.messages) {
    for (const c of [m.from, ...m.to, ...(m.cc ?? [])]) {
      const email = c.email.toLowerCase();
      if (!email || mine.has(email) || c.name === "You" || seen.has(email)) continue;
      seen.set(email, c);
    }
  }
  return [...seen.values()];
}
