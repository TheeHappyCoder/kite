import "server-only";

import { parseSearch, matchesSearch, needsBody, type MatchFacts, type SearchTerm } from "@/lib/mail/search";
import { htmlToText } from "@/lib/mail/quotes";
import type { Message, Thread } from "@/lib/mail/types";
import { LAST_PRESET, PRESET_RULES } from "@/lib/rules/presets";
import {
  RuleDraftSchema,
  AI_VERBS,
  NEW_MAIL_ONLY,
  usesAi,
  RuleSchema,
  describeAction,
  type Condition,
  type NotifyMode,
  type Rule,
  type RuleDraft,
  type RuleRunView,
  type RuleView,
} from "@/lib/rules/spec";
import { getAccount, getDb, listAccounts, type AccountRow } from "./db";
import { getThreadRow, searchThreads, senderStatus } from "./store";
import { isMuted } from "./overrides";
import { discardPrepared } from "./prepared";
import { messageBlanks } from "@/lib/rules/prepared";
import { gmailFilterFor } from "@/lib/rules/gmail";
import { providerFor, providers } from "./providers/registry";
import { applyEffects, plan, undoSteps, type ActionResult, type RuleWork, type UndoStep, type VerbContext } from "./rule-verbs";
import { checksHold, needsText, readFields, type EmailFacts, type FieldValues } from "@/lib/automations/fields";
import { nextOccurrence, referenceProblem, type Trigger } from "@/lib/rules/spec";
import { settleArrived } from "./expectations";
import { forgetSchedule, markScheduled } from "./schedules";

// The rules engine: everything Kite does to mail by itself. Rules run top to bottom on each
// conversation that just received mail (sync.ts refreshThread, right after placeRemote), or on
// existing mail when the user presses "Run on existing mail". Kite's own changes come back from
// Gmail as label changes with no new messages, so actions never trigger rules again. A rule the
// user undid on a conversation leaves that conversation alone from then on.

const GMAIL_FAILED = "Gmail didn't accept the change";

type Active = Rule;

type RuleRow = { id: string; position: number; enabled: number; preset: string | null; data: string };

// On globalThis like the sync engine: routes can load their own copy of this module, and an edit
// saved through one must reach the copy sync runs.
const g = globalThis as typeof globalThis & { __kiteRules?: { rules: Rule[]; terms: Map<string, SearchTerm[]> } | null };

/** Drops the in-memory copy (after a write, or when the database was emptied). */
export function forgetRules() {
  g.__kiteRules = null;
}

function now() {
  return new Date().toISOString();
}

