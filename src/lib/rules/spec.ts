import * as z from "zod";
import { FieldCheck, FieldSpec, type FieldType } from "../automations/fields";
import { parseSearch } from "../mail/search";
import type { GmailFilterState } from "./gmail";
import { NUDGES } from "../automations/expect";

// Automations' typed vocabulary (stored as rules), shared by the Automations view, the server
// engine (server/rules.ts, verbs in server/rule-verbs.ts) and the AI ("Describe an automation"
// writes this JSON, the user reviews it). An automation is WHEN (new mail matching a search and
// conditions) + READ (fields pulled from the email, lib/automations/fields.ts) + CHECK (if, on
// those fields) + DO (verbs, whose text can use the fields as {blanks}). Kite only runs what the
// user made or switched on; it never invents one.

// ---------------------------------------------------------------------------
// THEN: verbs. One zod schema per verb; one executor per verb in server/rule-verbs.ts.
// ---------------------------------------------------------------------------

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const SnoozeFor = z.discriminatedUnion("kind", [
  /** A fixed wait from when the mail arrived. */
  z.object({ kind: z.literal("after"), amount: z.number().int().min(1).max(365), unit: z.enum(["hours", "days"]) }),
  /** The next named moment at a local time: tomorrow, Saturday, or Monday. */
  z.object({ kind: z.enum(["tomorrow", "weekend", "next_week"]), time: Time.default("08:00") }),
]);
export type SnoozeFor = z.infer<typeof SnoozeFor>;

export const NOTIFY_MODES = ["now", "batch", "silent"] as const;
export type NotifyMode = (typeof NOTIFY_MODES)[number];

/** Every action a rule can take. `verb` names it; the rest are its arguments. */
export const RuleActionSchema = z.discriminatedUnion("verb", [
  /** Adds one of the account's own labels, by name (an account without it skips this). */
  z.object({ verb: z.literal("label"), label: z.string().trim().min(1).max(200) }),
  z.object({ verb: z.literal("unlabel"), label: z.string().trim().min(1).max(200) }),
  /** Takes the new messages out of the inbox. */
  z.object({ verb: z.literal("archive") }),
  z.object({ verb: z.literal("star") }),
  /** Local only (thread_overrides). */
  z.object({ verb: z.literal("pin") }),
  /** Local only: later replies follow the "Muted conversations" rule. */
  z.object({ verb: z.literal("mute") }),
  z.object({ verb: z.literal("mark_read") }),
  z.object({ verb: z.literal("snooze"), for: SnoozeFor }),
  /** Gmail's Trash (Gmail empties it after 30 days). Never a permanent delete. */
  z.object({ verb: z.literal("trash") }),
  /** Holds the sender in the Screener (only someone Kite has never seen). */
  z.object({ verb: z.literal("screen") }),
  /** now: straight away; batch: with the next batch (now when batches are off); silent: never. The first one that matches wins. */
  z.object({ verb: z.literal("notify"), mode: z.enum(NOTIFY_MODES) }),
  /** Waits in the quick-reply box, blanks filled (lib/rules/prepared.ts). Never sent by itself; new mail only. */
  z.object({ verb: z.literal("prepare_reply"), template: z.string().trim().min(1, "Write the reply to prepare").max(5_000) }),
  /**
   * Your AI drafts a reply that waits in the quick-reply box (server/ai-drafts.ts). Runs only when
   * the rule has "Allow AI" on, within your AI limits (Settings → AI); sees only the new email's fresh
   * text. `instruction`: how you want emails like this answered. Never sent by itself; new mail only.
   */
  z.object({ verb: z.literal("draft_reply"), instruction: z.string().trim().max(1_000).default("") }),
  /**
   * Adds a row to one of your collections with what the automation read (server/collections.ts).
   * `match`: a field that names the thing (the company): an email with the same value updates that
   * row instead (only when it's newer). Local only.
   */
  z.object({
    verb: z.literal("collect"),
    collection: z.string().trim().min(1, "Pick a collection").max(64),
    match: z.string().trim().max(32).nullable().default(null),
  }),
  /** Puts the conversation in one of Kite's spaces (lib/spaces.ts, by id). Local only. */
  z.object({ verb: z.literal("space"), space: z.string().trim().min(1, "Pick a space").max(40) }),
  /** Brings the conversation back to the inbox `daysBefore` a date the email names, at `time` (a snooze until then). */
  z.object({
    verb: z.literal("remind"),
    field: z.string().trim().min(1, "Pick the date to remind you about").max(32),
    daysBefore: z.number().int().min(0).max(60).default(1),
    time: Time.default("08:00"),
  }),
  /** An event on Kite's own calendar (kept only in Kite) on a date the email names; the title can use {blanks}. */
  z.object({
    verb: z.literal("calendar"),
    field: z.string().trim().min(1, "Pick the date for the event").max(32),
    title: z.string().trim().min(1, "Give the event a title").max(200),
  }),
  /**
   * Waits for an answer (server/expectations.ts): from the sender (new mail), the people you wrote to
   * (mail you send), or each of the rule's senders (a schedule). `answer`: what counts (search
   * syntax; empty = any reply in the conversation). After `days` with nothing, the first nudge is
   * ready, then one every `every` days. `ask` (schedules only): the request that starts it. Asks and
   * nudges wait for one tap unless `auto` is on (then Kite sends them itself).
   */
  z.object({
    verb: z.literal("expect"),
    days: z.number().int().min(1).max(90).default(7),
    answer: z.string().trim().max(300).default(""),
    askSubject: z.string().trim().max(200).default(""),
    ask: z.string().trim().max(5_000).default(""),
    nudges: z.array(z.string().trim().min(1, "Write the nudge or remove it").max(5_000)).max(3).default([]),
    every: z.number().int().min(1).max(30).default(7),
    auto: z.boolean().default(false),
  }),
  /**
   * The month-end pack (server/packs.ts, schedules only): the last period's rows of a collection in
   * one email to `to`, every file attached and emails with only a link listed. A draft for you to
   * send unless `auto` is on.
   */
  z.object({
    verb: z.literal("pack"),
    collection: z.string().trim().min(1, "Pick a collection").max(64),
    to: z.string().trim().toLowerCase().email("Write your accountant's address").max(320),
    subject: z.string().trim().min(1, "Write a subject").max(200).default("{period}"),
    auto: z.boolean().default(false),
  }),
]);

