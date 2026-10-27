import "server-only";

import { INBOX } from "@/lib/mail/mailboxes";
import { getAccount, listAccounts, saveUndo, takeUndo } from "./db";
import { plainRendering } from "./mail/mime";
import { mailAccounts, mailOf } from "./providers/registry";
import type { SenderDetail } from "@/lib/mail/cleanup";
import type { AccountScope } from "@/lib/mail/scope";
import { listRules } from "./rules";
import { inboxThreadsFromSender, latestUnsubscribe, markUnsubscribed, senderRecent, setSenderKept, setSenderStatus, updateLabels } from "./store";
import { notifyChanged } from "./sync";
import { logSent } from "./privacy-log";

const SAFE_EMAIL = /^[^\s@<>"()]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

function hostOf(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}

export function isSenderEmail(value: string) {
  return SAFE_EMAIL.test(value);
}

/** One account's share of an "Archive all": the way back for Undo. */
type ArchiveStep = { accountId: string; ids: string[]; threads: string[] };

/** Archives every inbox message from a sender, across all connected accounts. `undo` names the way back. */
export async function archiveAllFrom(email: string) {
  let archived = 0;
  const steps: ArchiveStep[] = [];
  for (const account of mailAccounts()) {
    const mail = mailOf(account);
    const ids = await mail.listMessages(account, { kind: "inboxFrom", email }, 2000);
    if (!ids.length) continue;
    const threads = inboxThreadsFromSender(email, account.id);
    await mail.modifyMessages(account, ids, { add: [], remove: [INBOX] });
    archived += ids.length;
    threads.forEach((id) => updateLabels(id, [], [INBOX]));
    steps.push({ accountId: account.id, ids, threads });
    notifyChanged(account.id);
  }
  return { archived, undo: steps.length ? saveUndo("cleanup", steps) : undefined };
}

/** Puts Cleanup's archived mail back in the inbox. */
export async function undoArchive(undoIds: string[]) {
  const touched = new Set<string>();
  let missing = 0;
  for (const undoId of undoIds) {
    const steps = takeUndo<ArchiveStep>("cleanup", undoId);
    if (!steps) {
      missing++;
      continue;
    }
    for (const step of steps) {
      const account = getAccount(step.accountId);
      if (!account) continue;
      await mailOf(account).modifyMessages(account, step.ids, { add: [INBOX], remove: [] });
      step.threads.forEach((id) => updateLabels(id, [INBOX], []));
      touched.add(account.id);
    }
  }
  touched.forEach(notifyChanged);
  if (missing === undoIds.length) throw new CleanupError("That can't be undone any more.");
}

export class CleanupError extends Error {
  name = "CleanupError";
}

/** "Keep": Cleanup stops suggesting this sender (or starts again). Their mail is untouched. */
export function keep(email: string, kept: boolean) {
  setSenderKept(email, kept);
}

/** The rule that already archives a sender's new mail: one the user made, `from:<address>` and Archive. */
function archiveRuleFor(email: string) {
  const rule = listRules().find(
    (r) => !r.preset && r.query.trim().toLowerCase() === `from:${email}` && r.actions.some((a) => a.verb === "archive"),
  );
  return rule ? { id: rule.id, name: rule.name, enabled: rule.enabled } : null;
}

export function senderDetail(email: string, scope: AccountScope): SenderDetail {
  return { recent: senderRecent(email, scope), archiveRule: archiveRuleFor(email) };
}

type UnsubscribeResult =
  | { method: "one-click" | "email"; done: true }
  | { method: "website"; done: false; url: string }
  | { method: "none"; done: false };

/**
 * Unsubscribes using the sender's List-Unsubscribe header: an unsubscribe email first (it goes
 * through the user's own mailbox, so the sender learns nothing new), then the RFC 8058 one-click POST (which shows
 * the sender this computer's IP address), otherwise the sender's page for the user to finish.
 */
export async function unsubscribe(email: string): Promise<UnsubscribeResult> {
  const info = latestUnsubscribe(email);
  if (!info) return { method: "none", done: false };

  if (info.mailto) {
    const url = new URL(info.mailto);
    const to = decodeURIComponent(url.pathname);
    const account = getAccount(info.accountId);
    if (account && SAFE_EMAIL.test(to)) {
      const message = {
        to: [{ email: to }],
        subject: url.searchParams.get("subject") ?? "unsubscribe",
        body: url.searchParams.get("body") ?? "unsubscribe",
      };
      await mailOf(account).send(account, message, plainRendering(message));
      markUnsubscribed(email);
      return { method: "email", done: true };
    }
  }
  if (info.oneClick && info.http) {
    logSent("unsubscribe", hostOf(info.http), "One-click unsubscribe", email);
    if (await oneClickUnsubscribe(info.http).catch(() => false)) {
      markUnsubscribed(email);
      return { method: "one-click", done: true };
    }
  }
  if (info.http) return { method: "website", done: false, url: info.http };
  return { method: "none", done: false };
}

/** RFC 8058 one-click unsubscribe: a single POST, no page visit. */
async function oneClickUnsubscribe(url: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "List-Unsubscribe=One-Click",
    redirect: "follow",
    signal: AbortSignal.timeout(8000),
  });
  return res.ok;
}

/** Blocked: the "Blocked senders" rule archives their new mail; what's in the inbox goes now (with Undo). */
export async function block(email: string) {
  setSenderStatus(email, "blocked");
  return archiveAllFrom(email);
}

export function allow(email: string) {
  setSenderStatus(email, "allowed");
  listAccounts().forEach((a) => notifyChanged(a.id));
}
