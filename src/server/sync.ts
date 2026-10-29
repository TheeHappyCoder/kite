import "server-only";

import { EventEmitter } from "node:events";
import { rm } from "node:fs/promises";
import { compactSearchIndex, eraseAllRows, getAccount, getDb, listAccounts, listSnoozes, saveUndo, setSnooze, takeUndo, type AccountRow } from "./db";
import { refreshAccountPhoto } from "./avatars";
import { clearTranslations } from "./translate";
import { dataDir } from "./paths";
import { destroyKey } from "./secrets";
import { CursorExpired, LabelError, ReconnectRequired } from "./mail/errors";
import { LABEL_OPS, type ThreadOp } from "./mail/ops";
import { mapLimit } from "./mail/parse";
import type { MailAdapter } from "./mail/provider";
import type { OutgoingMessage, ThreadList } from "./mail/types";
import { syncCalendar } from "./events";
import { resetMailCalendar } from "./mail-calendar";
import { mailAccounts, mailFor, mailOf, providerFor } from "./providers/registry";
import { INBOX, UNREAD } from "@/lib/mail/mailboxes";
import type { SearchTerm } from "@/lib/mail/search";
import type { Thread } from "@/lib/mail/types";
import { homeRemote, remotesOf } from "@/lib/mail/threads";
import { applyLabelChange, providerSpec } from "@/lib/mail/providers";
import { FRESH_CODE_MS, type DesktopCode, type DesktopMail, type DesktopMeeting } from "@/lib/desktop";
import { dueMeetings } from "./meetings";
import { maybeCode, recordCodes } from "./codes";
import { forgetRules, listRules, pruneRuns, runDelayed, runRulesOnArrival } from "./rules";
import { pruneExpectations, tickExpectations } from "./expectations";
import { runScheduleNow, runSchedules, type ScheduleHooks } from "./schedules";
import type { Rule } from "@/lib/rules/spec";
import type { ComposeDraft } from "@/lib/mail/compose";
import {
  getThreadRow,
  opTargets,
  remoteFullyStored,
  remoteMessages,
  remotesToPrefetch,
  removeRemote,
  rowsHolding,
  senderStatus,
  setSenderStatus,
  updateLabels,
  unreadTarget,
  updateMessageLabels,
  upgradeDerived,
  upsertRecord,
  type Placement,
} from "./store";
import { getPreferences } from "./settings";
import { renderOutgoing } from "./outgoing";
import { clearAttachmentCache, sweepAttachmentCache } from "./attachments";
import { removeUploads } from "./uploads";
import { runAiDrafts } from "./ai-drafts";
import { isMuted } from "./overrides";
import { shouldNotify } from "@/lib/notify-rules";
import type { AiUsageSummary } from "@/lib/ai-pricing";
import { usageEvents } from "./ai-usage";
import { liveActivities, barEvents, removeSource, type BarChange } from "./bar/runtime";
import { folderTest, labelAdapter, labelToFill, markLabelFilled, ownLabels, refreshLabels } from "./labels";

// Background sync. One engine per server process (kept on globalThis so dev
// hot-reloads don't start duplicates). Each tick: incremental sync per account,
// body prefetch, snooze wake-ups, scheduled sends and follow-up checks. Provider-neutral:
// every call to a mailbox goes through the account's MailAdapter (server/mail/provider.ts).

const TICK_MS = 20_000;
/** While a Kite window is on screen, new mail is checked for this often (history only: a few hundred bytes). */
const QUICK_MS = 5_000;
/** A visible window says so about once a minute; quick checks stop soon after it goes quiet. */
const WATCH_MS = 75_000;
/** How often accounts whose provider can `peek` are asked whether anything changed, Kite visible or not. */
const PEEK_MS = 4_000;
const INITIAL_LISTS: [ThreadList, number][] = [
  [{ kind: "mailbox", mailbox: "inbox" }, 400],
  [{ kind: "mailbox", mailbox: "sent" }, 150],
  [{ kind: "mailbox", mailbox: "starred" }, 100],
  [{ kind: "mailbox", mailbox: "drafts" }, 50],
  [{ kind: "recent", days: 90 }, 500],
];
const PREFETCH = 60;
/** Threads with attachments are downloaded in full so All files can list them. */
const FILES_LIST: ThreadList = { kind: "attachments" };
const FILES_SCAN_MS = 30 * 60_000;
const FILES_PER_PASS = 40;
const LABELS_READ_MS = 10 * 60_000;
/** Conversations fetched per label the first time it's seen (older ones come with "Search older mail"). */
const LABEL_FILL = 200;

export type SyncEvent =
  | { type: "changed"; accountId: string }
  /** Account details changed (e.g. a profile photo arrived): refetch /api/accounts. */
  | { type: "accounts" }
  /** An account's labels/folders changed (names, colours, new or deleted ones). */
  | { type: "labels"; accountId: string }
  /** A fresh sign-in code or link, for the desktop shell's toast. Only sent when code notifications are on. */
  | ({ type: "code" } & DesktopCode)
  /** A meeting in the user's calendar starts in a moment, for the desktop app's Kite bar. Only sent when meeting notifications are on. */
  | ({ type: "meeting" } & DesktopMeeting)
  /** An integration's activity in the Kite bar: shown (new or updated in place) or removed (server/bar/runtime.ts). */
  | ({ type: "bar" } & BarChange)
  /** Preferences changed (the desktop shell re-reads /api/desktop). */
  | { type: "settings" }
  | { type: "progress"; accountId: string; done: number; total: number }
  | { type: "sent"; accountId: string; scheduledId: string; held?: boolean }
  /**
   * New mail arrived in a conversation and a rule said to notify: now, or with the next batch
   * (lib/notify-rules.ts). Mail the rules keep quiet sends no event.
   */
  | ({ type: "mail"; notify: "now" | "batch" } & DesktopMail)
  /** The local copy of an account's calendar changed (Today reads it again). */
  | { type: "calendar"; accountId: string }
  | { type: "error"; accountId: string; message: string }
  /** A rule's AI draft landed in a conversation's quick-reply box (the app refetches it if that one is open). */
  | { type: "prepared"; accountId: string; threadId: string }
  /** AI usage changed (a call was recorded or the limits changed): the sidebar ring and Settings → AI. */
  | { type: "ai"; usage: AiUsageSummary };