export type RuleAction = z.infer<typeof RuleActionSchema>;
export type Verb = RuleAction["verb"];

type VerbInfo = {
  /** In the rule editor ("Archive"). */
  label: string;
  /** In the activity log ("archived"). */
  done: string;
  /** Gmail filters can do the same ("Also run in Gmail", lib/rules/gmail.ts). */
  gmail: boolean;
  /** Undo can put it back (a notification can't be taken back). */
  undoable: boolean;
};

export const VERBS: Record<Verb, VerbInfo> = {
  label: { label: "Add label", done: "labelled", gmail: true, undoable: true },
  unlabel: { label: "Remove label", done: "unlabelled", gmail: false, undoable: true },
  archive: { label: "Archive", done: "archived", gmail: true, undoable: true },
  star: { label: "Star", done: "starred", gmail: true, undoable: true },
  pin: { label: "Pin", done: "pinned", gmail: false, undoable: true },
  mute: { label: "Mute", done: "muted", gmail: false, undoable: true },
  mark_read: { label: "Mark as read", done: "marked read", gmail: true, undoable: true },
  snooze: { label: "Snooze", done: "snoozed", gmail: false, undoable: true },
  trash: { label: "Move to Trash", done: "trashed", gmail: true, undoable: true },
  screen: { label: "Hold in Screener", done: "held", gmail: false, undoable: true },
  notify: { label: "Notify", done: "notified", gmail: false, undoable: false },
  prepare_reply: { label: "Prepare a reply", done: "prepared a reply", gmail: false, undoable: true },
  draft_reply: { label: "Draft a reply with AI", done: "asked your AI for a reply", gmail: false, undoable: true },
  collect: { label: "Add to a collection", done: "added to a collection", gmail: false, undoable: true },
  space: { label: "Put in a space", done: "put in a space", gmail: false, undoable: true },
  remind: { label: "Bring it back on a date", done: "set to come back", gmail: false, undoable: true },
  calendar: { label: "Add to my calendar", done: "added to your calendar", gmail: false, undoable: true },
  expect: { label: "Expect an answer", done: "started waiting for an answer", gmail: false, undoable: true },
  pack: { label: "Send a collection's period", done: "packed", gmail: false, undoable: false },
};

