// Cleanup's sender table (server/store.ts `senderSummaries`, components/mail/cleanup-view.tsx):
// counts from the local copy only, plus the filters and sorts the table offers. No AI, no guessing:
// the numbers order the table, the user picks who goes.

export type SenderSummary = {
  email: string;
  name: string;
  /** Emails from them in the local copy (Trash and Spam left out). */
  emails: number;
  /** Of those, still in the inbox. */
  inInbox: number;
  unread: number;
  /** Unread and no longer in the inbox: archived (by you or a rule) without being read. */
  archivedUnread: number;
  firstDate: string;
  lastDate: string;
  /** Their newest email you've read; null when you've never read one. */
  lastRead: string | null;
  /** Bytes of the files they sent (message sizes aren't stored). */
  fileBytes: number;
  canUnsubscribe: boolean;
  unsubscribedAt: string | null;
  /** Emails dated more than UNSUBSCRIBE_GRACE_DAYS after you unsubscribed. */
  sinceUnsubscribe: number;
  /** "Keep": you want their mail, so Cleanup stops suggesting them. */
  keptAt: string | null;
  status: "allowed" | "pending" | "blocked";
  accountIds: string[];
};

/** One sender's recent emails and the rule (if any) that already archives their new mail. */
export type SenderDetail = {
  recent: { subject: string; date: string; unread: boolean; inInbox: boolean }[];
  archiveRule: { id: string; name: string; enabled: boolean } | null;
};

/** Senders may take a couple of days to act on an unsubscribe (Gmail's bulk sender rules allow two). */
export const UNSUBSCRIBE_GRACE_DAYS = 2;

/** "High volume": about one a week or more. */
const HIGH_VOLUME_PER_MONTH = 4;

const DAY = 86_400_000;

/** Emails a month since their first one in the local copy (a month at least, so one burst doesn't read as a flood). */
export function perMonth(s: Pick<SenderSummary, "emails" | "firstDate">, now: number) {
  const months = Math.max(1, (now - new Date(s.firstDate).getTime()) / (30.44 * DAY));
  return s.emails / months;
}

const share = (part: number, whole: number) => (whole ? part / whole : 0);

export const CLEANUP_FILTERS = {
  inbox: { label: "In inbox", test: (s: SenderSummary) => s.inInbox > 0 },
  never: { label: "Never read", test: (s: SenderSummary) => !s.lastRead },
  volume: { label: "High volume", test: (s: SenderSummary, now: number) => perMonth(s, now) >= HIGH_VOLUME_PER_MONTH },
  newsletters: { label: "Can unsubscribe", test: (s: SenderSummary) => s.canUnsubscribe && !s.unsubscribedAt },
  still: { label: "Still sending", test: (s: SenderSummary) => s.sinceUnsubscribe > 0 && s.status !== "blocked" },
  all: { label: "Everyone", test: () => true },
  kept: { label: "Kept", test: (s: SenderSummary) => !!s.keptAt },
} as const;

export type CleanupFilter = keyof typeof CLEANUP_FILTERS;

/** Whether a sender shows under a filter: kept senders only show under "Kept". */
export function inFilter(s: SenderSummary, filter: CleanupFilter, now: number) {
  if (filter === "kept") return !!s.keptAt;
  return !s.keptAt && CLEANUP_FILTERS[filter].test(s, now);
}

export const CLEANUP_SORTS = {
  emails: { label: "Emails", value: (s: SenderSummary) => s.emails },
  inbox: { label: "In inbox", value: (s: SenderSummary) => s.inInbox },
  monthly: { label: "Per month", value: (s: SenderSummary, now: number) => perMonth(s, now) },
  unread: { label: "Unread", value: (s: SenderSummary) => share(s.unread, s.emails) },
  archivedUnread: { label: "Archived unread", value: (s: SenderSummary) => share(s.archivedUnread, s.emails) },
  lastRead: { label: "Last read", value: (s: SenderSummary) => (s.lastRead ? new Date(s.lastRead).getTime() : 0) },
  lastDate: { label: "Latest", value: (s: SenderSummary) => new Date(s.lastDate).getTime() },
  size: { label: "Files", value: (s: SenderSummary) => s.fileBytes },
} as const;

export type CleanupSort = keyof typeof CLEANUP_SORTS;

export function sortSenders(senders: SenderSummary[], sort: CleanupSort, descending: boolean, now: number) {
  const value = CLEANUP_SORTS[sort].value;
  const sign = descending ? -1 : 1;
  return [...senders].sort((a, b) => sign * (value(a, now) - value(b, now)) || b.emails - a.emails || a.email.localeCompare(b.email));
}

export const formatShare = (part: number, whole: number) => `${Math.round(share(part, whole) * 100)}%`;
