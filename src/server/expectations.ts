import "server-only";

import { replyDraft, emptyDraft, type ComposeDraft } from "@/lib/mail/compose";
import { stepOf, type ExpectPerson, type ExpectPlan, type Expectation, type ExpectStep } from "@/lib/automations/expect";
import { fillBlanks, messageBlanks } from "@/lib/rules/prepared";
import { inScope, type AccountScope } from "@/lib/mail/scope";
import type { Message, Thread } from "@/lib/mail/types";
import { getAccount, getDb, type AccountRow } from "./db";
import { discardPrepared, putPrepared } from "./prepared";
import { getThreadRow, rowsHolding } from "./store";

// The expect verb's waiting list (lib/automations/expect.ts): answers automations wait for. Rows
// come from a rule run on new or sent mail (one per conversation) or a scheduled run (one per
// person and period). Mail arriving settles them (`settleArrived`, from the rules engine); your
// own mail to them counts as the request or a nudge. The sync tick (`tickExpectations`) sends what
// `auto` allows and, for a conversation, puts the next nudge in its quick reply and the
// conversation back in the inbox. Nothing is sent without `auto`, except by the user's tap.

type Row = {
  id: string;
  rule_id: string;
  rule_name: string;
  account_id: string;
  thread_id: string | null;
  message_id: string | null;
  who: string;
  subject: string;
  answer: string;
  plan: string;
  period: string | null;
  since: string;
  due_at: string;
  asked_at: string | null;
  nudged: number;
  nudged_at: string | null;
  surfaced: number;
  status: Expectation["status"];
  met_at: string | null;
  met_thread: string | null;
  error: string | null;
};

const DAY = 86_400_000;
/** Your own mail to them within this long after Kite sent a step is that step, not another nudge. */
const SAME_STEP_MS = 10 * 60_000;
/** Date headers drop milliseconds and clocks drift: mail this close before the wait started still counts. */
const SLACK_MS = 60_000;

const now = () => new Date().toISOString();

function view(r: Row): Expectation {
  return {
    id: r.id,
    ruleId: r.rule_id,
    ruleName: r.rule_name,
    accountId: r.account_id,
    threadId: r.thread_id,
    who: JSON.parse(r.who) as ExpectPerson[],
    subject: r.subject,
    answer: r.answer,
    plan: JSON.parse(r.plan) as ExpectPlan,
    since: r.since,
    dueAt: r.due_at,
    askedAt: r.asked_at,
    nudged: r.nudged,
    nudgedAt: r.nudged_at,
    status: r.status,
    metAt: r.met_at,
    metThreadId: r.met_thread,
    error: r.error,
  };
}

const getRow = (id: string) => getDb().prepare("SELECT * FROM expectations WHERE id = ?").get(id) as Row | undefined;

export class ExpectError extends Error {
  name = "ExpectError";
}

/** Whether this automation already waits on this conversation. */
export function waitingOn(ruleId: string, threadId: string) {
  return !!getDb().prepare("SELECT 1 FROM expectations WHERE rule_id = ? AND thread_id = ? AND status = 'waiting'").get(ruleId, threadId);
}