/** Verbs that only make sense on mail arriving now: "Run on existing mail" leaves them out. */
export const NEW_MAIL_ONLY = new Set<Verb>(["notify", "screen", "prepare_reply", "draft_reply", "expect"]);

// ---------------------------------------------------------------------------
// WHEN: what starts an automation.
// ---------------------------------------------------------------------------

/** new_mail: mail arriving; sent: mail you send (from Kite or anywhere else); schedule: a day each week or month. */
export const TRIGGERS = ["new_mail", "sent", "schedule"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const TRIGGER_NAMES: Record<Trigger, string> = { new_mail: "Mail arrives", sent: "I send mail", schedule: "On a schedule" };

/** The verbs each trigger can use (the builder offers only these; the server refuses the rest). */
export const TRIGGER_VERBS: Record<Trigger, readonly Verb[]> = {
  new_mail: ["label", "unlabel", "archive", "space", "star", "pin", "mute", "mark_read", "snooze", "trash", "screen", "notify", "prepare_reply", "draft_reply", "collect", "remind", "calendar", "expect"],
  sent: ["label", "unlabel", "archive", "space", "star", "pin", "mute", "snooze", "collect", "remind", "calendar", "expect"],
  schedule: ["expect", "pack"],
};

/** A day each week (0 = Sunday) or month (31 = the last day), at a local time. */
export const Schedule = z.object({
  every: z.enum(["week", "month"]),
  day: z.number().int().min(0).max(31),
  time: Time.default("09:00"),
});
export type Schedule = z.infer<typeof Schedule>;

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** "Every Monday at 09:00", "On the 1st of every month at 09:00", "On the last day of every month". */
export function describeSchedule(s: Schedule) {
  if (s.every === "week") return `Every ${WEEKDAYS[s.day % 7]} at ${s.time}`;
  return `On the ${s.day >= 31 ? "last day" : ordinal(Math.max(1, s.day))} of every month at ${s.time}`;
}

/** The day `s` falls on in the month of `date` (31 = the month's last day). */
function monthDay(s: Schedule, year: number, month: number) {
  const last = new Date(year, month + 1, 0).getDate();
  return Math.min(Math.max(1, s.day), last);
}

/** The latest time the schedule came round at or before `now` (local time). */
export function lastOccurrence(s: Schedule, now = new Date()) {
  const [h, m] = s.time.split(":").map(Number);
  if (s.every === "week") {
    const at = new Date(now);
    at.setHours(h, m, 0, 0);
    at.setDate(at.getDate() - ((at.getDay() - (s.day % 7) + 7) % 7));
    if (at > now) at.setDate(at.getDate() - 7);
    return at;
  }
  let at = new Date(now.getFullYear(), now.getMonth(), monthDay(s, now.getFullYear(), now.getMonth()), h, m);
  if (at > now) {
    const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const month = (now.getMonth() + 11) % 12;
    at = new Date(year, month, monthDay(s, year, month), h, m);
  }
  return at;
}

/** The next time the schedule comes round after `now`. */
export function nextOccurrence(s: Schedule, now = new Date()) {
  const last = lastOccurrence(s, now);
  if (s.every === "week") return new Date(last.getFullYear(), last.getMonth(), last.getDate() + 7, last.getHours(), last.getMinutes());
  const year = last.getMonth() === 11 ? last.getFullYear() + 1 : last.getFullYear();
  const month = (last.getMonth() + 1) % 12;
  return new Date(year, month, monthDay(s, year, month), last.getHours(), last.getMinutes());
}

/**
 * The stretch a scheduled run looks back over, ending at `at`: the previous calendar month for a
 * monthly schedule ("October 2026"), the 7 days before for a weekly one.
 */
export function periodBefore(s: Schedule, at: Date) {
  if (s.every === "week") {
    const start = new Date(at.getFullYear(), at.getMonth(), at.getDate() - 7);
    return { start, end: new Date(at.getFullYear(), at.getMonth(), at.getDate()), name: `the week of ${start.getDate()} ${start.toLocaleString("en-GB", { month: "long" })}` };
  }
  const start = new Date(at.getFullYear(), at.getMonth() - (at.getDate() <= 7 ? 1 : 0), 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 1, 1);
  return { start, end, name: start.toLocaleString("en-GB", { month: "long", year: "numeric" }) };
}

/** Verbs that send mail to your AI: a rule may use them only with "Allow AI" on. */
export const AI_VERBS = new Set<Verb>(["draft_reply"]);

/** Whether a rule asks for AI (and so needs "Allow AI"). */
export const usesAi = (rule: Pick<Rule, "actions">) => rule.actions.some((a) => AI_VERBS.has(a.verb));

export { NUDGES } from "../automations/expect";

/** A verb's default arguments, for the editor's "Add action". */
export function defaultAction(verb: Verb): RuleAction {
  switch (verb) {
    case "label":
    case "unlabel":
      return { verb, label: "" };
    case "snooze":
      return { verb, for: { kind: "tomorrow", time: "08:00" } };
    case "notify":
      return { verb, mode: "now" };
    case "prepare_reply":
      return { verb, template: "Hi {first_name},\n\n" };
    case "draft_reply":
      return { verb, instruction: "" };
    case "collect":
      return { verb, collection: "", match: null };
    case "space":
      return { verb, space: "" };
    case "remind":
      return { verb, field: "", daysBefore: 1, time: "08:00" };
    case "calendar":
      return { verb, field: "", title: "{subject}" };
    case "expect":
      return { verb, days: 7, answer: "", askSubject: "", ask: "", nudges: [NUDGES[0]], every: 7, auto: false };
    case "pack":
      return { verb, collection: "", to: "", subject: "{period}", auto: false };
    default:
      return { verb };
  }
}

/** When a snooze wakes, from `now` (server and app run on the same computer, so local time is the user's). */
export function snoozeUntil(f: SnoozeFor, now = new Date()) {
  const date = new Date(now);
  if (f.kind === "after") {
    date.setTime(date.getTime() + f.amount * (f.unit === "hours" ? 3_600_000 : 86_400_000));
    return date;
  }
  const [h, m] = f.time.split(":").map(Number);
  date.setHours(h, m, 0, 0);
  if (f.kind === "tomorrow") date.setDate(date.getDate() + 1);
  if (f.kind === "weekend") date.setDate(date.getDate() + (((6 - date.getDay() + 7) % 7) || 7));
  if (f.kind === "next_week") date.setDate(date.getDate() + (((1 - date.getDay() + 7) % 7) || 7));
  return date;
}

const SNOOZE_NAMES = { tomorrow: "tomorrow", weekend: "Saturday", next_week: "Monday" } as const;

/** "Archive", "Add label Receipts", "Snooze until tomorrow 08:00", "Notify now". */
export function describeAction(action: RuleAction) {
  switch (action.verb) {
    case "label":
      return `Add label ${action.label || "…"}`;
    case "unlabel":
      return `Remove label ${action.label || "…"}`;
    case "snooze":
      return action.for.kind === "after"
        ? `Snooze for ${action.for.amount} ${action.for.amount === 1 ? action.for.unit.slice(0, -1) : action.for.unit}`
        : `Snooze until ${SNOOZE_NAMES[action.for.kind]} ${action.for.time}`;
    case "notify":
      return action.mode === "now" ? "Notify now" : action.mode === "batch" ? "Notify with the next batch" : "Don't notify";
    case "prepare_reply": {
      const first = action.template.trim().split("\n")[0].slice(0, 40);
      return first ? `Prepare a reply (“${first}${first.length === 40 ? "…" : ""}”)` : "Prepare a reply";
    }
    case "draft_reply": {
      const how = action.instruction.trim().replace(/\s+/g, " ").slice(0, 40);
      return how ? `Draft a reply with AI (“${how}${how.length === 40 ? "…" : ""}”)` : "Draft a reply with AI";
    }
    case "collect":
      return action.match ? `Add to a collection (one row per {${action.match}})` : "Add to a collection";
    case "expect": {
      const nudges = action.nudges.length;
      const then = nudges ? `, then ${nudges} nudge${nudges === 1 ? "" : "s"}${action.auto ? " sent by itself" : " ready to send"}` : "";
      return `${action.ask ? "Ask, and expect" : "Expect"} an answer within ${action.days} day${action.days === 1 ? "" : "s"}${then}`;
    }
    case "pack":
      return `${action.auto ? "Send" : "Prepare"} the period's collection to ${action.to || "…"}`;
    case "remind":
      return `Bring it back ${action.daysBefore ? `${action.daysBefore} day${action.daysBefore === 1 ? "" : "s"} before` : "on"} {${action.field || "date"}} at ${action.time}`;
    case "calendar":
      return `Add “${action.title}” to my calendar on {${action.field || "date"}}`;
    default:
      return VERBS[action.verb].label;
  }
}

// ---------------------------------------------------------------------------
// IF: a search-syntax query plus typed facts the query can't express.
// ---------------------------------------------------------------------------

export const SENDER_STATUSES = ["new", "pending", "allowed", "blocked"] as const;

export const ConditionSchema = z.discriminatedUnion("kind", [
  /** Someone you marked VIP (people table). */
  z.object({ kind: z.literal("vip"), negate: z.boolean().default(false) }),
  /** The sender's Screener status before this mail. new: no row in `senders` (Kite has never seen them). */
  z.object({ kind: z.literal("sender"), status: z.enum(SENDER_STATUSES), negate: z.boolean().default(false) }),
  /** The conversation is muted (thread_overrides). */
  z.object({ kind: z.literal("muted"), negate: z.boolean().default(false) }),
  /** The sender is one of these addresses (lower case): the senders an automation was built for. */
  z.object({ kind: z.literal("senders"), emails: z.array(z.string().trim().toLowerCase().min(3).max(320)).min(1).max(50), negate: z.boolean().default(false) }),
]);

export type Condition = z.infer<typeof ConditionSchema>;

const SENDER_WORDS = { new: "is new to you", pending: "is waiting in the Screener", allowed: "is let in", blocked: "is blocked" } as const;

export function describeCondition(c: Condition, trigger: Trigger = "new_mail") {
  const not = c.negate;
  switch (c.kind) {
    case "vip":
      return not ? "Sender isn't a VIP" : "Sender is a VIP";
    case "sender":
      return `Sender ${not ? `isn't ${SENDER_WORDS[c.status].replace(/^is /, "")}` : SENDER_WORDS[c.status]}`;
    case "muted":
      return not ? "Conversation isn't muted" : "Conversation is muted";
    case "senders": {
      const who = c.emails.length === 1 ? c.emails[0] : `${c.emails[0]} and ${c.emails.length - 1} more`;
      if (trigger === "schedule") return `For ${c.emails.length === 1 ? who : `${c.emails.length} people`}`;
      return trigger === "sent" ? `${not ? "Not to" : "To"} ${who}` : `${not ? "Not from" : "From"} ${who}`;
    }
  }
}

/** Search operators that make no sense for mail arriving now. */
const DATE_FIELDS = new Set(["before", "after"]);

const RuleQuery = z
  .string()
  .trim()
  .max(500)
  .refine(
    (q) => !parseSearch(q).some((t) => DATE_FIELDS.has(t.field) || (t.field === "is" && t.value === "snoozed")),
    "Rules run on mail as it arrives, so dates (before:, after:, newer_than:) and is:snoozed don't apply.",
  );

// ---------------------------------------------------------------------------
// The rule.
// ---------------------------------------------------------------------------

/** Built-in rules. They can be paused and edited, never deleted. */
const PRESETS = ["muted", "blocked", "screener", "vip-notify", "new-mail-notify"] as const;
export type PresetId = (typeof PRESETS)[number];

export const RuleSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1, "Give the rule a name").max(60),
  enabled: z.boolean(),
  /** What starts it ("Run on existing mail" is a button, not a trigger). */
  when: z.enum(TRIGGERS).default("new_mail"),
  /** When a `schedule` automation runs (null for the others). */
  schedule: Schedule.nullable().default(null),
  /** New mail only: minutes to wait before acting (notify still tells you at once). 0 = straight away. */
  delay: z.number().int().min(0).max(7 * 24 * 60).default(0),
  /** Account ids this rule covers; empty = every account. */
  accounts: z.array(z.string()).max(20).default([]),
  /** Gmail search syntax (from:, to:, subject:, has:attachment, filename:, label:, in:, is:, words). Empty = any mail. */
  query: RuleQuery.default(""),
  conditions: z.array(ConditionSchema).max(8).default([]),
  /** Read: values pulled from the email (lib/automations/fields.ts), usable as {key} in text and by Check. */
  fields: z.array(FieldSpec).max(12).default([]),
  /** Check: every one must hold for the actions to run (none = always). */
  checks: z.array(FieldCheck).max(8).default([]),
  actions: z.array(RuleActionSchema).min(1, "Add at least one action").max(12),
  /** Rules below this one don't run on mail it matched. */
  stop: z.boolean().default(false),
  /** "Also run in Gmail": the user turned on a Gmail filter for this rule (server/gmail-filters.ts). Off by default. */
  gmail: z.boolean().default(false),
  /** "Allow AI": the user let this rule send the new email to their AI (draft_reply). Off by default. */
  ai: z.boolean().default(false),
  /** The connected model this rule's AI drafts run on (by id); null = the one picked for rule drafts in Settings → AI. */
  aiModel: z.string().trim().max(120).nullable().default(null),
  preset: z.enum(PRESETS).optional(),
});