type Engine = {
  events: EventEmitter;
  timer: ReturnType<typeof setInterval> | null;
  /** Push connections (MailAdapter.watch) by account id. */
  watchers?: Map<string, () => void>;
  /** Latest tick implementation; swapped on hot reload so a running timer never calls stale code. */
  tick?: () => Promise<unknown>;
  running: Map<string, Promise<void>>;
  progress: Map<string, { done: number; total: number }>;
  /** When each account last looked for threads with attachments. */
  filesScannedAt?: Map<string, number>;
  /** Until when a visible Kite window wants quick new-mail checks. */
  watchedUntil?: number;
  quickTimer?: ReturnType<typeof setInterval> | null;
  /** History reads in flight, per account (shared by the quick check and the tick). */
  checking?: Map<string, { run: Promise<void>; again?: Promise<void> }>;
  /** Latest quick check; swapped on hot reload like `tick`. */
  quick?: () => void;
  peekTimer?: ReturnType<typeof setInterval> | null;
  /** Latest peek; swapped on hot reload like `tick`. */
  peek?: () => void;
  /** Accounts with a peek in flight. */
  peeking?: Set<string>;
  /** When each account's labels/folders were last read from the provider. */
  labelsReadAt?: Map<string, number>;
};

const g = globalThis as typeof globalThis & { __kiteSync?: Engine };
const engine: Engine = (g.__kiteSync ??= {
  events: new EventEmitter().setMaxListeners(50),
  timer: null,
  running: new Map(),
  progress: new Map(),
});

export const syncEvents = engine.events;

// AI usage comes from server/ai-usage.ts (which can't import this module); passed on once per process.
const hooked = globalThis as typeof globalThis & { __kiteAiUsageHooked?: boolean };
if (!hooked.__kiteAiUsageHooked) {
  hooked.__kiteAiUsageHooked = true;
  usageEvents.on("usage", (usage: AiUsageSummary) => engine.events.emit("event", { type: "ai", usage } satisfies SyncEvent));
}
const barHooked = globalThis as typeof globalThis & { __kiteBarHooked?: boolean };
if (!barHooked.__kiteBarHooked) {
  barHooked.__kiteBarHooked = true;
  barEvents.on("bar", (change: BarChange) => engine.events.emit("event", { type: "bar", ...change } satisfies SyncEvent));
}

function emit(event: SyncEvent) {
  engine.events.emit("event", event);
}

export function syncProgress(accountId: string) {
  return engine.progress.get(accountId) ?? null;
}

type SyncState = { account_id: string; history_id: string | null; synced_at: string | null; initial_done: number; error?: string | null };

function getState(accountId: string) {
  return getDb().prepare("SELECT * FROM sync_state WHERE account_id = ?").get(accountId) as SyncState | undefined;
}

function saveState(accountId: string, patch: Partial<Omit<SyncState, "account_id">> & { error?: string | null }) {
  const current = getState(accountId);
  const next = { history_id: null, synced_at: null, initial_done: 0, error: null, ...current, ...patch };
  getDb()
    .prepare(
      `INSERT INTO sync_state (account_id, history_id, synced_at, initial_done, error) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET history_id = excluded.history_id, synced_at = excluded.synced_at,
         initial_done = excluded.initial_done, error = excluded.error`,
    )
    .run(accountId, next.history_id, next.synced_at, next.initial_done, next.error);
}

/**
 * Fetches and stores one provider thread (split and merge choices applied). With `screen` (mail
 * arriving now), reads new bank mail and sign-in codes, then runs the rules engine on conversations with new messages.
 * Returns false if it no longer exists.
 */
async function refreshThread(account: AccountRow, remoteId: string, full: boolean, screen: boolean) {
  const record = await mailOf(account).fetchThread(account, remoteId, full);
  if (!record?.thread.messages.length) {
    removeRemote(account, remoteId);
    return false;
  }
  // Who Kite knew before this mail: loading bodies below records senders, and "Hold new senders" must still see them as new.
  const known = screen ? new Map(record.thread.messages.map((m) => [m.from.email.toLowerCase(), senderStatus(m.from.email)])) : null;
  const placed = upsertRecord(account, record);
  if (known) {
    const arrived = newMail(placed);
    for (const { id, fresh } of placed) {
      if (!fresh.length) continue;
      await readArrived(account, id, fresh, full);
      const loadFull = async () => {
        for (const remote of remotesFor(account, id.slice(account.id.length + 1))) await refreshThread(account, remote, true, false);
      };
      const outcome = await runRulesOnArrival(account, id, fresh, { loadFull, statusBefore: (email) => known.get(email) ?? null }).catch((error) => {
        console.error("Rules failed:", error);
        return { notify: null, expected: false };
      });
      const mail = arrived.find((m) => m.threadId === id);
      if (mail && outcome.notify && outcome.notify !== "silent") emit({ type: "mail", accountId: account.id, ...mail, notify: outcome.notify });
    }
  }
  // Everyone Kite sees is known from now on (after the rules, so "Hold new senders" saw them as new).
  // Anyone you write to is let in.
  if (record.sender) setSenderStatus(record.sender.email, "allowed", true);
  record.recipients.forEach((email) => setSenderStatus(email, "allowed"));
  return true;
}

/**
 * Conversations that just received fresh, unread inbox mail (your own replies carry only SENT,
 * so they never count; mail to yourself does). Read before the rules move it.
 */
