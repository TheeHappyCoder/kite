import "server-only";

import type { Thread } from "@/lib/mail/types";
import { usesAi, RuleSchema } from "@/lib/rules/spec";
import { AiLimitReached, AiUnavailable, aiConfigured, getAiSettings, modelFor } from "./ai";
import { draftForRule } from "./ai-mail";
import { getAccount, getDb, type AccountRow } from "./db";
import { getPrepared, putPrepared } from "./prepared";
import { getPreferences } from "./settings";
import { getThreadRow } from "./store";

// A rule's "Draft with AI": the only AI Kite runs without a click. The rule engine queues a job
// (rule-verbs.ts, only for rules with "Allow AI" on); the sync tick runs at most one job per tick,
// spaced apart. What each draft uses goes in the usage ledger and counts against the AI limits
// (server/ai-usage.ts): a job refused at a limit is skipped, not counted as an error. Errors back
// off, and three in a row pause it until you press Resume. The AI sees only the new email's fresh text (server/ai-mail.ts), every
// call is in the privacy log, and the draft only waits in the quick-reply box: nothing is sent.

/** At least this long between two requests. */
const SPACING_MS = 20_000;
/** Waits after one, two failures in a row; the third pauses everything. */
const BACKOFF_MS = [60_000, 5 * 60_000];
const PAUSE_AFTER = 3;
/** A job tries at most this often before it's marked failed. */
const MAX_ATTEMPTS = 3;
/** Jobs waiting longer than this (Kite closed, paused) are dropped: the mail has moved on. */
const STALE_MS = 24 * 3_600_000;

type State = { failures: number; retryAt: string | null; pausedReason: string | null; lastCallAt: string | null };
const EMPTY: State = { failures: 0, retryAt: null, pausedReason: null, lastCallAt: null };

type JobRow = {
  id: string;
  thread_id: string;
  account_id: string;
  rule_id: string;
  rule_name: string;
  message_id: string;
  instruction: string;
  status: "queued" | "done" | "failed" | "skipped" | "cancelled";
  reason: string | null;
  attempts: number;
  created_at: string;
  ran_at: string | null;
};

const now = () => new Date().toISOString();

function readState(): State {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'ai_drafts'").get() as { value: string } | undefined;
  return row ? { ...EMPTY, ...(JSON.parse(row.value) as Partial<State>) } : EMPTY;
}

