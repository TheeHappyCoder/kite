import "server-only";
import type { MailBatchJob, MailBatchPreview, MailBatchRequest, MailBatchResult } from "@/lib/mail/batch";
import { inScope } from "@/lib/mail/scope";
import { INBOX, TRASH, SPAM, UNREAD, STARRED } from "@/lib/mail/mailboxes";
import type { Thread } from "@/lib/mail/types";
import { getAccount, saveUndo, takeUndo, type AccountRow } from "./db";
import { mapLimit } from "./mail/parse";
import { mailAccounts, mailOf } from "./providers/registry";
import { getThreadRow, rowsHolding, storedMessages, updateMessageLabels, upsertRecord, removeRemote, type StoredMessage } from "./store";
import { notifyChanged } from "./sync";
import { unsubscribe } from "./cleanup";

// Bulk changes behind a confirmation: a review pins exact message ids, a run changes them in chunks,
// Undo puts them back. Each works as a job the window follows (GET ?job=), so it can carry on in the
// background, and Stop ends a run between chunks. Labels come from the local copy where it has the
// message; the provider is asked only about mail Kite hasn't stored.

const LIMIT = 10_000;
/** Messages per provider call: big enough to be quick, small enough that progress moves and Stop answers soon. */
const CHUNK = 100;
/** How often open windows are told to read the lists again while a long run works. */
const NOTIFY_MS = 1500;

type Step = { accountId: string; id: string; remote?: string; labels: string[]; action: MailBatchRequest["action"]; unsubscribe?: string };
type Job = MailBatchJob & { stop: boolean; at: number };

const jobs: Map<string, Job> = ((globalThis as { __kiteMailJobs?: Map<string, Job> }).__kiteMailJobs ??= new Map());

function start(kind: Job["kind"], work: (job: Job) => Promise<void>): MailBatchJob {
  for (const [id, old] of jobs) if (old.finished && Date.now() - old.at > 30 * 60_000) jobs.delete(id);
  const job: Job = { id: crypto.randomUUID(), kind, done: 0, total: 0, finished: false, stop: false, at: Date.now() };
  jobs.set(job.id, job);
  work(job)
    .catch((error: unknown) => { job.error = error instanceof Error ? error.message : "Couldn't change that mail."; })
    .finally(() => { job.finished = true; job.at = Date.now(); });
  return view(job);
}

const view = (job: Job): MailBatchJob => ({ id: job.id, kind: job.kind, done: job.done, total: job.total, finished: job.finished, error: job.error, preview: job.preview, result: job.result });

export function jobState(id: string): MailBatchJob | null {
  const job = jobs.get(id);
  return job ? view(job) : null;
}

/** Ends a run after the chunk under way; what's done keeps its Undo. */
export function stopJob(id: string) {
  const job = jobs.get(id);
  if (job) job.stop = true;
}

export const previewMailBatch = (input: MailBatchRequest) => start("review", (job) => review(job, input));
export function executeMailBatch(token: string) {
  const steps = takeUndo<Step>("mail-preview", token);
  if (!steps) throw new Error("This review expired. Review the selection again.");
  return start("run", (job) => run(job, steps));
}
export function undoMailBatch(token: string) {
  const steps = takeUndo<Step>("mail-undo", token);
  if (!steps) throw new Error("This Undo expired. You can still restore deleted mail from Trash.");
  return start("undo", (job) => restore(job, steps));
}