function newMail(placed: Placement[]) {
  return placed.flatMap(({ id, fresh: ids }) => {
    const row = ids.length ? getThreadRow(id) : null;
    if (!row) return [];
    const thread = JSON.parse(row.data) as Thread;
    const fresh = thread.messages.filter(
      (m) => ids.includes(m.id) && m.unread && m.labels?.includes("INBOX") && Date.now() - new Date(m.date).getTime() < 60 * 60_000,
    );
    const last = fresh.at(-1);
    if (!last) return [];
    const preview = (last.preview ?? last.snippet ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    return [
      {
        id: `${id}@${last.id}`,
        threadId: id,
        from: { email: last.from.email, name: last.from.name },
        subject: last.subject ?? thread.subject,
        preview: preview || undefined,
        count: fresh.length,
      },
    ];
  });
}

/**
 * Mail arriving now: sign-in codes are read (Codes). Only those messages need bodies, fetched
 * first. Fresh codes go to the code popup and the desktop shell.
 */
async function readArrived(account: AccountRow, threadId: string, fresh: string[], full: boolean) {
  const row = getThreadRow(threadId);
  if (!row) return;
  let thread = JSON.parse(row.data) as Thread;
  const own = account.email.toLowerCase();
  const arrived = thread.messages.filter((m) => fresh.includes(m.id) && m.from.email.toLowerCase() !== own);
  if (!arrived.some((m) => maybeCode(m, thread.subject))) return;
  if (!full && !row.full) {
    for (const remote of remotesOf(thread)) await refreshThread(account, remote, true, false);
    const fullRow = getThreadRow(threadId);
    if (fullRow) thread = JSON.parse(fullRow.data) as Thread;
  }
  const { notifications } = getPreferences();
  const codesNow = shouldNotify({ kind: "code", muted: isMuted(threadId) }, notifications) === "now";
  for (const code of recordCodes(thread, fresh, own)) {
    if (codesNow && Date.now() - new Date(code.receivedAt).getTime() < FRESH_CODE_MS) emit({ type: "code", ...code });
  }
}

/** At most `n` requests at once, never more than the provider allows. */
const within = (mail: MailAdapter, n: number) => Math.min(n, mail.concurrency);

async function initialSync(account: AccountRow) {
  const mail = mailOf(account);
  const cursor = await mail.startCursor(account);
  // Threads are fetched while the lists are still being read, inbox first, so a new user's
  // inbox starts filling within seconds instead of after every list page.
  let done = 0;
  const ids = new Set<string>();
  const queue: string[] = [];
  let listing = true;
  let failed = false;
  let wake = () => {};
  let more = new Promise<void>((resolve) => (wake = resolve));
  const lister = (async () => {
    try {
      for (const [list, max] of INITIAL_LISTS) {
        await mail.listThreads(account, list, max, (page) => {
          for (const id of page) {
            if (ids.has(id)) continue;
            ids.add(id);
            queue.push(id);
          }
          engine.progress.set(account.id, { done, total: ids.size });
          wake();
          more = new Promise<void>((resolve) => (wake = resolve));
        });
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      listing = false;
      wake();
    }
  })();
  const worker = async () => {
    while (!failed) {
      const id = queue.shift();
      if (!id) {
        if (!listing) return;
        await more;
        continue;
      }
      await refreshThread(account, id, false, false);
      done++;
      engine.progress.set(account.id, { done, total: ids.size });
      if (done % 40 === 0 || (!listing && done === ids.size)) {
        emit({ type: "progress", accountId: account.id, done, total: ids.size });
        emit({ type: "changed", accountId: account.id });
      }
    }
  };
  await Promise.all([lister, ...Array.from({ length: mail.concurrency }, worker)]);
  engine.progress.delete(account.id);
  saveState(account.id, { history_id: cursor, synced_at: new Date().toISOString(), initial_done: 1, error: null });
  emit({ type: "changed", accountId: account.id });
}

/** `cursor` is the provider's change-feed position, kept in sync_state.history_id. */
async function incrementalSync(account: AccountRow, cursor: string) {
  const mail = mailOf(account);
  try {
    const result = await mail.changes(account, cursor);
    if (result.changed.length) {
      await mapLimit(result.changed, within(mail, 6), (id) => refreshThread(account, id, rowsHolding(account.id, id).some((h) => !!h.row.full), true));
    }
    saveState(account.id, { history_id: result.cursor, synced_at: new Date().toISOString(), error: null });
    if (result.changed.length) emit({ type: "changed", accountId: account.id });
  } catch (error) {
    // The feed's position is too old (e.g. a week offline): start over.
    if (error instanceof CursorExpired) {
      saveState(account.id, { initial_done: 0 });
      await initialSync(account);
      return;
    }
    throw error;
  }
}

/**
 * Downloads full bodies for the newest inbox and Screener threads so opening them is instant
 * and works offline. Only conversations still missing their full copy are fetched.
 */
async function prefetchBodies(account: AccountRow) {
  const pending = remotesToPrefetch(account.id, "inbox", PREFETCH).concat(remotesToPrefetch(account.id, "screener", 20));
  if (!pending.length) return;
  await mapLimit(pending, within(mailOf(account), 3), async (remotes) => {
    for (const remote of remotes) await refreshThread(account, remote, true, true);
  });
  emit({ type: "changed", accountId: account.id });
}

/** Every 30 minutes, loads the newest threads with attachments that only have metadata so far. */
async function prefetchFiles(account: AccountRow) {
  const scanned = (engine.filesScannedAt ??= new Map());
  if (Date.now() - (scanned.get(account.id) ?? 0) < FILES_SCAN_MS) return;
  scanned.set(account.id, Date.now());
  const mail = mailOf(account);
  const ids = await mail.listThreads(account, FILES_LIST, 200);
  // Judged by this provider thread's own messages: a merged conversation may hold others still pending.
  const pending = ids.filter((id) => !remoteFullyStored(account.id, id)).slice(0, FILES_PER_PASS);
  if (!pending.length) return;
  await mapLimit(pending, within(mail, 3), (id) => refreshThread(account, id, true, false));
  if (pending.length === FILES_PER_PASS) scanned.delete(account.id);
  emit({ type: "changed", accountId: account.id });
}

/**
 * Every 10 minutes, reads the account's labels/folders from the provider. Then, one label per
 * pass, fetches the conversations carrying it that the local copy doesn't have yet (metadata
 * only), so a label opened in Kite shows what the provider shows, not only recent mail.
 */
async function syncLabels(account: AccountRow) {
  if (!labelAdapter(account)) return;
  const read = (engine.labelsReadAt ??= new Map());
  if (Date.now() - (read.get(account.id) ?? 0) >= LABELS_READ_MS) {
    read.set(account.id, Date.now());
    if (await refreshLabels(account)) emit({ type: "labels", accountId: account.id });
  }
  const label = labelToFill(account.id);
  if (!label) return;
  const mail = mailOf(account);
  const ids = await mail.listThreads(account, { kind: "label", id: label }, LABEL_FILL);
  const missing = ids.filter((id) => !rowsHolding(account.id, id).length);
  await mapLimit(missing, within(mail, 4), (id) => refreshThread(account, id, false, false));
  markLabelFilled(account.id, label);
  if (missing.length) emit({ type: "changed", accountId: account.id });
}

async function wakeSnoozes(account: AccountRow) {
  let woke = false;
  for (const snooze of listSnoozes(account.id)) {
    if (new Date(snooze.until).getTime() > Date.now()) continue;
    // Snoozes are stored under the thread key, so a split conversation wakes on its own.
    await changeLabels(account, snooze.thread_id, [INBOX], []).catch(() => {});
    await markUnread(account, snooze.thread_id).catch(() => {});
    setSnooze(account.id, snooze.thread_id, null);
    for (const remote of remotesFor(account, snooze.thread_id)) await refreshThread(account, remote, true, false).catch(() => {});
    woke = true;
  }
  if (woke) emit({ type: "changed", accountId: account.id });
}

// ---------------------------------------------------------------------------
// Scheduled sends and follow-ups
// ---------------------------------------------------------------------------

type ScheduledRow = {
  id: string;
  account_id: string;
  payload: string;
  send_at: string;
  remind_days: number | null;
  status: string;
};

export async function deliver(account: AccountRow, message: OutgoingMessage, remindDays: number | null) {
  const sent = await mailOf(account).send(account, message, await renderOutgoing(account, message));
  // Uploaded files were only kept for this message.
  await removeUploads((message.attachments ?? []).flatMap((a) => (a.type === "upload" ? [a.id] : []))).catch(() => {});
  if (remindDays) {
    const sentAt = new Date();
    getDb()
      .prepare("INSERT INTO followups (id, account_id, thread_remote_id, sent_at, due_at, status) VALUES (?, ?, ?, ?, ?, 'pending')")
      .run(crypto.randomUUID(), account.id, sent.threadId, sentAt.toISOString(), new Date(sentAt.getTime() + remindDays * 86_400_000).toISOString());
  }
  // Screened like mail arriving, so automations on mail you send see it (and expectations count it).
  await refreshThread(account, sent.threadId, true, true).catch(() => {});
  emit({ type: "changed", accountId: account.id });
  return sent;
}

/** What automations' own sends, drafts and nudges go through (schedules and expectations can't import this module). */
const automationHooks: ScheduleHooks & { surface: (account: AccountRow, threadId: string) => Promise<void> } = {
  send: async (account: AccountRow, draft: ComposeDraft) => {
    // Imported here: drafts.ts imports this module.
    const { outgoingFromDraft } = await import("./drafts");
    return deliver(account, outgoingFromDraft(account, draft), null);
  },
  saveDraft: async (account: AccountRow, draft: ComposeDraft) => {
    const { saveDraft } = await import("./drafts");
    return saveDraft(account, draft);
  },
  // A nudge is ready: the conversation comes back to the top of the inbox, unread, like a snooze waking.
  surface: async (account: AccountRow, threadId: string) => {
    const key = threadId.slice(account.id.length + 1);
    await changeLabels(account, key, [INBOX], []);
    await markUnread(account, key);
    for (const remote of remotesFor(account, key)) await refreshThread(account, remote, true, false).catch(() => {});
  },
};

/** "Run now" on a schedule automation: this period's run, then its asks go out if it sends them itself. */
export async function runScheduleNowFor(rule: Rule) {
  const result = await runScheduleNow(rule, automationHooks);
  await runAutomations();
  return result;
}

/** A request or nudge the user sent from Waiting on (through the same send path as automations' own). */
export const sendForAutomation = (account: AccountRow, draft: ComposeDraft) => automationHooks.send(account, draft);

/** Automations' timed work: waits that are over, expectations' asks and nudges, and schedules that came round. */
async function runAutomations() {
  const changed = new Set<string>();
  const note = (ids: string[]) => ids.forEach((id) => changed.add(id));
  note(await runDelayed().catch((error) => (console.error("Delayed automations:", error), [])));
  note(await runSchedules(listRules(), automationHooks).catch((error) => (console.error("Scheduled automations:", error), [])));
  note(await tickExpectations(automationHooks).catch((error) => (console.error("Expectations:", error), [])));
  pruneExpectations();
  for (const accountId of changed) emit({ type: "changed", accountId });
}

async function sendDue(account: AccountRow) {
  const due = getDb()
    .prepare("SELECT * FROM scheduled WHERE account_id = ? AND status = 'pending' AND send_at <= ?")
    .all(account.id, new Date().toISOString()) as ScheduledRow[];
  for (const row of due) await sendScheduledRow(account, row);
}

async function sendScheduledRow(account: AccountRow, row: ScheduledRow) {
  // Claim it first so an overlapping tick (or a held send's own timer) can't send twice.
  const claimed = getDb().prepare("UPDATE scheduled SET status = 'sending' WHERE id = ? AND status = 'pending'").run(row.id);
  if (!claimed.changes) return;
  const message = JSON.parse(row.payload) as OutgoingMessage;
  try {
    await deliver(account, message, row.remind_days);
    getDb().prepare("UPDATE scheduled SET status = 'sent' WHERE id = ?").run(row.id);
    emit({ type: "sent", accountId: account.id, scheduledId: row.id, held: !!message.held });
  } catch (error) {
    getDb()
      .prepare("UPDATE scheduled SET status = 'failed', error = ? WHERE id = ?")
      .run(error instanceof Error ? error.message.slice(0, 300) : "Send failed", row.id);
    emit({
      type: "error",
      accountId: account.id,
      message: message.held ? "Your message couldn't be sent. It's in Scheduled." : "A scheduled message couldn't be sent",
    });
    if (message.held) notifyChanged(account.id);
    return;
  }
  const draftId = message.held?.draftId;
  if (draftId) {
    // Imported here: drafts.ts imports this module.
    const { discardDraft } = await import("./drafts");
    await discardDraft(account, { draftId }, true).catch(() => {});
  }
}

/**
 * Undo send: holds a message for `seconds` as a scheduled row with its own timer (the sync tick
 * is too slow). The server sends it even if the window closes; after a restart the tick does.
 */
export function holdMessage(account: AccountRow, message: OutgoingMessage, seconds: number, remindDays: number | null, draftId?: string) {
  const sendAt = new Date(Date.now() + seconds * 1000).toISOString();
  const id = crypto.randomUUID();
  getDb()
    .prepare("INSERT INTO scheduled (id, account_id, payload, send_at, remind_days, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)")
    .run(id, account.id, JSON.stringify({ ...message, held: { draftId } }), sendAt, remindDays, new Date().toISOString());
  setTimeout(() => {
    const row = getDb().prepare("SELECT * FROM scheduled WHERE id = ?").get(id) as ScheduledRow | undefined;
    const current = getAccount(account.id);
    if (row && current) void sendScheduledRow(current, row);
  }, seconds * 1000);
  return { id, sendAt };
}

async function checkFollowups(account: AccountRow) {
  const due = getDb()
    .prepare("SELECT * FROM followups WHERE account_id = ? AND status = 'pending' AND due_at <= ?")
    .all(account.id, new Date().toISOString()) as { id: string; thread_remote_id: string; sent_at: string }[];
  for (const followup of due) {
    await refreshThread(account, followup.thread_remote_id, true, false).catch(() => {});
    const messages = remoteMessages(account.id, followup.thread_remote_id);
    const thread = messages.length ? { messages } : null;
    const replied = thread?.messages.some(
      (m) => m.date > followup.sent_at && m.from.email.toLowerCase() !== account.email.toLowerCase(),
    );
    if (replied || !thread) {
      getDb().prepare("UPDATE followups SET status = 'replied' WHERE id = ?").run(followup.id);
      continue;
    }
    // No reply: bring the conversation back to the top of the inbox with a nudge.
    await mailOf(account).modifyThreads(account, [followup.thread_remote_id], { add: [INBOX], remove: [] });
    for (const { row } of rowsHolding(account.id, followup.thread_remote_id)) await markUnread(account, row.id.slice(account.id.length + 1));
    getDb().prepare("UPDATE followups SET status = 'nudged' WHERE id = ?").run(followup.id);
    await refreshThread(account, followup.thread_remote_id, true, false).catch(() => {});
    emit({ type: "changed", accountId: account.id });
  }
}

/** Clears a nudge once you've dealt with the thread (archived it or replied). */
function clearFollowup(accountId: string, remoteId: string) {
  getDb()
    .prepare("UPDATE followups SET status = 'done' WHERE account_id = ? AND thread_remote_id = ? AND status IN ('pending', 'nudged')")
    .run(accountId, remoteId);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

/** A newly signed-in account gets its profile photo once, from its provider, into the avatar cache. */
async function backfillPicture(account: AccountRow) {
  if (account.picture !== null || !providerFor(account).picture) return;
  try {
    await refreshAccountPhoto(account);
    emit({ type: "accounts" });
  } catch (error) {
    if (error instanceof ReconnectRequired) throw error;
    // Try again next tick.
  }
}

export function syncAccount(accountId: string): Promise<void> {
  const existing = engine.running.get(accountId);
  if (existing) return existing;
  const run = (async () => {
    const account = getAccount(accountId);
    // A provider Kite only signs in to so far has nothing to sync.
    if (!account || !mailFor(account)) return;
    try {
      await backfillPicture(account);
      const state = getState(accountId);
      if (!state?.initial_done || !state.history_id) await initialSync(account);
      else await checkHistory(account);
      await wakeSnoozes(account);
      await sendDue(account);
      await checkFollowups(account);
      if (await syncCalendar(account)) emit({ type: "calendar", accountId });
      // Labels first: the sidebar shows them while bodies and files are still prefetching.
      await syncLabels(account);
      await prefetchBodies(account);
      await prefetchFiles(account);
    } catch (error) {
      const message = error instanceof ReconnectRequired ? "reconnect" : error instanceof Error ? error.message : "Sync failed";
      saveState(accountId, { error: message.slice(0, 300) });
      emit({ type: "error", accountId, message });
      if (!(error instanceof ReconnectRequired)) console.error(`Sync failed for ${account.email}:`, error);
    }
  })().finally(() => engine.running.delete(accountId));
  engine.running.set(accountId, run);
  return run;
}

async function syncAll() {
  try {
    upgradeDerived();
  } catch (error) {
    console.error("Updating previews and the search index failed:", error);
  }
  await Promise.all(mailAccounts().map((a) => syncAccount(a.id)));
  announceMeetings();
  keepWatchers();
  pruneRuns();
  await runAutomations();
  // A rule's "Draft with AI": at most one request per tick, spaced and capped (server/ai-drafts.ts).
  // Not awaited, so a slow AI never holds up mail.
  void runAiDrafts({ loadFull: loadFullThread, landed: (threadId, accountId) => emit({ type: "prepared", threadId, accountId }) }).catch((error) =>
    console.error("AI drafts:", error instanceof Error ? error.message : error),
  );
}

/**
 * One push connection per account whose provider offers it (IMAP IDLE), started once its first
 * sync is done; a change reads the feed right away. Accounts that are gone or need a reconnect lose theirs.
 */
function keepWatchers() {
  const watchers = (engine.watchers ??= new Map());
  const wanted = new Set<string>();
  for (const account of mailAccounts()) {
    const mail = mailOf(account);
    const state = getState(account.id);
    if (!mail.watch || !state?.initial_done || state.error === "reconnect") continue;
    wanted.add(account.id);
    if (watchers.has(account.id)) continue;
    watchers.set(
      account.id,
      mail.watch(account, () => void checkHistory(account).catch(() => {})),
    );
  }
  for (const [id, stop] of watchers) {
    if (wanted.has(id)) continue;
    stop();
    watchers.delete(id);
  }
}

/** Runs a sync pass now without waiting for the next tick. */
function triggerSync() {
  void syncAll();
}

engine.tick = syncAll;

/** A Kite window is on screen: check for new mail every few seconds for a while. */
export function markWatched() {
  engine.watchedUntil = Date.now() + WATCH_MS;
}

/**
 * The quick check: only the provider's change feed (what changed since last time). Everything else
 * (prefetch, snoozes, sends, labels) stays on the 20 s tick.
 */
function quickCheck() {
  if (!engine.watchedUntil || Date.now() > engine.watchedUntil) return;
  for (const account of mailAccounts()) {
    const state = getState(account.id);
    // Accounts with push hear about new mail themselves.
    if (engine.watchers?.has(account.id)) continue;
    if (state?.initial_done && state.history_id) void checkHistory(account).catch(() => {});
  }
}

/**
 * Reads the provider's change feed for new mail, one read per account at a time. The quick check and the
 * full tick share it, so a long tick (bodies, files, labels) never holds up the quick check. A call while a
 * read is running gets one more read right after it: that read may have started before the mail arrived
 * (a push landing mid-check would otherwise wait for the next tick, up to 20 s).
 */
function checkHistory(account: AccountRow): Promise<void> {
  const checking = (engine.checking ??= new Map());
  const existing = checking.get(account.id);
  if (existing) return (existing.again ??= existing.run.catch(() => {}).then(() => checkHistory(account)));
  const historyId = getState(account.id)?.history_id;
  if (!historyId) return Promise.resolve();
  const entry: { run: Promise<void>; again?: Promise<void> } = {
    run: incrementalSync(account, historyId).finally(() => checking.delete(account.id)),
  };
  checking.set(account.id, entry);
  return entry.run;
}

engine.quick = quickCheck;

/**
 * The peek: one cheap "anything new?" per account (MailAdapter.peek), then the change feed only when it
 * says yes. Skipped while a read is already running for the account; errors wait for the next one.
 */
function peekCheck() {
  const peeking = (engine.peeking ??= new Set());
  for (const account of mailAccounts()) {
    const mail = mailOf(account);
    const state = getState(account.id);
    if (!mail.peek || !state?.initial_done || !state.history_id || state.error === "reconnect") continue;
    if (peeking.has(account.id) || engine.checking?.has(account.id)) continue;
    peeking.add(account.id);
    void mail
      .peek(account, state.history_id)
      .then((moved) => (moved ? checkHistory(account) : undefined))
      .catch(() => {})
      .finally(() => peeking.delete(account.id));
  }
}

engine.peek = peekCheck;

/** Refresh (the button, `refresh`, pull to refresh): every account's change feed read now, awaited. */
export async function checkNow() {
  await Promise.allSettled(
    mailAccounts().flatMap((account) => {
      const state = getState(account.id);
      return state?.initial_done && state.history_id ? [checkHistory(account)] : [];
    }),
  );
}

export function ensureSyncLoop() {
  if (engine.timer) return;
  // `node scripts/perf/quick.mjs` measures the UI on a still copy: no sync landing mid-measurement
  // (stored mail is still upgraded, as the first sync pass would).
  if (process.env.KITE_PERF_NO_SYNC === "1") return upgradeDerived();
  engine.timer = setInterval(() => void engine.tick?.(), TICK_MS);
  engine.quickTimer = setInterval(() => engine.quick?.(), QUICK_MS);
  engine.peekTimer = setInterval(() => engine.peek?.(), PEEK_MS);
  void syncAll();
  // Cached attachments expire after 30 days unused: once at start, then daily.
  void sweepAttachmentCache();
  setInterval(() => void sweepAttachmentCache(), 86_400_000);
}

/** Provider threads behind a thread key (its own, or several once merged). */
function remotesFor(account: AccountRow, key: string) {
  const row = getThreadRow(`${account.id}:${key}`);
  return row ? remotesOf(JSON.parse(row.data) as Thread) : key.includes("~") ? [] : [key];
}

/** Returns the thread with full bodies, downloading them on first open. */
export async function loadFullThread(account: AccountRow, key: string) {
  const id = `${account.id}:${key}`;
  const row = getThreadRow(id);
  if (!row?.full) {
    for (const remote of remotesFor(account, key)) await refreshThread(account, remote, true, true);
  }
  return getThreadRow(id);
}

/**
 * "Search older mail": runs the query on the provider's servers, copies any threads the local
 * store doesn't have yet (headers only; bodies load when opened), and returns the local ids of
 * everything it found.
 */
export async function searchRemote(account: AccountRow, terms: SearchTerm[], max = 50) {
  const mail = mailOf(account);
  const remoteIds = await mail.listThreads(account, { kind: "search", terms }, max);
  await mapLimit(remoteIds, within(mail, 5), async (remoteId) => {
    if (!rowsHolding(account.id, remoteId).length) await refreshThread(account, remoteId, false, false);
  });
  return [...new Set(remoteIds.flatMap((remoteId) => rowsHolding(account.id, remoteId).map((h) => h.row.id)))];
}

/** Waits for an account's in-flight sync pass (e.g. before removing the account). */
export async function syncIdle(accountId: string) {
  await engine.running.get(accountId);
  await engine.checking?.get(accountId)?.run.catch(() => {});
}

/**
 * Drops the local copy of every mailbox and downloads it again. Accounts, tokens,
 * sender decisions, snoozes, scheduled sends, thread overrides and splits/merges are kept (sync
 * places messages again as they arrive).
 */
export async function resetMailCache() {
  await Promise.all([...engine.running.values(), ...[...(engine.checking?.values() ?? [])].map((p) => p.run.catch(() => {}))]);
  const db = getDb();
  db.exec("DELETE FROM document_text; DELETE FROM file_prints; DELETE FROM threads_fts; DELETE FROM threads; DELETE FROM sync_state; DELETE FROM codes;");
  for (const account of mailAccounts()) mailOf(account).resetLocal?.(account.id);
  resetMailCalendar();
  compactSearchIndex();
  await clearAttachmentCache();
  engine.filesScannedAt?.clear();
  engine.labelsReadAt?.clear();
  getDb().exec("UPDATE labels SET filled_at = NULL");
  for (const account of listAccounts()) emit({ type: "changed", accountId: account.id });
  triggerSync();
}

/**
 * "Erase everything": revokes Kite's access to every account, empties the database and deletes
 * every cache and file Kite kept (pictures, attachments, design images, unsent files, translation languages). Kite opens
 * like the first time afterwards.
 */
export async function eraseEverything() {
  for (const account of listAccounts()) {
    await providerFor(account).filters?.removeAccount(account.id).catch(() => {});
    await providerFor(account).auth.revoke(account.id).catch(() => {});
    await syncIdle(account.id);
  }
  await Promise.all([...engine.running.values(), ...[...(engine.checking?.values() ?? [])].map((p) => p.run.catch(() => {}))]);
  eraseAllRows();
  forgetRules();
  // The integrations went with their table; their live activities go too.
  for (const activity of liveActivities()) removeSource(activity.source.id);
  for (const dir of ["avatars", "assets", "uploads"]) await rm(dataDir(dir), { recursive: true, force: true });
  // Downloaded translation languages (server/translate.ts).
  clearTranslations();
  await clearAttachmentCache();
  destroyKey();
  engine.filesScannedAt?.clear();
  engine.labelsReadAt?.clear();
}

/** Re-reads one thread from the provider (after a draft is saved or discarded) and tells open windows. */
export async function syncThread(account: AccountRow, remoteId: string) {
  await refreshThread(account, remoteId, true, false);
  emit({ type: "changed", accountId: account.id });
}

export function notifyChanged(accountId: string) {
  emit({ type: "changed", accountId });
}

/** Tells open windows to read the accounts again (a Google sign-in added or dropped). */
/** Reads the account's calendar now (after an invite answer changes the mail calendar) and tells open windows. */
export async function refreshCalendar(account: AccountRow) {
  if (await syncCalendar(account, true)) emit({ type: "calendar", accountId: account.id });
}

export function emitAccounts() {
  emit({ type: "accounts" });
}

export function notifySettings() {
  emit({ type: "settings" });
}

/** Sends a sample code to the desktop shell (dev-only test route). */
export function notifyTestCode(code: DesktopCode) {
  emit({ type: "code", ...code });
}

/** Sends a sample meeting to the desktop shell (dev-only test route). */
export function notifyTestMeeting(meeting: DesktopMeeting) {
  emit({ type: "meeting", ...meeting });
}

/** Sends a sample "notify now" email to the desktop shell (dev-only test route). */
export function notifyTestMail(mail: DesktopMail) {
  emit({ type: "mail", notify: "now", ...mail });
}

/** Meetings about to start go to the Kite bar, each occurrence once (server/meetings.ts). */
function announceMeetings() {
  if (shouldNotify({ kind: "meeting" }, getPreferences().notifications) !== "now") return;
  try {
    for (const meeting of dueMeetings()) emit({ type: "meeting", ...meeting });
  } catch (error) {
    console.error("Meetings:", error instanceof Error ? error.message : error);
  }
}

/**
 * Changes labels on one conversation at the provider and mirrors it locally. A conversation that
 * holds whole provider threads changes them; one split off or merged changes only its own
 * messages, so the rest of the provider's thread is untouched.
 */
async function changeLabels(account: AccountRow, key: string, add: string[], remove: string[]): Promise<MoveStep[]> {
  const id = `${account.id}:${key}`;
  const mail = mailOf(account);
  const isFolder = folderTest(account.id);
  if (!add.some(isFolder) && !remove.some(isFolder)) {
    const targets = opTargets(account.id, id);
    await mail.modifyThreads(account, targets.threads, { add, remove });
    await mail.modifyMessages(account, targets.messages, { add, remove });
    updateLabels(id, add, remove);
    return [];
  }
  // A folder: each message moves from where it is (Inbox, Archive, another folder), so each one
  // gets its own change, and its own way back for Undo.
  const row = getThreadRow(id);
  if (!row) return [];
  const rowLabels = JSON.parse(row.labels) as string[];
  const groups = new Map<string, MoveStep>();
  for (const m of (JSON.parse(row.data) as Thread).messages) {
    const before = new Set(m.labels ?? rowLabels);
    const after = applyLabelChange(before, { add, remove }, isFolder);
    const added = [...after].filter((l) => !before.has(l)).sort();
    const removed = [...before].filter((l) => !after.has(l)).sort();
    if (!added.length && !removed.length) continue;
    const sig = `${added}|${removed}`;
    const group = groups.get(sig) ?? { accountId: account.id, threadId: id, ids: [], add: added, remove: removed };
    group.ids.push(m.id);
    groups.set(sig, group);
  }
  for (const g of groups.values()) {
    await mail.modifyMessages(account, g.ids, { add: g.add, remove: g.remove });
    updateMessageLabels(id, g.ids, g.add, g.remove);
  }
  return [...groups.values()].map((g) => ({ ...g, add: g.remove, remove: g.add }));
}

/** One group of messages' way back from a move: the labels to put back and take off. */
type MoveStep = { accountId: string; threadId: string; ids: string[]; add: string[]; remove: string[] };

/** Puts moved messages back where each one was. */
export async function undoMove(undoId: string) {
  const steps = takeUndo<MoveStep>("move", undoId);
  if (!steps) throw new LabelError("That move can't be undone any more.");
  const touched = new Set<string>();
  for (const step of steps) {
    const account = getAccount(step.accountId);
    if (!account) continue;
    await mailOf(account).modifyMessages(account, step.ids, { add: step.add, remove: step.remove });
    updateMessageLabels(step.threadId, step.ids, step.add, step.remove);
    touched.add(account.id);
  }
  touched.forEach(notifyChanged);
}

/**
 * Marks a conversation unread the way people expect: only its newest message from someone else,
 * so your own replies never turn unread (a provider's thread-wide change would mark them too).
 */
async function markUnread(account: AccountRow, key: string) {
  const id = `${account.id}:${key}`;
  const row = getThreadRow(id);
  const target = row ? unreadTarget(JSON.parse(row.data) as Thread) : undefined;
  if (!target) return;
  await mailOf(account).modifyMessages(account, [target], { add: [UNREAD], remove: [] });
  updateMessageLabels(id, [target], [UNREAD], []);
}

/** Runs a thread operation at the provider and mirrors it locally. `key` is the thread id after the account. */
export async function runOp(account: AccountRow, key: string, op: ThreadOp, until?: string, notify = true) {
  const id = `${account.id}:${key}`;
  const targets = opTargets(account.id, id);
  const mail = mailOf(account);
  if (op === "untrash") {
    const row = getThreadRow(id);
    const messages = row ? (JSON.parse(row.data) as Thread).messages.filter((m) => m.labels?.includes("TRASH")).map((m) => m.id) : [];
    await mail.modifyMessages(account, messages, LABEL_OPS.untrash);
    updateMessageLabels(id, messages, LABEL_OPS.untrash.add, LABEL_OPS.untrash.remove);
  }
  else if (op === "unread") await markUnread(account, key);
  else {
    await mail.modifyThreads(account, targets.threads, LABEL_OPS[op]);
    await mail.modifyMessages(account, targets.messages, LABEL_OPS[op]);
    updateLabels(id, LABEL_OPS[op].add, LABEL_OPS[op].remove);
  }
  if (op === "snooze") setSnooze(account.id, key, until ?? new Date(Date.now() + 86_400_000).toISOString());
  if (op === "unsnooze") setSnooze(account.id, key, null);
  if (op === "archive" || op === "trash") new Set([...targets.threads, homeRemote(key)]).forEach((remote) => clearFollowup(account.id, remote));
  if (notify) notifyChanged(account.id);
}

/**
 * Moves some messages of one conversation to Trash, or back (`untrash`): "Delete this message" and
 * its Undo. Only ids the stored conversation holds are touched; the rest of it stays where it is.
 */
export async function runMessageOp(account: AccountRow, key: string, op: "trash" | "untrash", messageIds: string[]) {
  const id = `${account.id}:${key}`;
  const row = getThreadRow(id);
  const held = new Set(row ? (JSON.parse(row.data) as Thread).messages.map((m) => m.id) : []);
  const messages = messageIds.filter((m) => held.has(m));
  if (!messages.length) return;
  await mailOf(account).modifyMessages(account, messages, LABEL_OPS[op]);
  updateMessageLabels(id, messages, LABEL_OPS[op].add, LABEL_OPS[op].remove);
  notifyChanged(account.id);
}

/**
 * Adds and removes the user's own labels on many conversations: tags stay where they are, a
 * folder moves the mail into it (`undo` then names the way back). Only labels the account really
 * has are accepted, so this path can never move mail between built-in mailboxes. A few at a
 * time, one "changed" per account at the end.
 */
export async function runLabelChange(items: { account: AccountRow; key: string }[], add: string[], remove: string[]) {
  for (const { account } of items) {
    if (!labelAdapter(account)) throw new LabelError(`Kite can't change ${providerSpec(account.provider).name} ${providerSpec(account.provider).organise.plural} yet.`);
    if (!ownLabels(account.id, [...add, ...remove])) throw new LabelError("That label isn't in this account any more. Refresh and try again.");
  }
  let failed = 0;
  let next = 0;
  const steps: MoveStep[] = [];
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        steps.push(...(await changeLabels(item.account, item.key, add, remove)));
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
  for (const id of new Set(items.map((i) => i.account.id))) notifyChanged(id);
  return { done: items.length - failed, failed, undo: steps.length ? saveUndo("move", steps) : undefined };
}

/**
 * Runs one operation on many threads (bulk select), a few at a time to stay inside
 * the provider's rate limit, and tells open windows once per account at the end.
 */
export async function runOps(
  items: { account: AccountRow; key: string }[],
  op: ThreadOp,
  until?: string,
) {
  let failed = 0;
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      try {
        await runOp(item.account, item.key, op, until, false);
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(5, items.length) }, worker));
  for (const id of new Set(items.map((i) => i.account.id))) notifyChanged(id);
  return { done: items.length - failed, failed };
}

/** What the engine is doing right now (for `pnpm perf` to tell when sync has settled). */
export function syncActivity() {
  return { running: engine.running.size, progress: Object.fromEntries(engine.progress) };
}
