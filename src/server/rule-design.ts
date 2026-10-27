import "server-only";

import * as z from "zod";
import { ConditionSchema, RuleActionSchema, RuleDraftSchema, TRIGGER_VERBS, VERBS, referenceProblem, type RuleDraft } from "@/lib/rules/spec";
import { generateJson } from "./ai";
import { getDb } from "./db";

// "Describe a rule": the AI turns the user's sentence into a rule (the typed RuleDraft), which opens
// in the normal editor for review; nothing is saved or run until the user presses Save. The AI sees
// the description and the names of the user's labels, and no mail. It never turns on
// "Allow AI" or "Also run in Gmail": those stay the user's switches.

const AiRule = z.object({
  name: z.string(),
  when: z.enum(["new_mail", "sent"]),
  query: z.string(),
  conditions: z.array(ConditionSchema),
  actions: z.array(RuleActionSchema),
  stop: z.boolean(),
});

/** Steps the AI may write: what runs on new or sent mail, minus the ones that need fields read first. */
const DESIGNABLE = TRIGGER_VERBS.new_mail.filter((v) => !["collect", "remind", "calendar"].includes(v));

const SYSTEM = `You write rules for Kite, an email client. A rule runs on new mail (when: "new_mail") or on mail the user sends (when: "sent"): if the mail matches the search query and every condition, the actions run in order.

query: Gmail search syntax. from:, to:, subject:, has:attachment, filename:, label:, in:inbox, is:unread, plain words, quotes for phrases, OR, and - to exclude. No dates (no before:, after:, newer_than:). Empty matches any mail. Prefer a sender's domain (from:shop.co) over a full address when the user names a company.
conditions: facts the query can't express. vip (sender marked VIP), sender with status new (never seen before) / pending (waiting in the Screener) / allowed / blocked, muted (conversation muted). negate: true means "but not".
actions (1 to 8): ${DESIGNABLE.map((verb) => `${verb} (${VERBS[verb].label})`).join(", ")}. On sent mail only: ${TRIGGER_VERBS.sent.filter((v) => DESIGNABLE.includes(v)).join(", ")}. label/unlabel take a label name: use one of the user's labels when one fits. snooze takes for: {kind: "after", amount, unit: hours|days} or {kind: tomorrow|weekend|next_week, time: "HH:MM"}. notify takes mode now|batch|silent. prepare_reply takes a template (body text; blanks {first_name}, {name}, {subject}). draft_reply takes an optional instruction for the user's AI. expect waits for an answer from the sender (new mail) or the people written to (sent mail): days (1 to 90), answer (a search for what counts, empty = any reply), nudges (0 to 3 short polite follow-ups, firmer each time, using {first_name}), every (days between nudges), auto false, ask "" and askSubject "".
stop: true only when the user says rules below shouldn't also run.
name: short, 1 to 4 words, like "Receipts" or "School newsletters".
Only do what the user asked. Don't add actions they didn't ask for.`;

export async function designRule(description: string): Promise<RuleDraft> {
  const labels = (getDb().prepare("SELECT DISTINCT name FROM labels ORDER BY name").all() as { name: string }[]).map((l) => l.name).slice(0, 200);
  const prompt = `The user wants: ${description.trim()}

Their labels: ${labels.length ? labels.join(", ") : "(none)"}`;
  const purpose = { task: "design" as const, action: "Describe a rule", detail: "Your description and label names, no mail" };

  let problems: string[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const ask = problems.length ? `${prompt}\n\nYour previous rule had these problems, fix them:\n- ${problems.join("\n- ")}` : prompt;
    const { value: rule } = await generateJson(AiRule, SYSTEM, ask, purpose, 1500);
    const draft = { ...rule, enabled: true, accounts: [], gmail: false, ai: false, aiModel: null };
    const parsed = RuleDraftSchema.safeParse(draft);
    const problem = parsed.success ? referenceProblem(parsed.data as Parameters<typeof referenceProblem>[0]) : null;
    problems = parsed.success ? (problem ? [problem] : []) : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
    if (!problems.length) return parsed.data!;
  }
  throw new Error(`The AI's rule didn't hold together: ${problems[0]}`);
}