/** Starts waiting. Returns the new id, or null when the same wait already exists (a schedule's person and period). */
export function createExpectation(input: {
  ruleId: string;
  ruleName: string;
  accountId: string;
  threadId: string | null;
  messageId: string | null;
  who: ExpectPerson[];
  subject: string;
  answer: string;
  plan: ExpectPlan;
  period: string | null;
  since: string;
  days: number;
}): string | null {
  const id = crypto.randomUUID();
  const due = new Date(Date.parse(input.since) + input.days * DAY).toISOString();
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO expectations (id, rule_id, rule_name, account_id, thread_id, message_id, who, subject, answer, plan, period, since, due_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'waiting', ?)`,
    )
    .run(
      id,
      input.ruleId,
      input.ruleName,
      input.accountId,
      input.threadId,
      input.messageId,
      JSON.stringify(input.who.map((p) => ({ email: p.email.toLowerCase(), name: p.name }))),
      input.subject,
      input.answer,
      JSON.stringify(input.plan),
      input.period,
      input.since,
      due,
      now(),
    );
  return result.changes ? id : null;
}

/** Undo of the run that started it: gone, with any nudge it left in the quick reply. */
export function removeExpectation(id: string) {
  const row = getRow(id);
  if (!row) return;
  if (row.thread_id) discardPrepared(row.thread_id, preparedId(row.id));
  getDb().prepare("DELETE FROM expectations WHERE id = ?").run(id);
}

const preparedId = (id: string) => `expect:${id}`;

/** Everything still waiting in scope, plus what was answered or stopped in the last `doneDays`. */
export function listExpectations(scope: AccountScope, doneDays = 14): Expectation[] {
  const since = new Date(Date.now() - doneDays * DAY).toISOString();
  const rows = getDb()
    .prepare("SELECT * FROM expectations WHERE status = 'waiting' OR coalesce(met_at, created_at) >= ? ORDER BY due_at")
    .all(since) as Row[];
  return rows.filter((r) => inScope(scope, r.account_id)).map(view);
}

/** How many have something to send now (the sidebar's count). */
export function readyCount(scope: AccountScope) {
  const at = Date.now();
  return (getDb().prepare("SELECT * FROM expectations WHERE status = 'waiting'").all() as Row[]).filter((r) => {
    if (!inScope(scope, r.account_id)) return false;
    const step = stepOf(view(r), at);
    return step.kind === "ask" || step.kind === "nudge";
  }).length;
}

/** The user's "Received" / "Paid", or "Stop waiting". */
export function closeExpectation(id: string, status: "met" | "stopped") {
  const row = getRow(id);
  if (!row) throw new ExpectError("That's gone. Refresh and try again.");
  getDb().prepare("UPDATE expectations SET status = ?, met_at = ? WHERE id = ?").run(status, now(), id);
  if (row.thread_id) discardPrepared(row.thread_id, preparedId(id));
  return row.account_id;
}

/** "Waiting again": a closed one opens, with its ladder where it was. */
export function reopenExpectation(id: string) {
  const row = getRow(id);
  if (!row) throw new ExpectError("That's gone. Refresh and try again.");
  getDb().prepare("UPDATE expectations SET status = 'waiting', met_at = NULL, met_thread = NULL WHERE id = ?").run(id);
  return row.account_id;
}

// ---------------------------------------------------------------------------
// Mail arriving: answers, and your own mail as a step
// ---------------------------------------------------------------------------

/** Whether one message matches an answer's search (the rules engine's matcher, passed in). */
export type AnswerTest = (thread: Thread, message: Message, answer: string) => boolean;

/** An answer's search names who it comes from itself (a payment service): then anyone counts. */
const namesSender = (answer: string) => /(^|\s)-?from:/i.test(answer);

/**
 * Mail just stored in `threadId`: an answer from someone an expectation waits on settles it; your
 * own mail to them is the request, or a nudge sent by hand. Returns the accounts that changed.
 */
export function settleArrived(account: AccountRow, threadId: string, fresh: Message[], matches: AnswerTest) {
  const rows = getDb().prepare("SELECT * FROM expectations WHERE status = 'waiting' AND account_id = ?").all(account.id) as Row[];
  if (!rows.length) return false;
  const row = getThreadRow(threadId);
  const thread = row ? (JSON.parse(row.data) as Thread) : null;
  if (!thread) return false;
  const me = account.email.toLowerCase();
  let changed = false;
  for (const m of fresh) {
    if (m.draft) continue;
    const from = m.from.email.toLowerCase();
    for (const r of rows) {
      if (r.status !== "waiting" || Date.parse(m.date) < Date.parse(r.since) - SLACK_MS) continue;
      const who = (JSON.parse(r.who) as ExpectPerson[]).map((p) => p.email);
      if (from === me) {
        // Your own mail to them: the request, else a nudge you sent by hand (or Kite's own, already counted).
        const to = [...m.to, ...(m.cc ?? [])].map((a) => a.email.toLowerCase());
        const plan = JSON.parse(r.plan) as ExpectPlan;
        const asking = !!plan.ask && !r.asked_at;
        // Mail to them about something else isn't a nudge: it has to be in the conversation (or be the request).
        if (!to.some((e) => who.includes(e)) || (r.thread_id && r.thread_id !== threadId && !asking)) continue;
        // A step Kite counted itself (sent by the tick) shows up here as your own mail moments later.
        const counted = r.nudged_at ? Date.parse(r.nudged_at) + SAME_STEP_MS : 0;
        if (asking) {
          getDb().prepare("UPDATE expectations SET asked_at = ?, thread_id = ?, message_id = ? WHERE id = ?").run(m.date, threadId, m.id, r.id);
          Object.assign(r, { asked_at: m.date, thread_id: threadId, message_id: m.id });
          changed = true;
        } else if (stepOf(view(r)).kind === "nudge" && Date.parse(m.date) > counted) {
          getDb().prepare("UPDATE expectations SET nudged = nudged + 1, nudged_at = ? WHERE id = ?").run(m.date, r.id);
          r.nudged++;
          r.nudged_at = m.date;
          changed = true;
        }
        continue;
      }
      const answered = r.answer
        ? (namesSender(r.answer) || who.includes(from)) && matches(thread, m, r.answer)
        : // A scheduled request is answered by any email from them; a conversation by a reply in it.
          who.includes(from) && (!!r.period || !r.thread_id || r.thread_id === threadId);
      if (!answered) continue;
      getDb().prepare("UPDATE expectations SET status = 'met', met_at = ?, met_thread = ? WHERE id = ?").run(m.date, threadId, r.id);
      r.status = "met";
      if (r.thread_id) discardPrepared(r.thread_id, preparedId(r.id));
      changed = true;
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// The next message: a request or a nudge
// ---------------------------------------------------------------------------

/** The blanks a request or nudge fills: who it goes to, the subject, and the period of a scheduled run. */
function blanks(r: Row) {
  const who = JSON.parse(r.who) as ExpectPerson[];
  const values = messageBlanks({ name: who[0]?.name ?? "", email: who[0]?.email ?? "" }, r.subject);
  return { ...values, period: (JSON.parse(r.plan) as ExpectPlan).period ?? "" };
}

/** The stored message a nudge answers: the one waited on, else the newest real one in the conversation. */
function replyTarget(r: Row) {
  if (!r.thread_id) return null;
  const row = getThreadRow(r.thread_id);
  if (!row) return null;
  const thread = JSON.parse(row.data) as Thread;
  const sent = thread.messages.filter((m) => !m.draft);
  const message = sent.find((m) => m.id === r.message_id) ?? sent.at(-1);
  return message ? { thread, message } : null;
}

/** The draft for the step that's ready now (the request, or the next nudge), or null when nothing is. */
export function stepDraft(id: string): { account: AccountRow; draft: ComposeDraft; step: ExpectStep; missing: string[] } | null {
  const r = getRow(id);
  const account = r ? getAccount(r.account_id) : undefined;
  if (!r || !account) return null;
  const e = view(r);
  const step = stepOf(e);
  if (step.kind !== "ask" && step.kind !== "nudge") return null;
  const values = blanks(r);
  const text = step.kind === "ask" ? e.plan.ask : e.plan.nudges[step.index];
  const { body, missing } = fillBlanks(text, values);
  const target = step.kind === "nudge" ? replyTarget(r) : null;
  let draft: ComposeDraft;
  if (target) {
    draft = {
      ...replyDraft({
        mode: "replyAll",
        message: target.message,
        subject: target.thread.subject,
        accountId: account.id,
        me: account.email,
        threadId: target.message.remoteThread ?? target.thread.remoteId,
      }),
      body,
    };
    // A nudge is short: the conversation is right there, so no quoted copy below it.
    delete draft.quote;
  } else {
    const subject = fillBlanks(e.plan.askSubject || e.subject, values).body.replace(/\\(.)/g, "$1");
    draft = {
      ...emptyDraft(account.id),
      to: e.who.map((p) => (p.name ? { name: p.name, email: p.email } : { email: p.email })),
      subject: step.kind === "nudge" && !/^re:/i.test(subject) ? `Re: ${subject}` : subject,
      body,
    };
  }
  return { account, draft, step, missing };
}

/** The step went (sent by Kite, or held for Undo send): counted now, so the tick never sends it twice. */
export function recordStep(id: string, step: ExpectStep, sent?: { threadId: string | null }) {
  const at = now();
  if (step.kind === "ask") {
    getDb()
      .prepare("UPDATE expectations SET asked_at = ?, thread_id = coalesce(?, thread_id), error = NULL WHERE id = ?")
      .run(at, sent?.threadId ?? null, id);
  } else if (step.kind === "nudge") {
    getDb().prepare("UPDATE expectations SET nudged = nudged + 1, nudged_at = ?, error = NULL WHERE id = ?").run(at, id);
    const r = getRow(id);
    if (r?.thread_id) discardPrepared(r.thread_id, preparedId(id));
  }
}

/** A provider thread id as the Kite conversation now holding it. */
export function kiteThread(accountId: string, remoteId: string) {
  return rowsHolding(accountId, remoteId).sort((a, b) => b.row.last_date.localeCompare(a.row.last_date))[0]?.row.id ?? `${accountId}:${remoteId}`;
}

// ---------------------------------------------------------------------------
// The sync tick
// ---------------------------------------------------------------------------

type Hooks = {
  /** Sends a message now (sync.ts deliver); returns the provider thread it went in. */
  send: (account: AccountRow, draft: ComposeDraft) => Promise<{ threadId: string }>;
  /** Brings a conversation back to the top of the inbox, unread. */
  surface: (account: AccountRow, threadId: string) => Promise<void>;
};

/**
 * Due steps: sent when the automation sends by itself (`auto`), else a conversation's nudge waits
 * in its quick reply with the conversation back in the inbox (a request with no conversation
 * waits in Waiting on). Returns the accounts that changed.
 */
export async function tickExpectations(hooks: Hooks) {
  const rows = getDb().prepare("SELECT * FROM expectations WHERE status = 'waiting'").all() as Row[];
  const changed = new Set<string>();
  for (const r of rows) {
    const e = view(r);
    const step = stepOf(e);
    if (step.kind !== "ask" && step.kind !== "nudge") continue;
    const account = getAccount(r.account_id);
    if (!account) continue;
    if (e.plan.auto) {
      if (r.error && Date.now() - Date.parse(r.nudged_at ?? r.asked_at ?? r.since) < DAY) continue;
      const made = stepDraft(r.id);
      if (!made || made.missing.length) {
        getDb().prepare("UPDATE expectations SET error = ? WHERE id = ?").run(made?.missing.length ? `Fill in {${made.missing[0]}} to send it` : "Nothing to send", r.id);
        continue;
      }
      // Counted first: a slow send must never go out twice on the next tick.
      recordStep(r.id, step);
      try {
        const sent = await hooks.send(account, made.draft);
        if (step.kind === "ask") getDb().prepare("UPDATE expectations SET thread_id = ? WHERE id = ?").run(kiteThread(account.id, sent.threadId), r.id);
      } catch (error) {
        const undo = step.kind === "ask" ? "asked_at = NULL" : "nudged = nudged - 1";
        getDb().prepare(`UPDATE expectations SET ${undo}, error = ? WHERE id = ?`).run(error instanceof Error ? error.message.slice(0, 200) : "Couldn't send", r.id);
      }
      changed.add(account.id);
      continue;
    }
    if (step.kind === "nudge" && r.thread_id && r.surfaced < step.index) {
      const made = stepDraft(r.id);
      const target = replyTarget(r);
      if (!made || !target) continue;
      putPrepared(r.thread_id, account.id, { id: preparedId(r.id), ruleId: r.rule_id, ruleName: r.rule_name, messageId: target.message.id, body: made.draft.body, missing: made.missing });
      getDb().prepare("UPDATE expectations SET surfaced = ? WHERE id = ?").run(step.index, r.id);
      await hooks.surface(account, r.thread_id).catch(() => {});
      changed.add(account.id);
    }
  }
  return [...changed];
}

/** Rows answered or stopped more than 60 days ago go. */
export function pruneExpectations() {
  getDb().prepare("DELETE FROM expectations WHERE status != 'waiting' AND met_at < ?").run(new Date(Date.now() - 60 * DAY).toISOString());
}