/** Stored rules in order, with any missing built-in rule added (first start, after "Erase everything"). */
function storedRules() {
  if (g.__kiteRules) return g.__kiteRules.rules;
  const db = getDb();
  const rows = () => db.prepare("SELECT * FROM rules ORDER BY position").all() as RuleRow[];
  let list = rows();
  const have = new Set(list.map((r) => r.preset));
  const missing = PRESET_RULES.filter((p) => !have.has(p.preset));
  if (missing.length) {
    const insert = db.prepare("INSERT INTO rules (id, position, enabled, preset, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    let position = list.length ? Math.max(...list.map((r) => r.position)) + 1 : 0;
    for (const { about: _about, ...preset } of missing) {
      void _about;
      const rule = RuleSchema.parse({ ...preset, id: crypto.randomUUID() });
      insert.run(rule.id, position++, rule.enabled ? 1 : 0, rule.preset!, JSON.stringify(rule), now(), now());
    }
    list = rows();
  }
  const rules = list.flatMap((row) => {
    const parsed = RuleSchema.safeParse({ ...JSON.parse(row.data), id: row.id, enabled: !!row.enabled, preset: row.preset ?? undefined });
    return parsed.success ? [parsed.data] : [];
  });
  g.__kiteRules = { rules, terms: new Map(rules.map((r) => [r.id, parseSearch(r.query)])) };
  return rules;
}

/** Every rule in run order, with how their Gmail filters stand. */
export function listRules(): RuleView[] {
  const states = new Map(providers().flatMap((p) => [...(p.filters?.states() ?? [])]));
  return storedRules().map((r) => (states.has(r.id) ? { ...r, gmailFilters: states.get(r.id) } : r));
}

/** Whether the Screener rule ("Hold new senders") is on. */
export function screenerOn() {
  return storedRules().some((r) => r.preset === "screener" && r.enabled);
}

/** Whether any rule asks for a Gmail filter (sign-in then asks Google for permission to manage filters). */
export function gmailRulesExist() {
  return storedRules().some((r) => r.gmail);
}

/** Brings filters kept at the provider in line with the rules ("Also run in Gmail"); see providers/gmail/filters.ts. */
export async function syncFilters(only: { ruleId?: string; accountId?: string } = {}) {
  for (const provider of providers()) await provider.filters?.sync(storedRules, only);
}

function termsOf(rule: Rule) {
  return g.__kiteRules?.terms.get(rule.id) ?? parseSearch(rule.query);
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

class RuleError extends Error {
  name = "RuleError";
}

function stored(id: string) {
  const rule = storedRules().find((r) => r.id === id);
  if (!rule) throw new RuleError("That rule is gone. Refresh and try again.");
  return rule;
}

/** "Also run in Gmail" only for a rule Gmail can express (the editor offers it only then). */
function checkGmail(rule: Rule) {
  if (!rule.gmail) return rule;
  const check = gmailFilterFor(rule);
  if (!check.ok) throw new RuleError(`This rule can't run in Gmail: ${check.reason}`);
  return rule;
}

/** "Draft with AI" only with "Allow AI" on: the user decides, per rule, that mail may go to their AI. */
function checkAi(rule: Rule) {
  if (usesAi(rule) && !rule.ai) throw new RuleError("Turn on “Allow AI” to let this rule draft with AI.");
  const problem = referenceProblem(rule);
  if (problem) throw new RuleError(problem);
  return rule;
}

function write(rule: Rule) {
  getDb().prepare("UPDATE rules SET enabled = ?, data = ?, updated_at = ? WHERE id = ?").run(rule.enabled ? 1 : 0, JSON.stringify(rule), now(), rule.id);
  forgetRules();
}

/** A new rule goes just above "Everyone else: notify", so a catch-all notify stays last. */
export function createRule(draft: RuleDraft) {
  const parsed = RuleDraftSchema.parse(draft);
  const rule = checkAi(checkGmail(RuleSchema.parse({ ...parsed, id: crypto.randomUUID() })));
  const db = getDb();
  const rules = storedRules();
  const last = rules.findIndex((r) => r.preset === LAST_PRESET);
  const position = last < 0 ? rules.length : last;
  db.exec("BEGIN");
  try {
    rules.forEach((r, i) => db.prepare("UPDATE rules SET position = ? WHERE id = ?").run(i >= position ? i + 1 : i, r.id));
    db.prepare("INSERT INTO rules (id, position, enabled, preset, data, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?)").run(
      rule.id,
      position,
      rule.enabled ? 1 : 0,
      JSON.stringify(rule),
      now(),
      now(),
    );
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  forgetRules();
  // A schedule starts from now: a day already gone this month doesn't run at once.
  if (rule.when === "schedule") markScheduled(rule.id);
  return rule;
}

export function updateRule(id: string, draft: RuleDraft) {
  const current = stored(id);
  const rule = checkAi(checkGmail(RuleSchema.parse({ ...RuleDraftSchema.parse(draft), id, preset: current.preset })));
  write(rule);
  if (rule.when === "schedule" && (current.when !== "schedule" || JSON.stringify(current.schedule) !== JSON.stringify(rule.schedule))) markScheduled(rule.id);
  return rule;
}

export function setRuleEnabled(id: string, enabled: boolean) {
  write({ ...stored(id), enabled });
}

export function deleteRule(id: string) {
  if (stored(id).preset) throw new RuleError("Built-in rules can be paused, not deleted.");
  getDb().prepare("DELETE FROM rules WHERE id = ?").run(id);
  getDb().prepare("DELETE FROM rule_delays WHERE rule_id = ?").run(id);
  forgetSchedule(id);
  forgetRules();
}

/** New order from Settings. */
export function reorderRules(ids: string[]) {
  const rules = storedRules();
  const known = new Set(rules.map((r) => r.id));
  const order = [...ids.filter((id) => known.has(id)), ...rules.map((r) => r.id).filter((id) => !ids.includes(id))];
  const db = getDb();
  db.exec("BEGIN");
  try {
    order.forEach((id, i) => db.prepare("UPDATE rules SET position = ? WHERE id = ?").run(i, id));
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  forgetRules();
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** What the conditions look at, worked out once per conversation and only when a rule asks. */
type Facts = {
  sender: string | null;
  /** Mail you send: everyone it went to ("To these people" holds when any of them is listed). */
  others?: string[];
  /** The sender's status before this mail (null: Kite has never seen them). */
  status: () => ReturnType<typeof senderStatus>;
  vip: () => boolean;
  muted: () => boolean;
};

function lazy<T>(get: () => T) {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = get();
      done = true;
    }
    return value;
  };
}

function conditionHolds(c: Condition, f: Facts) {
  let hit: boolean;
  switch (c.kind) {
    case "vip":
      hit = f.vip();
      break;
    case "muted":
      hit = f.muted();
      break;
    case "senders":
      hit = f.others ? f.others.some((e) => c.emails.includes(e)) : !!f.sender && c.emails.includes(f.sender);
      break;
    case "sender": {
      if (!f.sender) return false;
      const status = f.status();
      hit = c.status === "new" ? status === null : status === c.status;
      break;
    }
  }
  return hit !== c.negate;
}

/** The people your newest sent message went to (To, then Cc), never yourself. */
function recipientsOf(messages: Message[], me: string) {
  const mine = [...messages].reverse().find((m) => !m.draft && m.from.email.toLowerCase() === me);
  if (!mine) return null;
  const seen = new Set<string>();
  const people = [...mine.to, ...(mine.cc ?? [])].filter((a) => {
    const email = a.email.toLowerCase();
    if (email === me || seen.has(email)) return false;
    seen.add(email);
    return true;
  });
  return { message: mine, people: people.map((a) => ({ email: a.email.toLowerCase(), name: a.name && a.name !== a.email ? a.name : "" })) };
}

/**
 * What conditions look at. For mail you send, "the sender" is who it went to (the first
 * recipient), so "From these people" reads as "To these people".
 */
function factsFor(account: AccountRow, threadId: string, messages: Message[], statusOf: (email: string) => ReturnType<typeof senderStatus> = senderStatus, trigger: Trigger = "new_mail"): Facts {
  const me = account.email.toLowerCase();
  const sender =
    trigger === "sent"
      ? (recipientsOf(messages, me)?.people[0]?.email ?? null)
      : ([...messages].reverse().find((m) => m.from.email.toLowerCase() !== me)?.from.email.toLowerCase() ?? null);
  return {
    sender,
    others: trigger === "sent" ? (recipientsOf(messages, me)?.people.map((p) => p.email) ?? []) : undefined,
    status: lazy(() => (sender ? statusOf(sender) : null)),
    vip: lazy(() => !!sender && !!getDb().prepare("SELECT 1 FROM people WHERE email = ? AND vip = 1").get(sender)),
    muted: lazy(() => isMuted(threadId)),
  };
}


function labelLookup(accountId: string) {
  const rows = lazy(() => getDb().prepare("SELECT id, name FROM labels WHERE account_id = ?").all(accountId) as { id: string; name: string }[]);
  return {
    idFor: (name: string) => rows().find((r) => r.name.toLowerCase() === name.trim().toLowerCase())?.id ?? null,
    namesOf: (ids: string[]) => rows().filter((r) => ids.includes(r.id)).map((r) => r.name),
  };
}

function matchFacts(row: { labels: string }, names: (ids: string[]) => string[]): MatchFacts {
  const labels = JSON.parse(row.labels) as string[];
  const text = new Map<string, string>();
  return {
    labels,
    labelNames: names(labels),
    text: (m) => {
      if (!m.html) return "";
      if (!text.has(m.id)) text.set(m.id, htmlToText(m.html));
      return text.get(m.id)!;
    },
  };
}

type Read = NonNullable<VerbContext["read"]>;

/**
 * The email an automation reads: the newest one someone else sent (of `among`, when given), else
 * the newest; for mail you send (`mine`), your newest one.
 */
function readable(thread: Thread, me: string, among?: Set<string>, mine = false) {
  const sent = thread.messages.filter((m) => !m.draft && (!among || among.has(m.id)));
  if (mine) return [...sent].reverse().find((m) => m.from.email.toLowerCase() === me) ?? null;
  return [...sent].reverse().find((m) => m.from.email.toLowerCase() !== me) ?? sent.at(-1) ?? null;
}

/**
 * The email an automation reads from a conversation, as Read sees it: the body when Kite has it,
 * else the preview. For mail you send (`mine`) the "sender" is who it went to.
 */
export function emailOf(thread: Thread, me: string, among?: Set<string>, mine = false) {
  const message = readable(thread, me, among, mine);
  if (!message) return null;
  const text = message.html ? htmlToText(message.html) : message.body.length ? message.body.join("\n\n") : (message.snippet ?? message.preview ?? "");
  const other = mine ? (message.to.find((a) => a.email.toLowerCase() !== me) ?? message.to[0] ?? message.from) : message.from;
  const facts: EmailFacts = {
    senderName: other.name && other.name !== other.email ? other.name : "",
    senderEmail: other.email,
    subject: message.subject ?? thread.subject,
    date: message.date,
    text,
  };
  return { message, facts };
}

/** What an automation reads from a conversation (Read), from the stored copy. */
function readFor(rule: Rule, thread: Thread, me: string, among?: Set<string>): Read | null {
  const found = emailOf(thread, me, among, rule.when === "sent");
  if (!found) return null;
  const { message, facts } = found;
  return {
    fields: rule.fields,
    values: readFields(rule.fields, facts),
    ruleId: rule.id,
    message: { id: message.id, subject: facts.subject, sender: facts.senderName || facts.senderEmail, date: message.date },
  };
}

/** Whether an automation reads anything or checks what it read (and so needs Read worked out). */
const reads = (rule: Pick<Rule, "fields" | "checks">) => rule.fields.length > 0 || rule.checks.length > 0;

function covers(rule: Pick<Rule, "accounts">, accountId: string) {
  return !rule.accounts.length || rule.accounts.includes(accountId);
}

/** Rules undone on this conversation (they leave it alone from then on). */
function undoneHere(threadId: string) {
  const rows = getDb().prepare("SELECT DISTINCT rule_id FROM rule_runs WHERE thread_id = ? AND undone_at IS NOT NULL").all(threadId) as { rule_id: string }[];
  return new Set(rows.map((r) => r.rule_id));
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

type Arrival = {
  /** How the first matching notify said to tell the user (null: no rule said). */
  notify: NotifyMode | null;
};

/** Whether one message matches an answer's search (expectations: "payment received", from:stripe.com). */
export function matchesAnswer(thread: Thread, message: Message, answer: string) {
  const terms = parseSearch(answer);
  if (!terms.length) return true;
  const labels = message.labels ?? [];
  let text: string | null = null;
  const facts: MatchFacts = {
    labels,
    labelNames: labels.length ? labelLookup(thread.accountId).namesOf(labels) : [],
    text: (m) => (m.html ? (text ??= htmlToText(m.html)) : ""),
  };
  return matchesSearch({ ...thread, messages: [message] }, terms, facts);
}

/** Who a run is about (the expect verb waits on them): the sender of new mail, or who your mail went to. */
function aboutOf(thread: Thread, messages: Message[], me: string, trigger: Trigger): VerbContext["about"] {
  if (trigger === "sent") {
    const sent = recipientsOf(messages, me);
    if (!sent?.people.length) return null;
    return { who: sent.people, messageId: sent.message.id, subject: sent.message.subject ?? thread.subject, date: sent.message.date };
  }
  const theirs = [...messages].reverse().find((m) => !m.draft && m.from.email.toLowerCase() !== me);
  if (!theirs) return null;
  const name = theirs.from.name && theirs.from.name !== theirs.from.email ? theirs.from.name : "";
  return { who: [{ email: theirs.from.email.toLowerCase(), name }], messageId: theirs.id, subject: theirs.subject ?? thread.subject, date: theirs.date };
}

/**
 * Runs the enabled rules on a conversation that just received the `fresh` messages: rules on new
 * mail for messages from others (or to yourself), rules on sent mail for yours. Expectations are
 * settled first, so a reply never counts against the rule it starts. `loadFull` downloads bodies
 * when a rule's words, files or attachments need them (only after its other terms already match).
 */
export async function runRulesOnArrival(
  account: AccountRow,
  threadId: string,
  fresh: string[],
  { loadFull, statusBefore }: { loadFull: () => Promise<void>; statusBefore: (email: string) => ReturnType<typeof senderStatus> },
): Promise<Arrival & { expected: boolean }> {
  let row = getThreadRow(threadId);
  if (!row) return { notify: null, expected: false };
  let thread = { ...(JSON.parse(row.data) as Thread), id: threadId, accountId: account.id };
  const ids = new Set(fresh);
  const me = account.email.toLowerCase();
  const arrived = () => thread.messages.filter((m) => ids.has(m.id) && !m.draft);
  if (!arrived().length) return { notify: null, expected: false };
  const expected = settleArrived(account, threadId, arrived(), matchesAnswer);

  // You answered (from Kite, Gmail or your phone): a reply prepared earlier has done its job.
  if (arrived().some((m) => m.from.email.toLowerCase() === me)) discardPrepared(threadId);

  const rules = listRules().filter((r) => r.enabled && covers(r, account.id));
  // Mail to yourself lands in your inbox: it's new mail, not mail you sent.
  const mineIds = new Set(arrived().filter((m) => m.from.email.toLowerCase() === me && !m.labels?.includes("INBOX")).map((m) => m.id));
  const theirIds = new Set(arrived().filter((m) => !mineIds.has(m.id)).map((m) => m.id));
  let notify: NotifyMode | null = null;
  for (const trigger of ["new_mail", "sent"] as const) {
    const targets = trigger === "sent" ? mineIds : theirIds;
    const forTrigger = rules.filter((r) => r.when === trigger);
    if (!targets.size || !forTrigger.length) continue;
    const among = () => thread.messages.filter((m) => targets.has(m.id));
    const facts = factsFor(account, threadId, among(), statusBefore, trigger);
    const lookup = labelLookup(account.id);
    let match = lazy(() => matchFacts(row!, lookup.namesOf));
    const reload = async () => {
      await loadFull();
      row = getThreadRow(threadId) ?? row!;
      thread = { ...(JSON.parse(row.data) as Thread), id: threadId, accountId: account.id };
      const current = row;
      match = lazy(() => matchFacts(current, lookup.namesOf));
    };
    const undone = lazy(() => undoneHere(threadId));
    const matched: Active[] = [];
    const readBy = new Map<string, Read>();
    for (const rule of forTrigger) {
      if (!rule.conditions.every((c) => conditionHolds(c, facts))) continue;
      const terms = termsOf(rule);
      const cheap = terms.filter((t) => !needsBody(t));
      if (!matchesSearch(thread, cheap, match())) continue;
      const body = terms.filter(needsBody);
      if (body.length) {
        if (!row!.full) await reload();
        if (!matchesSearch(thread, body, match())) continue;
      }
      if (undone().has(rule.id)) continue;
      if (reads(rule)) {
        // Read needs the email's text: download the body first, as the search's words do.
        if (rule.fields.some(needsText) && !row!.full) await reload();
        const read = readFor(rule, thread, me, targets);
        if (!read || !checksHold(rule.checks, read.values)) continue;
        readBy.set(rule.id, read);
      }
      matched.push(rule);
      if (rule.stop) break;
    }
    if (!matched.length) continue;

    const ctx = contextFor(account, threadId, thread, facts, lookup.idFor, among, me, trigger);
    // "Wait before acting": its notify still tells you now; the rest waits in rule_delays.
    const straight = matched.filter((r) => !r.delay);
    for (const rule of matched.filter((r) => r.delay)) delayRun(rule, account.id, threadId, [...targets], readBy.get(rule.id));
    const work = straight.length ? await perform(ctx, [...targets], straight, "new", null, readBy) : { leftInbox: false };
    if (trigger !== "new_mail") continue;
    const notifyOf = (rule: Active) => rule.actions.flatMap((a) => (a.verb === "notify" ? [a.mode] : []))[0];
    // The first notify wins; "with the next batch" stays quiet when the rules moved the mail out of the inbox.
    const first = matched.find((r) => notifyOf(r));
    notify = first ? notifyOf(first)! : null;
    if (notify === "batch" && work.leftInbox) notify = "silent";
  }
  return { notify, expected };
}

/** The verbs' view of a conversation: who it's from, its labels, the reply a rule may prepare. */
function contextFor(
  account: AccountRow,
  threadId: string,
  thread: Thread,
  facts: Facts,
  labelId: (name: string) => string | null,
  among: () => Message[],
  me: string,
  trigger: Trigger,
): VerbContext {
  return {
    account,
    threadId,
    sender: facts.sender,
    senderNew: trigger === "new_mail" && !!facts.sender && facts.status() === null,
    labelId,
    reply: lazy(() => {
      const answer = [...among()].reverse().find((m) => !m.draft && m.from.email.toLowerCase() !== me);
      if (!answer) return null;
      return { messageId: answer.id, values: messageBlanks(answer.from, answer.subject ?? thread.subject) };
    }),
    about: aboutOf(thread, among(), me, trigger),
  };
}

/** A matched rule with "wait before acting": its actions run on the sync tick once the wait is over. */
function delayRun(rule: Rule, accountId: string, threadId: string, targets: string[], read: Read | undefined) {
  getDb()
    .prepare("INSERT INTO rule_delays (id, rule_id, account_id, thread_id, message_ids, read_data, run_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(crypto.randomUUID(), rule.id, accountId, threadId, JSON.stringify(targets), read ? JSON.stringify(read) : null, new Date(Date.now() + rule.delay * 60_000).toISOString());
}

/**
 * Runs the waits that are over (sync tick). A rule paused, deleted or undone here since does
 * nothing; a conversation gone does nothing. Returns the accounts whose mail changed.
 */
export async function runDelayed() {
  const due = getDb().prepare("SELECT * FROM rule_delays WHERE run_at <= ? ORDER BY run_at").all(new Date().toISOString()) as {
    id: string;
    rule_id: string;
    account_id: string;
    thread_id: string;
    message_ids: string;
    read_data: string | null;
  }[];
  const changed = new Set<string>();
  for (const job of due) {
    getDb().prepare("DELETE FROM rule_delays WHERE id = ?").run(job.id);
    const rule = listRules().find((r) => r.id === job.rule_id && r.enabled);
    const account = getAccount(job.account_id);
    const row = getThreadRow(job.thread_id);
    if (!rule || !account || !row || undoneHere(job.thread_id).has(rule.id)) continue;
    const thread = { ...(JSON.parse(row.data) as Thread), id: job.thread_id, accountId: account.id };
    const targets = new Set(JSON.parse(job.message_ids) as string[]);
    const among = () => thread.messages.filter((m) => targets.has(m.id));
    if (!among().length) continue;
    const me = account.email.toLowerCase();
    const facts = factsFor(account, job.thread_id, among());
    const lookup = labelLookup(account.id);
    const readBy = new Map<string, Read>(job.read_data ? [[rule.id, JSON.parse(job.read_data) as Read]] : []);
    const ctx = contextFor(account, job.thread_id, thread, facts, lookup.idFor, among, me, "new_mail");
    // Notify already told you when the mail came.
    const quiet = { ...rule, actions: rule.actions.filter((a) => a.verb !== "notify") };
    if (!quiet.actions.length) continue;
    const { logged } = await perform(ctx, [...targets], [quiet], "new", null, readBy).catch(() => ({ logged: 0 }));
    if (logged) changed.add(account.id);
  }
  return [...changed];
}

/** Plans and applies the matched rules, then logs each rule that changed something. */
async function perform(ctx: VerbContext, targets: string[], rules: Active[], trigger: "new" | "existing", batchId: string | null, readBy = new Map<string, Read>()) {
  const work: RuleWork[] = rules.map((rule) => ({
    rule: { id: rule.id, name: rule.name },
    read: readBy.get(rule.id),
    // Gmail's filter has usually acted before Kite sees the mail: what it did is logged as its work.
    inGmail: trigger === "new" && rule.gmail && !!providerFor(ctx.account).filters?.live(rule.id, ctx.account.id),
    actions: rule.actions
      .filter((a) => trigger === "new" || !NEW_MAIL_ONLY.has(a.verb))
      .map((action) => ({
        action,
        planned: AI_VERBS.has(action.verb) && !rule.ai ? { skip: "Allow AI is off for this rule" } : plan(action, { ...ctx, read: readBy.get(rule.id) }),
      })),
  }));
  let results: { results: ActionResult[]; undo: UndoStep[] }[];
  let failed = false;
  try {
    results = await applyEffects(ctx, targets, work);
  } catch (error) {
    console.error("A rule couldn't change mail:", error instanceof Error ? error.message : error);
    failed = true;
    results = work.map((w) => ({
      results: w.actions.map(({ action }) => ({ verb: action.verb, text: describeAction(action), done: describeAction(action), ok: false, skip: GMAIL_FAILED })),
      undo: [],
    }));
  }
  const insert = getDb().prepare(
    `INSERT INTO rule_runs (id, rule_id, rule_name, account_id, thread_id, message_ids, at, trigger, batch_id, actions, undo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let leftInbox = false;
  let logged = 0;
  rules.forEach((rule, i) => {
    const { results: done, undo } = results[i];
    if (undo.some((s) => (s.type === "labels" && s.add.includes("INBOX")) || s.type === "untrash" || s.type === "unsnooze" || s.type === "sender")) leftInbox = true;
    // Only rules that changed something (or tried and failed) are logged: a notify alone isn't.
    if (!undo.length && !(failed && done.length)) return;
    insert.run(crypto.randomUUID(), rule.id, rule.name, ctx.account.id, ctx.threadId, JSON.stringify(targets), now(), trigger, batchId, JSON.stringify(done), JSON.stringify(undo));
    logged++;
  });
  return { leftInbox, failed, logged };
}

/**
 * Conversations from the last 30 days that a rule would have matched (no bodies are downloaded):
 * for mail you send, conversations with your own mail in them.
 */
function candidates(rule: Pick<Rule, "query" | "accounts" | "conditions" | "when">, limit: number) {
  if (rule.when === "schedule") return [];
  const since = new Date(Date.now() - 30 * 86_400_000);
  const day = `${since.getFullYear()}/${since.getMonth() + 1}/${since.getDate()}`;
  const accounts = new Map(listAccounts().map((a) => [a.id, a]));
  const sent = rule.when === "sent" ? " in:sent" : "";
  const found = searchThreads(`${rule.query}${sent} after:${day}`.trim(), "all", limit).filter((t) => accounts.has(t.accountId) && covers(rule, t.accountId));
  return found.filter((t) => {
    const account = accounts.get(t.accountId)!;
    const facts = factsFor(account, t.id, targetsOf(rule, t, account.email.toLowerCase()), senderStatus, rule.when);
    return rule.conditions.every((c) => conditionHolds(c, facts));
  });
}

/** The messages a rule acts on in a stored conversation: yours for mail you send, else all of them. */
function targetsOf(rule: Pick<Rule, "when">, t: Thread, me: string) {
  return rule.when === "sent" ? t.messages.filter((m) => !m.draft && m.from.email.toLowerCase() === me) : t.messages;
}

/** A conversation as stored (with bodies when Kite has them), for reading fields. */
export function storedThread(t: Thread) {
  const row = getThreadRow(t.id);
  return row ? ({ ...(JSON.parse(row.data) as Thread), id: t.id, accountId: t.accountId } as Thread) : t;
}

/** Conversations checked against an automation's checks in a preview (reading text costs time). */
const CHECKED = 400;

/**
 * "Would have matched N conversations in the last 30 days", with a few subjects and, for an
 * automation that reads, what it read from the newest few (so the builder shows real values).
 */
export function previewRule(draft: RuleDraft) {
  const rule = { ...RuleDraftSchema.parse(draft), id: "preview" } as Rule;
  if (rule.when === "schedule") {
    // Nothing to match: say who it's for and when it next runs.
    const people = rule.conditions.flatMap((c) => (c.kind === "senders" && !c.negate ? c.emails : []));
    return { count: people.length, capped: false, subjects: people.slice(0, 3), samples: [], screensNew: false, next: rule.schedule ? nextOccurrence(rule.schedule).toISOString() : null };
  }
  let found = candidates(rule, 2000);
  const samples: { subject: string; values: FieldValues }[] = [];
  let capped = false;
  if (reads(rule)) {
    const me = new Map(listAccounts().map((a) => [a.id, a.email.toLowerCase()]));
    capped = found.length > CHECKED;
    found = found.slice(0, CHECKED).filter((t) => {
      const mine = me.get(t.accountId) ?? "";
      const read = readFor(rule, storedThread(t), mine, rule.when === "sent" ? new Set(targetsOf(rule, t, mine).map((m) => m.id)) : undefined);
      if (!read || !checksHold(rule.checks, read.values)) return false;
      if (samples.length < 3) samples.push({ subject: read.message.subject, values: read.values });
      return true;
    });
  }
  return {
    count: found.length,
    capped,
    subjects: found.slice(0, 3).map((t) => t.subject),
    samples,
    screensNew: rule.conditions.some((c) => c.kind === "sender" && c.status === "new" && !c.negate),
    next: null as string | null,
  };
}

/** "Run on existing mail": applies a rule (not its notify, Screener or prepare-reply actions) to the last 30 days, as one batch for Undo. */
export async function runOnExisting(id: string) {
  const rule = listRules().find((r) => r.id === id);
  if (!rule) throw new RuleError("That rule is gone. Refresh and try again.");
  if (rule.when === "schedule") throw new RuleError("This one runs on its schedule. Use Run now.");
  const found = candidates(rule, 500);
  const batchId = crypto.randomUUID();
  let changed = 0;
  const touched = new Set<string>();
  for (const t of found) {
    const account = getAccount(t.accountId);
    if (!account || undoneHere(t.id).has(rule.id)) continue;
    const lookup = labelLookup(account.id);
    const me = account.email.toLowerCase();
    const targets = targetsOf(rule, t, me);
    if (!targets.length) continue;
    const facts = factsFor(account, t.id, targets, senderStatus, rule.when);
    const readBy = new Map<string, Read>();
    if (reads(rule)) {
      const read = readFor(rule, storedThread(t), me, rule.when === "sent" ? new Set(targets.map((m) => m.id)) : undefined);
      if (!read || !checksHold(rule.checks, read.values)) continue;
      readBy.set(rule.id, read);
    }
    const { failed, logged } = await perform(
      { account, threadId: t.id, sender: facts.sender, senderNew: false, labelId: lookup.idFor, reply: () => null, about: aboutOf(t, targets, me, rule.when === "sent" ? "sent" : "new_mail") },
      targets.map((m) => m.id),
      [rule],
      "existing",
      batchId,
      readBy,
    );
    if (failed) break;
    if (logged) {
      changed++;
      touched.add(account.id);
    }
  }
  return { batchId, changed, accounts: [...touched] };
}

// ---------------------------------------------------------------------------
// Activity log and Undo
// ---------------------------------------------------------------------------

type RunRow = {
  id: string;
  rule_id: string;
  rule_name: string;
  account_id: string;
  thread_id: string;
  at: string;
  trigger: "new" | "existing";
  batch_id: string | null;
  actions: string;
  undo: string;
  undone_at: string | null;
  subject: string | null;
};

export function listRuns(limit = 300): RuleRunView[] {
  const rows = getDb()
    .prepare(
      `SELECT r.*, json_extract(t.list_data, '$.subject') AS subject
       FROM rule_runs r LEFT JOIN threads t ON t.id = r.thread_id ORDER BY r.at DESC LIMIT ?`,
    )
    .all(limit) as RunRow[];
  return rows.map((r) => {
    const actions = JSON.parse(r.actions) as ActionResult[];
    return {
      id: r.id,
      ruleId: r.rule_id,
      ruleName: r.rule_name,
      threadId: r.thread_id,
      subject: r.subject ?? "(conversation no longer here)",
      at: r.at,
      trigger: r.trigger,
      batchId: r.batch_id,
      done: actions.filter((a) => a.ok && a.verb !== "notify").map((a) => a.done),
      failed: actions.some((a) => !a.ok && a.skip === GMAIL_FAILED),
      inGmail: actions.some((a) => a.gmail),
      undoable: (JSON.parse(r.undo) as UndoStep[]).length > 0,
      undoneAt: r.undone_at,
    };
  });
}

/** Undoes runs (newest first). The rule then leaves those conversations alone. */
export async function undoRuns(ids: string[]) {
  const rows = getDb()
    .prepare("SELECT * FROM rule_runs WHERE id IN (SELECT value FROM json_each(?)) AND undone_at IS NULL ORDER BY at DESC")
    .all(JSON.stringify(ids)) as RunRow[];
  const accounts = new Set<string>();
  let undone = 0;
  for (const row of rows) {
    const account = getAccount(row.account_id);
    if (!account) continue;
    await undoSteps(account, row.thread_id, JSON.parse(row.undo) as UndoStep[]);
    getDb().prepare("UPDATE rule_runs SET undone_at = ? WHERE id = ?").run(now(), row.id);
    accounts.add(account.id);
    undone++;
  }
  return { undone, accounts: [...accounts] };
}

/** The log keeps 30 days. */
export function pruneRuns() {
  getDb().prepare("DELETE FROM rule_runs WHERE at < ?").run(new Date(Date.now() - 30 * 86_400_000).toISOString());
}
