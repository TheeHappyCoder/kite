import "server-only";

import { lastOccurrence, periodBefore, type Rule } from "@/lib/rules/spec";
import { getAccount, getDb, listAccounts, type AccountRow } from "./db";
import { listContacts } from "./contacts";
import { createExpectation } from "./expectations";
import { buildPack } from "./packs";
import { collectionExists } from "./collections";
import type { ComposeDraft } from "@/lib/mail/compose";

// Schedule automations (`when: "schedule"`, lib/rules/spec.ts): on their day each week or month the
// sync tick runs them once (rule_schedules keeps the last occurrence run). `expect` starts waiting
// on each of the rule's people for this period (server/expectations.ts sends the request and the
// nudges); `pack` puts the period's collection in one email to your accountant (server/packs.ts),
// a draft unless the step sends by itself. Never imports rules.ts (the rules come in as arguments).

const now = () => new Date().toISOString();

/** A schedule starts counting from now (made, switched to a schedule, or its day changed). */
export function markScheduled(ruleId: string) {
  getDb().prepare("INSERT INTO rule_schedules (rule_id, last_at) VALUES (?, ?) ON CONFLICT(rule_id) DO UPDATE SET last_at = excluded.last_at").run(ruleId, now());
}

export function forgetSchedule(ruleId: string) {
  getDb().prepare("DELETE FROM rule_schedules WHERE rule_id = ?").run(ruleId);
}

/** The account a scheduled step uses: the rule's first, else the first one connected. */
function accountFor(rule: Rule): AccountRow | undefined {
  return (rule.accounts[0] ? getAccount(rule.accounts[0]) : undefined) ?? listAccounts()[0];
}

/** Hooks from sync.ts (a send must go through its deliver, which this module can't import). */
export type ScheduleHooks = {
  send: (account: AccountRow, draft: ComposeDraft) => Promise<{ threadId: string }>;
  saveDraft: (account: AccountRow, draft: ComposeDraft) => Promise<unknown>;
};

/** What one run did, in plain words for the toast and the log. */
export type ScheduleResult = { waiting: number; packs: string[]; problems: string[] };

/**
 * Runs a schedule automation for the occurrence `at` (the tick, or the user's Run now, which counts
 * as the latest occurrence but starts the wait `since` now). One wait per person and occurrence.
 */
export async function runSchedule(rule: Rule, at: Date, hooks: ScheduleHooks, since = at): Promise<ScheduleResult> {
  const result: ScheduleResult = { waiting: 0, packs: [], problems: [] };
  const account = accountFor(rule);
  if (!account) return { ...result, problems: ["Connect an account first."] };
  const people = rule.conditions.flatMap((c) => (c.kind === "senders" && !c.negate ? c.emails : []));
  const names = new Map(listContacts().map((c) => [c.email.toLowerCase(), c.name]));
  const period = periodBefore(rule.schedule ?? { every: "month", day: 1, time: "09:00" }, at);
  for (const action of rule.actions) {
    if (action.verb === "expect") {
      for (const email of people) {
        const made = createExpectation({
          ruleId: rule.id,
          ruleName: rule.name,
          accountId: account.id,
          threadId: null,
          messageId: null,
          who: [{ email, name: names.get(email) ?? "" }],
          subject: (action.askSubject || rule.name).replace(/\{period\}/g, period.name),
          answer: action.answer,
          plan: { askSubject: action.askSubject, ask: action.ask, nudges: action.nudges, every: action.every, auto: action.auto, period: period.name },
          period: at.toISOString(),
          since: since.toISOString(),
          days: action.days,
        });
        if (made) result.waiting++;
      }
    }
    if (action.verb === "pack") {
      if (!collectionExists(action.collection)) {
        result.problems.push("The collection to pack was deleted.");
        continue;
      }
      const { draft, summary } = buildPack({ collectionId: action.collection, start: period.start, end: period.end, periodName: period.name, to: action.to, subject: action.subject, accountId: rule.accounts[0] });
      const sendFrom = getAccount(draft.accountId) ?? account;
      try {
        if (action.auto) await hooks.send(sendFrom, draft);
        else await hooks.saveDraft(sendFrom, draft);
        result.packs.push(`${period.name}: ${summary.files} file${summary.files === 1 ? "" : "s"}${action.auto ? " sent" : " in Drafts"}`);
      } catch (error) {
        result.problems.push(error instanceof Error ? error.message : "The pack couldn't be made.");
      }
    }
  }
  return result;
}

/** "Run now" on a schedule automation: this period's run, if it hasn't happened yet. */
export function runScheduleNow(rule: Rule, hooks: ScheduleHooks) {
  if (rule.when !== "schedule" || !rule.schedule) throw new Error("This automation doesn't run on a schedule.");
  return runSchedule(rule, lastOccurrence(rule.schedule), hooks, new Date());
}

/**
 * The sync tick: every schedule automation whose day came round since it last ran runs once for
 * that occurrence (missed days while the computer was off run once, for the latest). Returns the
 * accounts that changed.
 */
export async function runSchedules(rules: Rule[], hooks: ScheduleHooks) {
  const changed = new Set<string>();
  const last = new Map((getDb().prepare("SELECT rule_id, last_at FROM rule_schedules").all() as { rule_id: string; last_at: string }[]).map((r) => [r.rule_id, r.last_at]));
  for (const rule of rules) {
    if (!rule.enabled || rule.when !== "schedule" || !rule.schedule) continue;
    const ran = last.get(rule.id);
    if (!ran) {
      markScheduled(rule.id);
      continue;
    }
    const at = lastOccurrence(rule.schedule);
    if (at.toISOString() <= ran) continue;
    // Marked first: a run that fails part-way isn't repeated every tick.
    markScheduled(rule.id);
    const result = await runSchedule(rule, at, hooks).catch((error) => {
      console.error("A scheduled automation failed:", error instanceof Error ? error.message : error);
      return null;
    });
    if (result && (result.waiting || result.packs.length)) {
      const account = accountFor(rule);
      if (account) changed.add(account.id);
    }
  }
  return [...changed];
}