/** Snapshot exact message ids for confirmation. Mail arriving afterwards is never swept up. */
async function review(job: Job, input: MailBatchRequest) {
  const found: { account: AccountRow; ids: string[]; stored: Map<string, StoredMessage> }[] = [];
  for (const account of mailAccounts().filter((a) => inScope(input.account, a.id))) {
    const mail = mailOf(account);
    let ids: string[];
    let stored: Map<string, StoredMessage>;
    if (input.threads) {
      stored = new Map();
      for (const t of input.threads.filter((t) => t.account === account.id)) {
        const row = getThreadRow(`${account.id}:${t.id}`);
        if (!row) continue;
        for (const m of (JSON.parse(row.data) as Thread).messages) stored.set(m.id, { id: m.id, labels: m.labels ?? [], from: m.from.email.toLowerCase(), remote: m.remoteThread ?? row.remote_id });
      }
      ids = [...stored.keys()];
    } else if (input.senders) {
      ids = [];
      for (const email of input.senders) ids.push(...await mail.listMessages(account, { kind: input.inboxOnly ? "inboxFrom" : "sender", email }, LIMIT + 1));
      stored = storedMessages(account.id, { senders: input.senders });
    } else {
      if (input.action !== "permanent") throw new Error("Choose the mail to change.");
      ids = await mail.listMessages(account, { kind: "mailbox", mailbox: "trash" }, LIMIT + 1);
      stored = storedMessages(account.id, "trash");
    }
    ids = [...new Set(ids)];
    if (ids.length && input.action === "permanent" && (!mail.deletePermanently || !await mail.canDeletePermanently?.(account))) {
      throw new Error(`Permanent deletion isn't available for ${account.email} in Kite. Empty Trash in that mail service instead.`);
    }
    found.push({ account, ids, stored });
    if (found.reduce((n, f) => n + f.ids.length, 0) > LIMIT) throw new Error("More than 10,000 emails match. Choose fewer senders or delete in smaller selections.");
  }
  job.total = found.reduce((n, f) => n + f.ids.length, 0);

  const steps: Step[] = [];
  const accounts: MailBatchPreview["accounts"] = [];
  for (const { account, ids, stored } of found) {
    const mail = mailOf(account);
    const before = steps.length;
    const keep = (m: { id: string; labels: string[]; from: string; remote?: string }) => {
      const labels = m.labels;
      if (input.action === "permanent" ? !labels.includes(TRASH) : labels.includes(TRASH) || labels.includes(SPAM)) return;
      if (input.senders && !input.senders.includes(m.from)) return;
      if (input.inboxOnly && !labels.includes(INBOX)) return;
      steps.push({ accountId: account.id, id: m.id, remote: m.remote, labels, action: input.action, unsubscribe: input.unsubscribe && input.senders ? m.from : undefined });
    };
    const missing: string[] = [];
    for (const id of ids) {
      const local = stored.get(id);
      // Trash's own listing already says where an unstored message is.
      if (local) keep(local);
      else if (!input.senders) keep({ id, labels: [TRASH], from: "" });
      else { missing.push(id); continue; }
      job.done++;
    }
    await mapLimit(missing, mail.concurrency, async (id) => {
      try {
        const m = await mail.fetchMessage(account, id, false);
        keep({ id, labels: m.labels ?? [], from: m.from.email.toLowerCase(), remote: m.remoteThread });
      } catch { /* gone since the listing */ }
      job.done++;
    });
    if (steps.length > before) accounts.push({ id: account.id, email: account.email, count: steps.length - before });
  }
  job.preview = { token: saveUndo("mail-preview", steps), count: steps.length, accounts };
}

async function refresh(account: AccountRow, remote: string) {
  const record = await mailOf(account).fetchThread(account, remote, false);
  if (record) upsertRecord(account, record);
  else removeRemote(account, remote);
}

/** Applies `change` to the stored copy of these messages, conversation by conversation. */
function storeLabels(accountId: string, steps: Step[], add: string[], remove: string[]) {
  const byRemote = new Map<string, string[]>();
  for (const s of steps) if (s.remote) byRemote.set(s.remote, [...(byRemote.get(s.remote) ?? []), s.id]);
  for (const [remote, ids] of byRemote) for (const { row } of rowsHolding(accountId, remote)) updateMessageLabels(row.id, ids, add, remove);
}

/** Calls `apply` a chunk at a time; a chunk that fails goes again one message at a time, so one bad message fails alone. */
async function inChunks(job: Job, steps: Step[], apply: (ids: string[]) => Promise<void>, settled: (ok: Step[]) => void) {
  const failed: Step[] = [];
  let told = Date.now();
  for (let i = 0; i < steps.length; i += CHUNK) {
    if (job.stop) return { failed, stopped: true };
    const chunk = steps.slice(i, i + CHUNK);
    let ok = chunk;
    try {
      await apply(chunk.map((s) => s.id));
    } catch {
      ok = [];
      for (const step of chunk) {
        try { await apply([step.id]); ok.push(step); } catch { failed.push(step); }
      }
    }
    settled(ok);
    job.done += chunk.length;
    if (Date.now() - told > NOTIFY_MS) {
      told = Date.now();
      notifyChanged(chunk[0].accountId);
    }
  }
  return { failed, stopped: false };
}

const byAccount = (steps: Step[]) => {
  const grouped = new Map<string, Step[]>();
  for (const s of steps) grouped.set(s.accountId, [...(grouped.get(s.accountId) ?? []), s]);
  return grouped;
};

