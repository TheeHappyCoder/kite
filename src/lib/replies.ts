import { messagePreview } from "./mail/quotes";
import type { ThreadOverride } from "./mail/overrides";
import type { Contact, Message, Thread } from "./mail/types";

// Reply tracking, worked out from the local copy with plain rules (no AI): conversations you owe
// a reply ("To reply") and ones where you're waiting on someone ("Waiting on"). The lists only
// order and surface: nothing here moves, labels or sends mail. Done (until a new message arrives)
// and Dismiss (never track this conversation) live in thread_overrides. Who counts as someone you
// reply to is learned from your own mail (`replyStanding`): who you've written to and answered, who
// you never answer, and whose conversations you dismissed.

const DAY = 86_400_000;

/** Only conversations active in the last 30 days are tracked. */
export const REPLY_WINDOW_DAYS = 30;

/** Addresses nobody reads: never someone you owe a reply or are waiting on. */
const AUTOMATED =
  /^(no-?reply|do-?not-?reply|unsub(scribe)?|notifications?|mailer-daemon|bounces?|postmaster|alerts?|automated|auto-?confirm|news(letters?)?|marketing|updates?|billing|invoices?|receipts?|orders?)([@+._-]|$)/i;

export const isAutomated = (email: string) => AUTOMATED.test(email.trim());

/** A conversation the lists could hold, with what the store knows about it. */
export type ReplyCandidate = {
  thread: Thread;
  /** In the inbox (an archived conversation is one you've dealt with). */
  inbox: boolean;
  /** Mailing list or bulk mail: a List-Unsubscribe header, or a Promotions / Updates category. */
  bulk: boolean;
};

/**
 * How well you know someone, from the local copy: messages you sent them and ones they sent you,
 * conversations they wrote in (`started`) and the ones of those you answered (`answered`).
 */
export type Acquaintance = { sent: number; seen: number; started: number; answered: number };

/** A stranger who has written this many conversations you never answered is someone you don't reply to. */
export const IGNORED_AFTER = 3;

/** Words in a display name that mean a company, a desk or a mailing, not a person. */
const NOT_A_PERSON =
  /\b(team|support|from|via|the|admin|info|service|services|mail|news|customer|care|billing|accounts?|notifications?|alerts?|group|inc|ltd|llc|pty|co|bank|store|shop|hq|desk|office)\b/i;

/**
 * A person's own address: a name of two or more words, the address made from it ("Thandi Mokoena"
 * <thandi@…>), and no word of it in the domain (a name with the company in it is the company:
 * "Domainly Renewals" <renewals@domainly.com>).
 */
export function looksPersonal(contact: Contact) {
  const name = (contact.name ?? "").trim();
  if (!name || name.includes("@") || NOT_A_PERSON.test(name)) return false;
  const [local = "", domain = ""] = contact.email.toLowerCase().split("@");
  const words = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[^a-z\s.]/g, "")
    .split(/[\s.]+/)
    .filter(Boolean);
  if (words.length < 2) return false;
  const long = words.filter((w) => w.length >= 3);
  if (long.some((w) => domain.includes(w))) return false;
  return long.some((w) => local.replace(/[^a-z]/g, "").includes(w));
}

/**
 * Whether a message from `from` belongs in To reply, learned from your own history (no AI):
 * "known" when you've written to them or answered them before; "new" for a stranger who looks like
 * a person writing from their own address, until they've written IGNORED_AFTER conversations you
 * never answered or you've dismissed one of theirs; otherwise nothing (receipts, statements,
 * alerts, companies' mail: not things you answer).
 */
export function replyStanding(from: Contact, known: Acquaintance, dismissed: number): "known" | "new" | null {
  if (known.sent > 0 || known.answered > 0) return "known";
  if (dismissed > 0 || known.started >= IGNORED_AFTER) return null;
  return looksPersonal(from) ? "new" : null;
}

export type ReplyItem = {
  threadId: string;
  accountId: string;
  subject: string;
  /** The message the item is about (the newest one); Done remembers it. */
  messageId: string;
  /** Who you owe a reply, or the first person you're waiting on. */
  person: Contact;
  /** Further people on that message. */
  others: number;
  /** When that message was sent. */
  at: string;
  /** Its new text asks something. */
  question: boolean;
  /** To reply: you've written to this person before. Waiting on: they've written to you before. */
  known: boolean;
  /** You've started a reply that isn't sent. */
  drafted: boolean;
};

export type RepliesData = { toReply: ReplyItem[]; waiting: ReplyItem[] };

type Options = {
  /** The account's own address. */
  me: (accountId: string) => string | undefined;
  people: (email: string) => Acquaintance;
  /** Conversations from this address the user dismissed from To reply (none when missing). */
  dismissed?: (email: string) => number;
  /** Names you send under (from your own sent mail): mail signed with one is you at another address. */
  ownNames?: Set<string>;
  /** Days without an answer before a conversation is "Waiting on". */
  waitDays: number;
  now: number;
  /** A message's new text (defaults to its stored one-line preview). */
  freshText?: (thread: Thread, message: Message) => string;
};

