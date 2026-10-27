import { parseSearch, toGmailQuery, type SearchTerm } from "../mail/search";
import { VERBS, type Condition, type Rule } from "./spec";

// "Also run in Gmail": a rule Gmail can express, written as a Gmail filter (users.settings.filters)
// so it runs while Kite is closed. Shared by the rule editor (whether to offer the switch, and why
// not) and server/gmail-filters.ts (what to create). Labels stay names here; the server resolves
// them per account.

/** Gmail filter criteria (users.settings.filters). Only the fields Kite writes. */
type FilterCriteria = { from?: string; to?: string; subject?: string; query?: string; negatedQuery?: string; hasAttachment?: boolean };

export type GmailFilterPlan = {
  criteria: FilterCriteria;
  /** Label names to add (the account's own labels). */
  labels: string[];
  archive: boolean;
  star: boolean;
  markRead: boolean;
  trash: boolean;
};

type GmailFilterCheck = { ok: true; plan: GmailFilterPlan } | { ok: false; reason: string };

const CONDITION_REASONS: Record<Condition["kind"], string> = {
  vip: "Gmail doesn't know who your VIPs are.",
  sender: "Gmail doesn't know who is new to you or waiting in the Screener.",
  muted: "Gmail doesn't know what you muted in Kite.",
  senders: "Put the senders in the search (from:) to run this in Gmail.",
};

/** Search terms a Gmail filter can check on arriving mail. */
const FILTER_FIELDS = new Set<SearchTerm["field"]>(["text", "from", "to", "subject", "has", "filename"]);

/** Whether the whole rule translates to a Gmail filter, and the filter if so. */
export function gmailFilterFor(rule: Pick<Rule, "query" | "conditions" | "actions" | "stop"> & Partial<Pick<Rule, "checks" | "when" | "delay">>): GmailFilterCheck {
  if (rule.when && rule.when !== "new_mail") return { ok: false, reason: "Gmail filters only run on mail arriving." };
  if (rule.delay) return { ok: false, reason: "Gmail filters act at once. Turn off the wait to use it." };
  if (rule.conditions.length) return { ok: false, reason: CONDITION_REASONS[rule.conditions[0].kind] };
  if (rule.checks?.length) return { ok: false, reason: "Gmail filters can't check what Kite reads from an email." };
  const kiteOnly = rule.actions.find((a) => !VERBS[a.verb].gmail);
  if (kiteOnly) return { ok: false, reason: `“${VERBS[kiteOnly.verb].label}” only works in Kite.` };
  if (rule.stop) return { ok: false, reason: "Gmail filters can't stop the rules below. Turn off Stop here to use it." };
  const terms = parseSearch(rule.query);
  const filterable = (t: SearchTerm): boolean => (t.field === "any" ? (t.any ?? []).every(filterable) : FILTER_FIELDS.has(t.field));
  if (!terms.every(filterable)) return { ok: false, reason: "Gmail filters can't check in:, is: or label: on arriving mail." };
  const positive = terms.filter((t) => !t.negate);
  if (!positive.length) return { ok: false, reason: "A Gmail filter needs something to match, like from: or subject:." };

  // A single from:, to: or subject: goes in its own box (how Gmail's settings show it); the rest
  // is "Has the words" / "Doesn't have" in Gmail's own search syntax.
  const criteria: FilterCriteria = {};
  const rest: SearchTerm[] = [];
  for (const field of ["from", "to", "subject"] as const) {
    const own = positive.filter((t) => t.field === field);
    if (own.length === 1) criteria[field] = own[0].value;
  }
  for (const t of positive) {
    if (t.field === "has") criteria.hasAttachment = true;
    else if (!((t.field === "from" || t.field === "to" || t.field === "subject") && criteria[t.field] === t.value)) rest.push(t);
  }
  if (rest.length) criteria.query = toGmailQuery(rest);
  const negative = terms.filter((t) => t.negate).map((t) => ({ ...t, negate: false }));
  if (negative.length) criteria.negatedQuery = toGmailQuery(negative);

  const verbs = new Set(rule.actions.map((a) => a.verb));
  return {
    ok: true,
    plan: {
      criteria,
      labels: [...new Set(rule.actions.flatMap((a) => (a.verb === "label" ? [a.label.trim()] : [])))],
      archive: verbs.has("archive"),
      star: verbs.has("star"),
      markRead: verbs.has("mark_read"),
      trash: verbs.has("trash"),
    },
  };
}

/** How one account's filter for a rule stands (gmail_filters, written only by the server's sync). */
export type GmailFilterState = {
  accountId: string;
  /**
   * on: the filter is in Gmail. reconnect: Kite needs permission to manage filters. no-label: the
   * account has no label by that name. gone: removed in Gmail (Kite doesn't add it back by itself).
   * exists: Gmail already has the same filter (yours), so Kite left it alone. failed: Gmail refused.
   */
  state: "on" | "reconnect" | "no-label" | "gone" | "exists" | "failed";
  detail?: string;
};
