import "server-only";

import { gmailFilterFor, type GmailFilterPlan, type GmailFilterState } from "@/lib/rules/gmail";
import type { Rule } from "@/lib/rules/spec";
import { getDb, listAccounts, type AccountRow } from "../../db";
import { ReconnectRequired } from "../../mail/errors";
import type { ServerFilters } from "../../mail/provider";
import { GMAIL_FILTER_SCOPES, hasScopes } from "./oauth";
import { GmailError, createFilter, deleteFilter, listFilters, type GmailFilter } from "./api";

// "Also run in Gmail": rules the user switched on are kept as Gmail filters, so they run while
// Kite is closed. Kite never makes a filter by itself and never touches a filter it didn't make:
// only ids in gmail_filters are ever deleted. Gmail filters can't be edited or paused, so an edit
// deletes and recreates, and pausing deletes (switching back on recreates). A filter the user
// removed in Gmail isn't added back until they change the rule or switch it off and on.
//
// With Kite open, the rule still runs on arrival too. Gmail's filter has usually acted already, so
// whatever is already in place on the new messages is logged as done in Gmail (with Undo), and
// Kite does whatever is left (rules.ts / rule-verbs.ts). Reached through the provider (`filters`).

type Row = {
  rule_id: string;
  account_id: string;
  filter_id: string | null;
  signature: string | null;
  state: GmailFilterState["state"];
  detail: string | null;
};

type FilterBody = Omit<GmailFilter, "id">;

function now() {
  return new Date().toISOString();
}

function rows(accountId?: string) {
  const db = getDb();
  return (accountId
    ? db.prepare("SELECT * FROM gmail_filters WHERE account_id = ?").all(accountId)
    : db.prepare("SELECT * FROM gmail_filters").all()) as Row[];
}

function put(ruleId: string, accountId: string, fields: Omit<Row, "rule_id" | "account_id">) {
  getDb()
    .prepare(
      `INSERT INTO gmail_filters (rule_id, account_id, filter_id, signature, state, detail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (rule_id, account_id) DO UPDATE SET filter_id = excluded.filter_id, signature = excluded.signature,
         state = excluded.state, detail = excluded.detail, updated_at = excluded.updated_at`,
    )
    .run(ruleId, accountId, fields.filter_id, fields.signature, fields.state, fields.detail, now());
}

function drop(ruleId: string, accountId: string) {
  getDb().prepare("DELETE FROM gmail_filters WHERE rule_id = ? AND account_id = ?").run(ruleId, accountId);
}

/** How each rule's filters stand, for Settings → Rules. */
function filterStates() {
  const states = new Map<string, GmailFilterState[]>();
  for (const row of rows()) {
    const list = states.get(row.rule_id) ?? [];
    list.push({ accountId: row.account_id, state: row.state, ...(row.detail ? { detail: row.detail } : {}) });
    states.set(row.rule_id, list);
  }
  return states;
}

/** Whether this rule's filter is in this account's Gmail now. */
function filterLive(ruleId: string, accountId: string) {
  return !!getDb().prepare("SELECT 1 FROM gmail_filters WHERE rule_id = ? AND account_id = ? AND state = 'on'").get(ruleId, accountId);
}

function covers(rule: Rule, accountId: string) {
  return !rule.accounts.length || rule.accounts.includes(accountId);
}

/** The filter for one account, or the label it lacks. */
function filterBody(plan: GmailFilterPlan, account: AccountRow): { body: FilterBody } | { missing: string } {
  const labels = getDb().prepare("SELECT id, name FROM labels WHERE account_id = ?").all(account.id) as { id: string; name: string }[];
  const add: string[] = [];
  for (const name of plan.labels) {
    const id = labels.find((l) => l.name.toLowerCase() === name.toLowerCase())?.id;
    if (!id) return { missing: name };
    add.push(id);
  }
  if (plan.star) add.push("STARRED");
  if (plan.trash) add.push("TRASH");
  const remove = [...(plan.archive ? ["INBOX"] : []), ...(plan.markRead ? ["UNREAD"] : [])];
  return {
    body: {
      criteria: plan.criteria,
      action: { ...(add.length ? { addLabelIds: add.sort() } : {}), ...(remove.length ? { removeLabelIds: remove.sort() } : {}) },
    },
  };
}

