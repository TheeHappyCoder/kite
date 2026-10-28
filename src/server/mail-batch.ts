import "server-only";
import type { MailBatchRequest } from "@/lib/mail/batch";
import { inScope } from "@/lib/mail/scope";
import { INBOX, TRASH, SPAM, UNREAD, STARRED } from "@/lib/mail/mailboxes";
import type { Thread } from "@/lib/mail/types";
import { getAccount, saveUndo, takeUndo, type AccountRow } from "./db";
import { mailAccounts, mailOf } from "./providers/registry";
import { getThreadRow, rowsHolding, updateMessageLabels, upsertRecord, removeRemote } from "./store";
import { notifyChanged } from "./sync";
import { unsubscribe } from "./cleanup";

const LIMIT = 10_000;
type Step = { accountId: string; id: string; remote: string; labels: string[]; action: MailBatchRequest["action"]; unsubscribe?: string };

/** Snapshot exact message IDs for confirmation. Mail arriving afterwards is never swept up. */
export async function previewMailBatch(input: MailBatchRequest) {
  const steps: Step[] = [];
  const accounts: { email: string; count: number }[] = [];
  for (const account of mailAccounts().filter((a) => inScope(input.account, a.id))) {
    const mail = mailOf(account);
    let ids: string[];
    if (input.threads) {
      ids = input.threads.filter((t) => t.account === account.id).flatMap((t) => {
        const row = getThreadRow(`${account.id}:${t.id}`);
        return row ? (JSON.parse(row.data) as Thread).messages.map((m) => m.id) : [];
      });
    } else if (input.senders) {
      ids = [];
      for (const email of input.senders) ids.push(...await mail.listMessages(account, { kind: input.inboxOnly ? "inboxFrom" : "sender", email }, LIMIT + 1));
    } else {
      if (input.action !== "permanent") throw new Error("Choose the mail to change.");
      ids = await mail.listMessages(account, { kind: "mailbox", mailbox: "trash" }, LIMIT + 1);
    }
    ids = [...new Set(ids)];
    if (ids.length + steps.length > LIMIT) throw new Error("More than 10,000 emails match. Choose fewer senders or delete in smaller selections.");
    if (ids.length && input.action === "permanent" && (!mail.deletePermanently || !await mail.canDeletePermanently?.(account))) {
      throw new Error(`Permanent deletion isn't available for ${account.email} in Kite. Empty Trash in that mail service instead.`);
    }
    const before = steps.length;
    for (const id of ids) {
      const message = await mail.fetchMessage(account, id, false);
      const labels = message.labels ?? [];
      if (input.action === "permanent" ? !labels.includes(TRASH) : labels.includes(TRASH) || labels.includes(SPAM)) continue;
      if (input.senders && !input.senders.includes(message.from.email.toLowerCase())) continue;
      if (input.inboxOnly && !labels.includes(INBOX)) continue;
      if (!message.remoteThread) throw new Error("Couldn't identify a message's conversation. Refresh and try again.");
      steps.push({ accountId: account.id, id, remote: message.remoteThread, labels, action: input.action, unsubscribe: input.unsubscribe && input.senders ? message.from.email.toLowerCase() : undefined });
    }
    if (steps.length > before) accounts.push({ email: account.email, count: steps.length - before });
  }
  return { token: saveUndo("mail-preview", steps), count: steps.length, accounts };
}

async function refresh(account: AccountRow, remote: string) {
  const record = await mailOf(account).fetchThread(account, remote, false);
  if (record) upsertRecord(account, record);
  else removeRemote(account, remote);
}

export async function executeMailBatch(token: string) {
  const steps = takeUndo<Step>("mail-preview", token);
  if (!steps) throw new Error("This preview expired. Review the selection again.");
  const undo: Step[] = [];
  let done = 0, failed = 0, skipped = 0;
  const subscriptions: { email: string; note: string; url?: string }[] = [];
  const unsubscribed = new Set<string>();
  const touched = new Map<string, Set<string>>();
  for (const step of steps) {
    const account = getAccount(step.accountId);
    if (!account) { skipped++; continue; }
    const mail = mailOf(account);
    try {
      if (step.unsubscribe && !unsubscribed.has(`${account.id}:${step.unsubscribe}`)) {
        unsubscribed.add(`${account.id}:${step.unsubscribe}`);
        try {
          const result = await unsubscribe(step.unsubscribe, account.id);
          subscriptions.push({ email: `${step.unsubscribe} (${account.email})`, note: result.done ? "Unsubscribed" : result.method === "website" ? "Finish unsubscribing on their website" : "No unsubscribe option found", url: result.method === "website" ? result.url : undefined });
        } catch { subscriptions.push({ email: `${step.unsubscribe} (${account.email})`, note: "Unsubscribe failed. Mail deletion was still attempted." }); }
      }
      const current = await mail.fetchMessage(account, step.id, false);
      const labels = current.labels ?? [];
      // A restored or independently moved message no longer belongs to this confirmation.
      if (step.action === "permanent" ? !labels.includes(TRASH) : labels.includes(TRASH) || labels.includes(SPAM) || labels.includes(INBOX) !== step.labels.includes(INBOX)) { skipped++; continue; }
      if (step.action === "permanent") {
        if (!mail.deletePermanently || !await mail.canDeletePermanently?.(account)) throw new Error("Permanent deletion is unavailable.");
        await mail.deletePermanently(account, [step.id]);
      } else {
        const add = step.action === "trash" ? [TRASH] : [];
        await mail.modifyMessages(account, [step.id], { add, remove: [INBOX] });
        undo.push({ ...step, labels });
        for (const { row } of rowsHolding(account.id, step.remote)) updateMessageLabels(row.id, [step.id], add, [INBOX]);
      }
      done++;
    } catch { failed++; }
    const remotes = touched.get(account.id) ?? new Set<string>();
    remotes.add(step.remote);
    touched.set(account.id, remotes);
  }
  for (const [id, remotes] of touched) {
    const account = getAccount(id)!;
    for (const remote of remotes) await refresh(account, remote).catch(() => {});
    notifyChanged(id);
  }
  return { done, failed, skipped, undo: undo.length ? saveUndo("mail-undo", undo) : undefined, subscriptions };
}

export async function undoMailBatch(token: string) {
  const steps = takeUndo<Step>("mail-undo", token);
  if (!steps) throw new Error("This Undo expired. You can still restore deleted mail from Trash.");
  const retry: Step[] = [];
  for (const step of steps) {
    const account = getAccount(step.accountId);
    if (!account) continue;
    try {
      const mail = mailOf(account);
      const current = await mail.fetchMessage(account, step.id, false);
      if (step.action === "trash" && !current.labels?.includes(TRASH)) continue;
      const add = step.action === "archive" ? [INBOX] : step.labels.filter((l) => ![UNREAD, STARRED, TRASH].includes(l));
      await mail.modifyMessages(account, [step.id], { add, remove: [TRASH, ...(!step.labels.includes(INBOX) ? [INBOX] : [])] });
      await refresh(account, step.remote);
      notifyChanged(account.id);
    } catch { retry.push(step); }
  }
  return { failed: retry.length, undo: retry.length ? saveUndo("mail-undo", retry) : undefined };
}

/** Populate Trash from the provider, including mail deleted before Kite's initial sync. */
export async function refreshTrash(scope: string) {
  for (const account of mailAccounts().filter((a) => inScope(scope, a.id))) {
    const ids = await mailOf(account).listThreads(account, { kind: "mailbox", mailbox: "trash" }, LIMIT);
    for (const id of ids) await refresh(account, id);
    notifyChanged(account.id);
  }
}