async function run(job: Job, steps: Step[]) {
  job.total = steps.length;
  const result: MailBatchResult = { done: 0, failed: 0, skipped: 0, subscriptions: [] };
  const undo: Step[] = [];

  // Unsubscribing first: it's one request per sender, and it's what the user asked for even if a delete fails.
  const asks = new Map<string, { accountId: string; email: string }>();
  for (const s of steps) if (s.unsubscribe) asks.set(`${s.accountId}:${s.unsubscribe}`, { accountId: s.accountId, email: s.unsubscribe });
  for (const { accountId, email } of asks.values()) {
    const account = getAccount(accountId);
    if (!account) continue;
    try {
      const r = await unsubscribe(email, account.id);
      result.subscriptions!.push({ email, note: r.done ? "Unsubscribed" : r.method === "website" ? "Finish on their page" : "No way to unsubscribe", url: r.method === "website" ? r.url : undefined });
    } catch { result.subscriptions!.push({ email, note: "Couldn't unsubscribe; their mail was still deleted" }); }
  }

  for (const [accountId, mine] of byAccount(steps)) {
    if (job.stop) { result.stopped = true; break; }
    const account = getAccount(accountId);
    if (!account) { result.skipped += mine.length; job.done += mine.length; continue; }
    const mail = mailOf(account);
    const stored = storedMessages(account.id, "all");
    const todo: Step[] = [];
    for (const step of mine) {
      const labels = stored.get(step.id)?.labels ?? step.labels;
      // A restored or independently moved message no longer belongs to this confirmation.
      const moved = step.action === "permanent" ? !labels.includes(TRASH) : labels.includes(TRASH) || labels.includes(SPAM) || labels.includes(INBOX) !== step.labels.includes(INBOX);
      if (moved) { result.skipped++; job.done++; }
      else todo.push({ ...step, labels });
    }
    if (todo[0]?.action === "permanent") {
      if (!mail.deletePermanently || !await mail.canDeletePermanently?.(account)) throw new Error("Permanent deletion is unavailable.");
      const remotes = new Set<string>();
      const { failed, stopped } = await inChunks(job, todo, (ids) => mail.deletePermanently!(account, ids), (ok) => {
        result.done += ok.length;
        for (const s of ok) if (s.remote) remotes.add(s.remote);
      });
      result.failed += failed.length;
      if (stopped) result.stopped = true;
      await mapLimit([...remotes], mail.concurrency, (remote) => refresh(account, remote).catch(() => {}));
    } else if (todo.length) {
      const add = todo[0].action === "trash" ? [TRASH] : [];
      const { failed, stopped } = await inChunks(job, todo, (ids) => mail.modifyMessages(account, ids, { add, remove: [INBOX] }), (ok) => {
        result.done += ok.length;
        undo.push(...ok);
        storeLabels(account.id, ok, add, [INBOX]);
      });
      result.failed += failed.length;
      if (stopped) result.stopped = true;
    }
    notifyChanged(account.id);
  }
  if (!result.subscriptions!.length) delete result.subscriptions;
  job.result = { ...result, undo: undo.length ? saveUndo("mail-undo", undo) : undefined };
}

async function restore(job: Job, steps: Step[]) {
  job.total = steps.length;
  const retry: Step[] = [];
  let done = 0;
  for (const [accountId, mine] of byAccount(steps)) {
    const account = getAccount(accountId);
    if (!account) { job.done += mine.length; continue; }
    const mail = mailOf(account);
    const stored = storedMessages(account.id, "all");
    // Messages with the same labels to put back go together.
    const groups = new Map<string, { add: string[]; remove: string[]; steps: Step[] }>();
    for (const step of mine) {
      const current = stored.get(step.id)?.labels;
      if (step.action === "trash" && current && !current.includes(TRASH)) { job.done++; continue; }
      const add = step.action === "archive" ? [INBOX] : step.labels.filter((l) => ![UNREAD, STARRED, TRASH].includes(l));
      const remove = [TRASH, ...(!step.labels.includes(INBOX) ? [INBOX] : [])];
      const key = JSON.stringify([add, remove]);
      const group = groups.get(key) ?? { add, remove, steps: [] };
      group.steps.push(step);
      groups.set(key, group);
    }
    for (const { add, remove, steps: group } of groups.values()) {
      const { failed } = await inChunks(job, group, (ids) => mail.modifyMessages(account, ids, { add, remove }), (ok) => {
        done += ok.length;
        storeLabels(account.id, ok, add, remove);
      });
      retry.push(...failed);
    }
    notifyChanged(account.id);
  }
  job.result = { done, failed: retry.length, skipped: 0, undo: retry.length ? saveUndo("mail-undo", retry) : undefined };
}

/** Populate Trash from the provider, including mail deleted before Kite's initial sync. */
export async function refreshTrash(scope: string) {
  for (const account of mailAccounts().filter((a) => inScope(scope, a.id))) {
    const mail = mailOf(account);
    const ids = await mail.listThreads(account, { kind: "mailbox", mailbox: "trash" }, LIMIT);
    await mapLimit(ids, mail.concurrency, (id) => refresh(account, id).catch(() => {}));
    notifyChanged(account.id);
  }
}