function writeState(state: State) {
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('ai_drafts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(state));
}

/** Why a new job wouldn't be queued now (switched off, paused, no AI), or null. */
export function draftsBlocked(): string | null {
  if (!getPreferences().aiDrafts.on) return "AI drafts are switched off";
  if (readState().pausedReason) return "AI drafts are paused after errors";
  if (!aiConfigured()) return "No AI is connected";
  return null;
}

type AiDraftJob = { id: string; threadId: string; accountId: string; ruleId: string; ruleName: string; messageId: string; instruction: string };

export function queueAiDraft(job: AiDraftJob) {
  getDb()
    .prepare(
      `INSERT INTO ai_jobs (id, thread_id, account_id, rule_id, rule_name, message_id, instruction, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    )
    .run(job.id, job.threadId, job.accountId, job.ruleId, job.ruleName, job.messageId, job.instruction, now());
}

/** The model the rule picked for its drafts, as it stands now (read straight from the rules table: rules.ts imports this module). */
function ruleModel(ruleId: string): string | null {
  const row = getDb().prepare("SELECT data FROM rules WHERE id = ?").get(ruleId) as { data: string } | undefined;
  return row ? ((JSON.parse(row.data) as { aiModel?: string | null }).aiModel ?? null) : null;
}

function finish(id: string, status: JobRow["status"], reason: string | null) {
  getDb().prepare("UPDATE ai_jobs SET status = ?, reason = ? WHERE id = ?").run(status, reason, id);
}

/** Whether the job still makes sense: the rule still wants it and nobody has answered yet. */
function stillWanted(job: JobRow, account: AccountRow | undefined, thread: Thread | null): string | null {
  if (!account) return "The account was disconnected";
  if (!thread) return "The conversation is gone";
  const row = getDb().prepare("SELECT enabled, data FROM rules WHERE id = ?").get(job.rule_id) as { enabled: number; data: string } | undefined;
  const rule = row ? RuleSchema.safeParse({ ...JSON.parse(row.data), id: job.rule_id }) : null;
  if (!rule?.success || !row?.enabled) return "The rule was paused or deleted";
  if (!rule.data.ai || !usesAi(rule.data)) return "The rule no longer allows AI";
  const at = thread.messages.findIndex((m) => m.id === job.message_id);
  if (at < 0) return "The email is gone";
  const me = account.email.toLowerCase();
  if (thread.messages.slice(at + 1).some((m) => !m.draft && m.from.email.toLowerCase() === me)) return "You already replied";
  const prepared = getPrepared(job.thread_id);
  if (prepared && prepared.id !== job.id) return "Another reply is already waiting";
  return null;
}

type Hooks = {
  /** Downloads the conversation's bodies when they aren't stored yet (sync.ts loadFullThread). */
  loadFull: (account: AccountRow, key: string) => Promise<unknown>;
  /** A draft landed: the app shows it if the conversation is open. */
  landed: (threadId: string, accountId: string) => void;
};

const g = globalThis as typeof globalThis & { __kiteAiDrafts?: boolean };

/** Runs the oldest waiting job, if switched on, not paused and spaced. Called from the sync tick. */
export async function runAiDrafts(hooks: Hooks) {
  if (g.__kiteAiDrafts) return;
  g.__kiteAiDrafts = true;
  try {
    await runOne(hooks);
  } finally {
    g.__kiteAiDrafts = false;
  }
}

async function runOne(hooks: Hooks) {
  const db = getDb();
  db.prepare("UPDATE ai_jobs SET status = 'skipped', reason = 'Waited more than a day' WHERE status = 'queued' AND created_at < ?").run(
    new Date(Date.now() - STALE_MS).toISOString(),
  );
  db.prepare("DELETE FROM ai_jobs WHERE created_at < ?").run(new Date(Date.now() - 62 * 86_400_000).toISOString());
  const prefs = getPreferences().aiDrafts;
  const state = readState();
  if (!prefs.on || state.pausedReason) return;
  const at = Date.now();
  if (state.retryAt && Date.parse(state.retryAt) > at) return;
  if (state.lastCallAt && at - Date.parse(state.lastCallAt) < SPACING_MS) return;

  const job = db.prepare("SELECT * FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1").get() as JobRow | undefined;
  if (!job) return;
  if (!aiConfigured()) return finish(job.id, "skipped", "No AI is connected");

  const account = getAccount(job.account_id);
  const key = job.thread_id.slice(job.account_id.length + 1);
  let row = getThreadRow(job.thread_id);
  if (account && row && !row.full) {
    await hooks.loadFull(account, key);
    row = getThreadRow(job.thread_id);
  }
  const thread = row ? (JSON.parse(row.data) as Thread) : null;
  const unwanted = stillWanted(job, account, thread);
  if (unwanted) return finish(job.id, "skipped", unwanted);
  const message = thread!.messages.find((m) => m.id === job.message_id)!;

  writeState({ ...state, lastCallAt: now() });
  db.prepare("UPDATE ai_jobs SET attempts = attempts + 1, ran_at = ? WHERE id = ?").run(now(), job.id);
  try {
    const body = await draftForRule(account!, thread!, message, job.instruction, { id: job.rule_id, name: job.rule_name, model: ruleModel(job.rule_id) });
    // Discarded or undone while the AI worked: the draft is dropped (the ledger keeps what it used).
    const cancelled = (db.prepare("SELECT status FROM ai_jobs WHERE id = ?").get(job.id) as { status: string } | undefined)?.status !== "queued";
    if (!cancelled) db.prepare("UPDATE ai_jobs SET status = 'done', reason = NULL WHERE id = ?").run(job.id);
    writeState({ ...readState(), failures: 0, retryAt: null });
    // Answered while the AI worked: the draft is dropped.
    if (cancelled || !body || stillWanted(job, account, JSON.parse(getThreadRow(job.thread_id)?.data ?? "null") as Thread | null)) return;
    putPrepared(job.thread_id, job.account_id, { id: job.id, ruleId: job.rule_id, ruleName: job.rule_name, messageId: job.message_id, body, missing: [], ai: true });
    hooks.landed(job.thread_id, job.account_id);
  } catch (error) {
    // Refused before it was sent: not the AI's fault, so no backoff or pause.
    if (error instanceof AiLimitReached) return finish(job.id, "skipped", error.message);
    const reason = error instanceof AiUnavailable ? error.message : "The AI request failed";
    const failures = readState().failures + 1;
    const paused = failures >= PAUSE_AFTER;
    writeState({
      ...readState(),
      failures,
      retryAt: paused ? null : new Date(Date.now() + BACKOFF_MS[failures - 1]).toISOString(),
      pausedReason: paused ? reason : null,
    });
    if (job.attempts + 1 >= MAX_ATTEMPTS) finish(job.id, "failed", reason);
    else db.prepare("UPDATE ai_jobs SET reason = ? WHERE id = ?").run(reason, job.id);
    console.error("AI draft failed:", reason);
  }
}

/** Resume after errors: clears the pause and the wait. */
export function resumeAiDrafts() {
  writeState({ ...readState(), failures: 0, retryAt: null, pausedReason: null });
}

type AiDraftsView = {
  on: boolean;
  model: string | null;
  configured: boolean;
  pausedReason: string | null;
  retryAt: string | null;
  waiting: number;
  /** The latest jobs, for "why didn't it draft?" */
  recent: { id: string; ruleName: string; subject: string; status: JobRow["status"]; reason: string | null; at: string }[];
};

export function aiDraftsView(): AiDraftsView {
  const db = getDb();
  const state = readState();
  const settings = getAiSettings();
  const recent = db
    .prepare(
      `SELECT j.id, j.rule_name, j.status, j.reason, COALESCE(j.ran_at, j.created_at) AS at,
         json_extract(t.list_data, '$.subject') AS subject
       FROM ai_jobs j LEFT JOIN threads t ON t.id = j.thread_id ORDER BY j.created_at DESC LIMIT 8`,
    )
    .all() as { id: string; rule_name: string; status: JobRow["status"]; reason: string | null; at: string; subject: string | null }[];
  return {
    on: getPreferences().aiDrafts.on,
    model: settings ? modelFor(settings, "rule_drafts").name : null,
    configured: aiConfigured(),
    pausedReason: state.pausedReason,
    retryAt: state.retryAt && Date.parse(state.retryAt) > Date.now() ? state.retryAt : null,
    waiting: (db.prepare("SELECT COUNT(*) AS n FROM ai_jobs WHERE status = 'queued'").get() as { n: number }).n,
    recent: recent.map((r) => ({ id: r.id, ruleName: r.rule_name, subject: r.subject ?? "(conversation no longer here)", status: r.status, reason: r.reason, at: r.at })),
  };
}