/** Criteria and actions in one comparable string (Gmail leaves out empty fields). */
function signature(filter: FilterBody) {
  const tidy = (o: Record<string, unknown> | undefined) =>
    Object.fromEntries(
      Object.entries(o ?? {})
        .filter(([, v]) => v !== undefined && v !== false && v !== "" && !(Array.isArray(v) && !v.length))
        .map(([k, v]): [string, unknown] => [k, Array.isArray(v) ? [...(v as string[])].sort() : v])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return JSON.stringify([tidy(filter.criteria), tidy(filter.action)]);
}

function failure(error: unknown): Pick<Row, "state" | "detail"> {
  if (error instanceof ReconnectRequired || (error instanceof GmailError && (error.status === 401 || error.status === 403))) return { state: "reconnect", detail: null };
  if (error instanceof GmailError && error.status === 400 && /exists/i.test(error.message)) return { state: "exists", detail: null };
  console.error("A Gmail filter couldn't be changed:", error instanceof Error ? error.message : error);
  return { state: "failed", detail: error instanceof GmailError ? `Gmail said ${error.status}` : "Gmail couldn't be reached" };
}

async function syncAccount(account: AccountRow, rules: Rule[], ruleId?: string) {
  const mine = rows(account.id).filter((r) => !ruleId || r.rule_id === ruleId);
  const wanted = rules.filter((r) => r.gmail && r.enabled && covers(r, account.id) && (!ruleId || r.id === ruleId));
  if (!wanted.length && !mine.length) return;
  const rowOf = (id: string) => mine.find((r) => r.rule_id === id);

  if (!hasScopes(account.id, GMAIL_FILTER_SCOPES)) {
    // Nothing can be added or removed until the user lets Kite manage filters. Rows for filters
    // that should go stay, so the next sync removes them.
    for (const rule of wanted) {
      const row = rowOf(rule.id);
      put(rule.id, account.id, { filter_id: row?.filter_id ?? null, signature: row?.signature ?? null, state: "reconnect", detail: null });
    }
    for (const row of mine) if (!wanted.some((r) => r.id === row.rule_id) && !row.filter_id) drop(row.rule_id, account.id);
    return;
  }

  let inGmail: GmailFilter[];
  try {
    inGmail = await listFilters(account.id);
  } catch (error) {
    const { state, detail } = failure(error);
    for (const rule of wanted) put(rule.id, account.id, { filter_id: rowOf(rule.id)?.filter_id ?? null, signature: rowOf(rule.id)?.signature ?? null, state, detail });
    return;
  }

  // Switched off, paused, deleted, or no longer covering this account: remove Kite's filter.
  for (const row of mine) {
    if (wanted.some((r) => r.id === row.rule_id)) continue;
    try {
      if (row.filter_id) await deleteFilter(account.id, row.filter_id);
      drop(row.rule_id, account.id);
    } catch (error) {
      put(row.rule_id, account.id, { ...row, ...failure(error) });
    }
  }

  for (const rule of wanted) {
    const row = rowOf(rule.id);
    const check = gmailFilterFor(rule);
    const built = check.ok ? filterBody(check.plan, account) : null;
    try {
      if (!built || "missing" in built) {
        if (row?.filter_id) await deleteFilter(account.id, row.filter_id);
        put(rule.id, account.id, {
          filter_id: null,
          signature: null,
          state: built ? "no-label" : "failed",
          detail: built ? built.missing : check.ok ? null : check.reason,
        });
        continue;
      }
      const sig = signature(built.body);
      if (row?.signature === sig && (row.filter_id || row.state === "gone")) {
        // Unchanged: still there, or removed in Gmail (not added back by itself).
        const there = !!row.filter_id && inGmail.some((f) => f.id === row.filter_id);
        put(rule.id, account.id, { filter_id: there ? row.filter_id : null, signature: sig, state: there ? "on" : "gone", detail: null });
        continue;
      }
      if (row?.filter_id) await deleteFilter(account.id, row.filter_id);
      // The same filter made by the user (or another app) is theirs: Gmail already does this.
      if (inGmail.some((f) => f.id !== row?.filter_id && signature(f) === sig)) {
        put(rule.id, account.id, { filter_id: null, signature: sig, state: "exists", detail: null });
        continue;
      }
      const created = await createFilter(account.id, built.body);
      put(rule.id, account.id, { filter_id: created.id, signature: sig, state: "on", detail: null });
    } catch (error) {
      const { state, detail } = failure(error);
      // A delete that failed leaves the old filter in place: keep its id so the next sync retries.
      put(rule.id, account.id, { filter_id: state === "reconnect" ? (row?.filter_id ?? null) : null, signature: null, state, detail });
    }
  }
}

const g = globalThis as typeof globalThis & { __kiteFilterQueue?: Promise<void> };

/**
 * Brings Kite's Gmail filters in line with the rules (`rules` is read when this sync's turn comes,
 * so queued syncs see the latest rules). `ruleId` limits it to one rule, `accountId` to one account.
 */
function syncGmailFilters(rules: () => Rule[], { ruleId, accountId }: { ruleId?: string; accountId?: string } = {}) {
  const run = (g.__kiteFilterQueue ?? Promise.resolve()).then(async () => {
    const list = rules();
    for (const account of listAccounts()) {
      if (account.provider !== "gmail" || (accountId && account.id !== accountId)) continue;
      await syncAccount(account, list, ruleId).catch((error) => console.error("Gmail filter sync failed:", error instanceof Error ? error.message : error));
    }
  });
  g.__kiteFilterQueue = run.catch(() => {});
  return run;
}

/** Disconnect and "Erase everything": removes the filters Kite made in this account (best effort), then their rows. */
async function removeAccountFilters(accountId: string) {
  const made = rows(accountId).filter((r) => r.filter_id);
  if (made.length && hasScopes(accountId, GMAIL_FILTER_SCOPES)) {
    for (const row of made) await deleteFilter(accountId, row.filter_id!).catch(() => {});
  }
  getDb().prepare("DELETE FROM gmail_filters WHERE account_id = ?").run(accountId);
}

export const gmailFilters: ServerFilters = {
  states: filterStates,
  live: filterLive,
  sync: syncGmailFilters,
  removeAccount: removeAccountFilters,
};