export type Rule = z.infer<typeof RuleSchema>;

/** What the rule editor sends (the server keeps id, position and preset). */
export const RuleDraftSchema = RuleSchema.omit({ id: true, preset: true }).extend({ enabled: z.boolean().default(true) });
export type RuleDraft = z.input<typeof RuleDraftSchema>;

/** A rule as Settings → Rules lists it. */
export type RuleView = Rule & { gmailFilters?: GmailFilterState[] };

/** One rule's work on one conversation (rule_runs), for the activity log. */
export type RuleRunView = {
  id: string;
  ruleId: string;
  ruleName: string;
  threadId: string;
  subject: string;
  at: string;
  trigger: "new" | "existing";
  batchId: string | null;
  /** What it did, as plain words ("archived", "labelled Receipts"). */
  done: string[];
  failed: boolean;
  /** Gmail's filter for this rule had already made the change (Kite only logged it). */
  inGmail: boolean;
  undoable: boolean;
  undoneAt: string | null;
};

/** What's wrong with how an automation's parts refer to each other, or null. */
export function referenceProblem(rule: Pick<Rule, "fields" | "checks" | "actions"> & Partial<Pick<Rule, "when" | "schedule" | "conditions" | "delay">>): string | null {
  const when = rule.when ?? "new_mail";
  const keys = new Map<string, FieldType>(rule.fields.map((f) => [f.key, f.type]));
  if (keys.size !== rule.fields.length) return "Two fields have the same name. Rename one.";
  for (const check of rule.checks) if (!keys.has(check.field)) return "A check looks at a field this automation doesn't read.";
  if (when === "schedule" && !rule.schedule) return "Pick when it runs.";
  if (when !== "new_mail" && rule.delay) return "Only automations on arriving mail can wait before acting.";
  if (when === "schedule" && (rule.fields.length || rule.checks.length)) return "A schedule has no email to read. Remove Read and Check.";
  for (const action of rule.actions) {
    if (!TRIGGER_VERBS[when].includes(action.verb)) return `“${VERBS[action.verb].label}” can't run ${when === "sent" ? "on mail you send" : when === "schedule" ? "on a schedule" : "on arriving mail"}.`;
    if ((action.verb === "remind" || action.verb === "calendar") && keys.get(action.field) !== "date" && action.field !== "received") {
      return action.verb === "remind" ? "Pick a date field for the reminder (add one under Read)." : "Pick a date field for the calendar event (add one under Read).";
    }
    if (action.verb === "collect" && action.match && !keys.has(action.match)) return "Pick a field this automation reads to keep one row per thing.";
    if (action.verb === "expect" && when === "schedule" && !rule.conditions?.some((c) => c.kind === "senders" && !c.negate)) {
      return "Pick the people you expect it from.";
    }
    if (action.verb === "expect" && action.ask && when !== "schedule") return "Only a schedule asks first. Remove the request, or run it on a schedule.";
    if (action.verb === "expect" && action.ask && !action.askSubject) return "Give the request a subject.";
  }
  return null;
}