/** A question mark in prose, not in a link's query string. */
function asksQuestion(text: string) {
  return /\?/.test(text.replace(/\b(https?:\/\/|www\.)\S+/gi, " "));
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Both lists from the candidates, each ordered by its signals: someone you know, a question, then how long it has waited. */
export function findReplies(candidates: ReplyCandidate[], options: Options): RepliesData {
  const since = options.now - REPLY_WINDOW_DAYS * DAY;
  const waitedEnough = options.now - options.waitDays * DAY;
  const toReply: ReplyItem[] = [];
  const waiting: ReplyItem[] = [];
  for (const { thread, inbox, bulk } of candidates) {
    if (bulk) continue;
    const me = options.me(thread.accountId);
    if (!me) continue;
    const sent = thread.messages.filter((m) => !m.draft);
    const last = sent[sent.length - 1];
    if (!last) continue;
    const at = new Date(last.date).getTime();
    if (Number.isNaN(at) || at < since) continue;
    const drafted = thread.messages.some((m) => m.draft && new Date(m.date).getTime() >= at);
    const fresh = () => options.freshText?.(thread, last) ?? messagePreview(last);
    const item = (person: Contact, others: number, known: boolean): ReplyItem => ({
      threadId: thread.id,
      accountId: thread.accountId,
      subject: thread.subject,
      messageId: last.id,
      person,
      others,
      at: last.date,
      question: asksQuestion(fresh()),
      known,
      drafted,
    });

    if (same(last.from.email, me)) {
      // Waiting on: sent straight to people, and nobody has answered for long enough.
      if (at > waitedEnough) continue;
      const to = last.to.filter((c) => !same(c.email, me));
      if (!to.length || to.some((c) => isAutomated(c.email))) continue;
      // Only someone who writes back: they've written to you before, or it's a person's own address
      // (not an unsubscribe request, a form or a company's desk).
      const known = options.people(to[0].email).seen > 0;
      if (!known && !looksPersonal(to[0])) continue;
      const others = to.length - 1 + (last.cc?.filter((c) => !same(c.email, me)).length ?? 0);
      waiting.push(item(to[0], others, known));
    } else {
      // To reply: a person wrote to you directly (in To, not only Cc) and it's still in the inbox.
      // Meeting invites are answered on their card, not with a reply.
      if (!inbox || last.calendar || last.invite || isAutomated(last.from.email) || last.replyTo?.some((c) => isAutomated(c.email))) continue;
      if (!last.to.some((c) => same(c.email, me))) continue;
      if (last.from.name && options.ownNames?.has(last.from.name.trim().toLowerCase())) continue;
      const standing = replyStanding(last.from, options.people(last.from.email), options.dismissed?.(last.from.email) ?? 0);
      if (!standing) continue;
      toReply.push(item(last.from, 0, standing === "known"));
    }
  }
  // Someone you know outranks a question (a stranger's question is often a pitch); then the longest wait.
  const weight = (i: ReplyItem) => Number(i.known) * 2 + Number(i.question);
  const order = (a: ReplyItem, b: ReplyItem) => weight(b) - weight(a) || a.at.localeCompare(b.at);
  return { toReply: toReply.sort(order), waiting: waiting.sort(order) };
}

/** Whether the user has set this conversation aside: Dismiss, or Done on its newest message. */
function setAside(item: ReplyItem, override: ThreadOverride | undefined) {
  return !!override?.replyOff || override?.replyDone === item.messageId;
}

/** The lists without what the user marked Done or dismissed. */
export function shownReplies(data: RepliesData, overrides: Record<string, ThreadOverride>): RepliesData {
  const keep = (item: ReplyItem) => !setAside(item, overrides[item.threadId]);
  return { toReply: data.toReply.filter(keep), waiting: data.waiting.filter(keep) };
}

/** Messages sent to and received from each address, over the given threads (demo mode; the server reads its contacts cache). */
export function acquaintances(threads: Thread[], own: Set<string>) {
  const people = new Map<string, Acquaintance>();
  const get = (email: string) => {
    const key = email.trim().toLowerCase();
    let found = people.get(key);
    if (!found) people.set(key, (found = { sent: 0, seen: 0, started: 0, answered: 0 }));
    return found;
  };
  for (const thread of threads) {
    const wrote = new Set<string>();
    const answered = new Set<string>();
    for (const m of thread.messages) {
      if (m.draft) continue;
      if (own.has(m.from.email.toLowerCase())) {
        [...m.to, ...(m.cc ?? [])].forEach((c) => get(c.email).sent++);
        wrote.forEach((email) => answered.add(email));
      } else {
        get(m.from.email).seen++;
        wrote.add(m.from.email.trim().toLowerCase());
      }
    }
    wrote.forEach((email) => get(email).started++);
    answered.forEach((email) => get(email).answered++);
  }
  return (email: string) => people.get(email.trim().toLowerCase()) ?? { sent: 0, seen: 0, started: 0, answered: 0 };
}

/** The short line "Nudge" starts a reply with. Markup, so the name is escaped by the caller's rules (plain words only here). */
export function nudgeLine(person: Contact) {
  const first = person.name && person.name !== person.email ? person.name.trim().split(/\s+/)[0].replace(/[^\p{L}\p{M}'-]/gu, "") : "";
  return `${first ? `Hi ${first}, just` : "Just"} following up on this. Any news?`;
}

/** "3 days", "a week", "5 weeks": how long something has waited. */
export function waitedFor(iso: string, now: number) {
  const days = Math.floor((now - new Date(iso).getTime()) / DAY);
  if (days < 1) return "today";
  if (days === 1) return "1 day";
  if (days < 7) return `${days} days`;
  const weeks = Math.floor(days / 7);
  return weeks === 1 ? "a week" : `${weeks} weeks`;
}
