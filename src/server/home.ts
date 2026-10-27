import "server-only";

import { HOME_DAYS, sortHome, type HomeData } from "@/lib/home";
import type { Thread } from "@/lib/mail/types";
import type { RepliesData } from "@/lib/replies";
import { amountsByThread } from "./collections";
import { listAccounts } from "./db";
import { getOverride } from "./overrides";
import { replyCandidates } from "./store";

// Home (lib/home.ts), read from the local copy on each request: Updates as one line each with the
// amount an automation collected from it, and the reading shelf. Read-only.

/** The inbox list with each conversation's collected amount on it (the Everything else side shows it). */
export function withAmounts(threads: Thread[]) {
  const amounts = amountsByThread(threads.map((t) => t.id));
  return amounts.size ? threads.map((t) => (amounts.has(t.id) ? { ...t, amount: amounts.get(t.id) } : t)) : threads;
}

export function collectHome(accountIds: Set<string>, people: RepliesData, now: number): HomeData {
  const accounts = listAccounts().filter((a) => accountIds.has(a.id));
  const own = new Map(accounts.map((a) => [a.id, a.email]));
  const since = new Date(now - HOME_DAYS * 86_400_000).toISOString();
  const candidates = replyCandidates([...own.keys()], since);
  const amounts = amountsByThread(candidates.filter((c) => c.inbox).map((c) => c.thread.id));
  const home = sortHome(candidates, people, { amounts, me: (id) => own.get(id), now });
  // The local rename is what the user sees everywhere else.
  const named = (list: HomeData["things"]) => list.map((line) => ({ ...line, subject: getOverride(line.threadId)?.subject ?? line.subject }));
  return { things: named(home.things), reading: named(home.reading) };
}
