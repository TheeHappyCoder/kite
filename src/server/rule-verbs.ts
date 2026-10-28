import "server-only";

import { VERBS, describeAction, snoozeUntil, type NotifyMode, type RuleAction, type Verb } from "@/lib/rules/spec";
import type { Thread } from "@/lib/mail/types";
import { applyLabelChange } from "@/lib/mail/providers";
import { getDb, setSnooze, type AccountRow } from "./db";
import { folderTest } from "./labels";
import { INBOX, TRASH } from "@/lib/mail/mailboxes";
import { mailOf } from "./providers/registry";
import { getThreadRow, setSenderStatus, updateMessageLabels } from "./store";
import { getOverride, updateOverride } from "./overrides";
import { discardPrepared, hasAiDraft, putPrepared } from "./prepared";
import { draftsBlocked, queueAiDraft } from "./ai-drafts";
import { fillBlanks, type BlankValues } from "@/lib/rules/prepared";
import { blankValues, type FieldSpec, type FieldValues } from "@/lib/automations/fields";
import { addRow, collectionExists, hasRow, removeRow, restoreRow, upsertRow, type RowBefore } from "./collections";
import { addKiteEvent, removeLocalEvent } from "./mail-calendar";
import { createExpectation, removeExpectation, waitingOn } from "./expectations";
import type { ExpectPerson } from "@/lib/automations/expect";
import { moveItems, spaceExists, threadSpaces } from "./spaces";

// One executor per rule verb (lib/rules/spec.ts VERBS). Executors only plan: they turn an action
// into an Effect without side effects, so the engine (server/rules.ts) can merge every matching
// rule's Gmail changes for a conversation into one call. `applyEffects` then makes the changes,
// Gmail first, and returns what each rule did plus the steps that undo it.

export type VerbContext = {
  account: AccountRow;
  /** Kite thread id. */
  threadId: string;
  /** Lower-cased address of who sent the mail, or null when it's all yours. */
  sender: string | null;
  /** Kite had never seen the sender before this mail. */
  senderNew: boolean;
  /** The account's own label id for a name (case-insensitive), or null. */
  labelId: (name: string) => string | null;
  /** The message a prepared reply answers (the newest one someone else sent) and its blanks, or null when it's all yours. */
  reply: () => { messageId: string; values: BlankValues } | null;
  /** What this automation read from the email (Read), with the fields it read them by. Set per automation. */
  read?: { fields: FieldSpec[]; values: FieldValues; ruleId: string; message: { id: string; subject: string; sender: string; date: string } };
  /**
   * The other party and the email the run is about: the sender of new mail, or who your sent mail
   * went to (the expect verb waits on them). Null when there's nobody (mail to yourself).
   */
  about?: { who: ExpectPerson[]; messageId: string; subject: string; date: string } | null;
};

/** A date the automation read, or when the email came for `received`. */
function dateOf(ctx: VerbContext, key: string) {
  if (!ctx.read) return null;
  if (key === "received") return ctx.read.message.date;
  return ctx.read.values[key]?.date ?? null;
}

/** `{blanks}` filled as plain text (event titles): the email's own blanks, then what the automation read. */
function plainFill(template: string, ctx: VerbContext) {
  const values: Record<string, string> = { ...(ctx.reply()?.values ?? {}), ...(ctx.read ? blankValues(ctx.read.values) : {}) };
  return template.replace(/\{([a-z][a-z0-9_]{0,31})\}/g, (whole, key: string) => values[key]?.trim() || whole).trim();
}

type Effect =
  /** On the messages the rule acts on. */
  | { type: "labels"; add: string[]; remove: string[] }
  | { type: "trash" }
  | { type: "override"; field: "pinned" | "muted" }
  /** On the whole conversation (snoozes are per conversation). */
  | { type: "snooze"; until: string }
  | { type: "screen" }
  | { type: "notify"; mode: NotifyMode }
  /** Local only: waits in the quick-reply box. */
  | { type: "prepare"; messageId: string; body: string; missing: string[] }
  /** Queued for your AI (server/ai-drafts.ts); the draft waits in the quick-reply box. */
  | { type: "ai_draft"; messageId: string; instruction: string }
  /** A row in one of your collections (`match`: update the row with the same value of that field). */
  | { type: "collect"; collection: string; match: string | null }
  /** An event on Kite's own calendar. */
  | { type: "event"; title: string; start: string; allDay: boolean }
  /** Waiting for an answer (server/expectations.ts). */
  | { type: "expect"; action: Extract<RuleAction, { verb: "expect" }> }
  /** In one of Kite's spaces (server/spaces.ts). */
  | { type: "space"; space: string };

type Planned = Effect | { skip: string };

type Executors = { [V in Verb]: (action: Extract<RuleAction, { verb: V }>, ctx: VerbContext) => Planned };

const label = (add: string[], remove: string[] = []): Effect => ({ type: "labels", add, remove });

const EXECUTORS: Executors = {
  label: (a, ctx) => {
    const id = ctx.labelId(a.label);
    return id ? label([id]) : { skip: `No label “${a.label}” in this account` };
  },
  unlabel: (a, ctx) => {
    const id = ctx.labelId(a.label);
    return id ? label([], [id]) : { skip: `No label “${a.label}” in this account` };
  },
  archive: () => label([], ["INBOX"]),
  star: () => label(["STARRED"]),
  mark_read: () => label([], ["UNREAD"]),
  trash: () => ({ type: "trash" }),
  pin: () => ({ type: "override", field: "pinned" }),
  mute: () => ({ type: "override", field: "muted" }),
  snooze: (a) => ({ type: "snooze", until: snoozeUntil(a.for).toISOString() }),
  screen: (_a, ctx) => (!ctx.sender ? { skip: "Your own mail" } : ctx.senderNew ? { type: "screen" } : { skip: "Kite already knows this sender" }),
  notify: (a) => ({ type: "notify", mode: a.mode }),
  prepare_reply: (a, ctx) => {
    const reply = ctx.reply();
    if (!reply) return { skip: "Your own mail" };
    // What the automation read fills blanks too ("Thanks, invoice {invoice} received").
    return { type: "prepare", messageId: reply.messageId, ...fillBlanks(a.template, { ...reply.values, ...(ctx.read ? blankValues(ctx.read.values) : {}) }) };
  },
  draft_reply: (a, ctx) => {
    const reply = ctx.reply();
    if (!reply) return { skip: "Your own mail" };
    const blocked = draftsBlocked();
    return blocked ? { skip: blocked } : { type: "ai_draft", messageId: reply.messageId, instruction: a.instruction };
  },
  collect: (a, ctx) => {
    if (!ctx.read) return { skip: "Nothing was read from this email" };
    if (!collectionExists(a.collection)) return { skip: "That collection was deleted" };
    if (hasRow(a.collection, ctx.read.message.id)) return { skip: "Already in that collection" };
    return { type: "collect", collection: a.collection, match: a.match };
  },
  expect: (a, ctx) => {
    if (!ctx.about?.who.length) return { skip: "Nobody to wait on" };
    return { type: "expect", action: a };
  },
  pack: () => ({ skip: "Packs run on a schedule" }),
  space: (a, ctx) => {
    if (!spaceExists(a.space)) return { skip: "That space was deleted" };
    if (threadSpaces([ctx.threadId])[ctx.threadId]?.includes(a.space)) return { skip: "Already in that space" };
    return { type: "space", space: a.space };
  },
  remind: (a, ctx) => {
    const date = dateOf(ctx, a.field);
    if (!date) return { skip: "The email didn't have that date" };
    const at = new Date(date);
    at.setDate(at.getDate() - a.daysBefore);
    const [h, m] = a.time.split(":").map(Number);
    at.setHours(h, m, 0, 0);
    if (at.getTime() <= Date.now()) return { skip: "That date has passed" };
    return { type: "snooze", until: at.toISOString() };
  },
  calendar: (a, ctx) => {
    const date = dateOf(ctx, a.field);
    if (!date) return { skip: "The email didn't have that date" };
    const at = new Date(date);
    // A date with a time is a one-hour event at that time; a plain date is an all-day one.
    const allDay = !at.getHours() && !at.getMinutes();
    return { type: "event", title: plainFill(a.title, ctx) || "From your mail", start: at.toISOString(), allDay };
  },
};

export function plan(action: RuleAction, ctx: VerbContext): Planned {
  return (EXECUTORS[action.verb] as (a: RuleAction, c: VerbContext) => Planned)(action, ctx);
}

/** What Undo does for one run, in order. */
export type UndoStep =
  | { type: "labels"; ids: string[]; add: string[]; remove: string[] }
  | { type: "untrash"; ids: string[]; inbox: string[] }
  | { type: "override"; field: "pinned" | "muted" }
  | { type: "unsnooze"; key: string; ids: string[] }
  | { type: "sender"; email: string }
  | { type: "unprepare"; id: string }
  | { type: "uncollect"; id: string }
  | { type: "recollect"; id: string; before: RowBefore }
  | { type: "unevent"; id: string }
  | { type: "unexpect"; id: string }
  | { type: "unspace"; space: string };

/** `gmail`: the rule's Gmail filter had already made this change (Kite only logged it, with Undo). */
export type ActionResult = { verb: Verb; text: string; done: string; ok: boolean; skip?: string; gmail?: boolean };

export type RuleWork = {
  rule: { id: string; name: string };
  /** The rule's actions, planned in order. */
  actions: { action: RuleAction; planned: Planned }[];
  /** The rule's Gmail filter is in this account: changes already in place on the new messages are its work. */
  inGmail?: boolean;
  /** What this automation read from the email (its collection rows are made from it). */
  read?: VerbContext["read"];
};

type WorkResult = { results: ActionResult[]; undo: UndoStep[] };

const doneText = (action: RuleAction) =>
  action.verb === "label" || action.verb === "unlabel"
    ? `${VERBS[action.verb].done} ${action.label}`
    : action.verb === "notify"
      ? action.mode === "silent"
        ? "kept quiet"
        : "notified"
      : VERBS[action.verb].done;

/**
 * Makes the planned changes for one conversation: `targets` are the messages the rules act on
 * (the new ones, or every message for "Run on existing mail"). Rules are applied in order on a
 * copy of each message's labels, so each rule's undo holds only what it really changed; Gmail then
 * gets the net change once. Throws when Gmail refuses (nothing local is changed then).
 */
export async function applyEffects(ctx: VerbContext, targets: string[], work: RuleWork[]): Promise<WorkResult[]> {
  const { account, threadId } = ctx;
  const row = getThreadRow(threadId);
  if (!row) return work.map(() => ({ results: [], undo: [] }));
  const thread = JSON.parse(row.data) as Thread;
  const rowLabels = JSON.parse(row.labels) as string[];
  const original = new Map(thread.messages.map((m) => [m.id, new Set(m.labels ?? rowLabels)]));
  const sim = new Map([...original].map(([id, labels]) => [id, new Set(labels)]));
  const targetIds = targets.filter((id) => sim.has(id));
  const trashed = new Set<string>();
  const key = threadId.slice(account.id.length + 1);
  let snoozeAt: string | null = null;
  let screened = false;
  const overridden = new Set<string>();
  const local: (() => void)[] = [];
  const isFolder = folderTest(account.id);

  let prepared = false;
  // Messages a Gmail filter could have acted on (filters skip your own mail), and the changes
  // already credited to one, so two rules don't both claim the same label.
  const filtered = targetIds.filter((id) => !["SENT", "DRAFT", "SPAM"].some((l) => original.get(id)!.has(l)));
  const claimed = new Set<string>();
  const byFilter = (ids: string[], change: string) => {
    const mine = ids.filter((id) => !claimed.has(`${id}:${change}`));
    mine.forEach((id) => claimed.add(`${id}:${change}`));
    return mine;
  };

  const out: WorkResult[] = work.map(({ rule, actions, inGmail, read }) => {
    const results: ActionResult[] = [];
    const undo: UndoStep[] = [];
    // A folder move takes the mail out of the inbox, so an Archive in the same rule is part of it.
    const moves = actions.some(({ action, planned }) => action.verb === "label" && !("skip" in planned) && planned.type === "labels" && planned.add.some(isFolder));
    for (const { action, planned } of actions) {
      if (action.verb === "archive" && moves) continue;
      const base = { verb: action.verb, text: describeAction(action), done: doneText(action) };
      let gmail = false;
      if ("skip" in planned) {
        results.push({ ...base, ok: false, skip: planned.skip });
        continue;
      }
      const effect = planned;
      switch (effect.type) {
        case "labels": {
          if ([...effect.add, ...effect.remove].some(isFolder)) {
            // A folder: each message moves from where it is, and Undo puts each one back there.
            const steps = new Map<string, Extract<UndoStep, { type: "labels" }>>();
            for (const id of targetIds.filter((id) => !trashed.has(id))) {
              const before = sim.get(id)!;
              const after = applyLabelChange(before, effect, isFolder);
              const added = [...after].filter((l) => !before.has(l)).sort();
              const removed = [...before].filter((l) => !after.has(l)).sort();
              if (!added.length && !removed.length) continue;
              sim.set(id, after);
              const sig = `${added}|${removed}`;
              const step = steps.get(sig) ?? { type: "labels", ids: [], add: removed, remove: added };
              step.ids.push(id);
              steps.set(sig, step);
            }
            undo.push(...steps.values());
            if (effect.add.some(isFolder) && (action.verb === "label" || action.verb === "unlabel")) {
              results.push({ ...base, text: `Move to ${action.label}`, done: `moved to ${action.label}`, ok: true });
              continue;
            }
            break;
          }
          for (const l of effect.add) {
            const ids = targetIds.filter((id) => !trashed.has(id) && !sim.get(id)!.has(l));
            ids.forEach((id) => sim.get(id)!.add(l));
            if (ids.length) undo.push({ type: "labels", ids, add: [], remove: [l] });
            const done = inGmail ? byFilter(filtered.filter((id) => original.get(id)!.has(l)), `+${l}`) : [];
            if (done.length) undo.push({ type: "labels", ids: done, add: [], remove: [l] });
            gmail ||= done.length > 0 && !ids.length;
          }
          for (const l of effect.remove) {
            const ids = targetIds.filter((id) => sim.get(id)!.has(l));
            ids.forEach((id) => sim.get(id)!.delete(l));
            if (ids.length) undo.push({ type: "labels", ids, add: [l], remove: [] });
            const done = inGmail ? byFilter(filtered.filter((id) => !original.get(id)!.has(l)), `-${l}`) : [];
            if (done.length) undo.push({ type: "labels", ids: done, add: [l], remove: [] });
            gmail ||= done.length > 0 && !ids.length;
          }
          break;
        }
        case "trash": {
          // Already in Trash: Gmail's filter put it there (Undo brings it back to the inbox).
          const already = targetIds.filter((id) => original.get(id)!.has("TRASH"));
          const ids = targetIds.filter((id) => !trashed.has(id) && !already.includes(id));
          ids.forEach((id) => trashed.add(id));
          const inbox = ids.filter((id) => sim.get(id)!.has("INBOX"));
          if (ids.length) undo.push({ type: "untrash", ids, inbox });
          const done = inGmail ? byFilter(already.filter((id) => filtered.includes(id)), "trash") : [];
          if (done.length) undo.push({ type: "untrash", ids: done, inbox: done });
          gmail ||= done.length > 0 && !ids.length;
          break;
        }
        case "snooze": {
          // The whole conversation leaves the inbox until it wakes (snoozes are per conversation).
          const ids = [...sim].filter(([id, labels]) => labels.has("INBOX") && !trashed.has(id)).map(([id]) => id);
          ids.forEach((id) => sim.get(id)!.delete("INBOX"));
          if (!snoozeAt) {
            snoozeAt = effect.until;
            undo.push({ type: "unsnooze", key, ids });
          }
          break;
        }
        case "override": {
          const current = getOverride(threadId);
          const set = effect.field === "pinned" ? !!current?.pinnedAt : !!current?.muted;
          if (!set && !overridden.has(effect.field)) {
            overridden.add(effect.field);
            local.push(() => updateOverride(threadId, { [effect.field]: true }));
            undo.push({ type: "override", field: effect.field });
          }
          break;
        }
        case "screen": {
          const email = ctx.sender!;
          // Only someone Kite has never seen: never hold back a person you already know.
          if (ctx.senderNew && !screened) {
            screened = true;
            local.push(() => setSenderStatus(email, "pending"));
            undo.push({ type: "sender", email });
          }
          break;
        }
        case "prepare": {
          // One prepared reply per conversation: the first rule that prepares one wins.
          if (prepared) {
            results.push({ ...base, ok: false, skip: "Another automation already prepared a reply" });
            continue;
          }
          prepared = true;
          const id = crypto.randomUUID();
          const { messageId, body, missing } = effect;
          local.push(() => putPrepared(threadId, account.id, { id, ruleId: rule.id, ruleName: rule.name, messageId, body, missing }));
          undo.push({ type: "unprepare", id });
          break;
        }
        case "ai_draft": {
          // One reply per conversation, and one AI draft per conversation until it's used or discarded.
          const taken = prepared ? "Another automation already prepared a reply" : hasAiDraft(threadId) ? "Your AI already drafted a reply here" : null;
          if (taken) {
            results.push({ ...base, ok: false, skip: taken });
            continue;
          }
          prepared = true;
          const id = crypto.randomUUID();
          const { messageId, instruction } = effect;
          local.push(() => queueAiDraft({ id, threadId, accountId: account.id, ruleId: rule.id, ruleName: rule.name, messageId, instruction }));
          undo.push({ type: "unprepare", id });
          break;
        }
        case "collect": {
          if (!read) break;
          const columns = read.fields.map((f) => ({ key: f.key, name: f.name, type: f.type }));
          local.push(() => {
            const row = {
              collectionId: effect.collection,
              ruleId: read.ruleId,
              accountId: account.id,
              threadId,
              messageId: read.message.id,
              subject: read.message.subject,
              sender: read.message.sender,
              at: read.message.date,
              values: read.values,
              columns,
            };
            if (effect.match) {
              // One row per thing: Undo puts an updated row back as it was, or removes a new one.
              const made = upsertRow(row, effect.match);
              if (made) undo.push(made.before ? { type: "recollect", id: made.id, before: made.before } : { type: "uncollect", id: made.id });
              return;
            }
            const made = addRow(row);
            // The row's own id, so Undo removes exactly it.
            if (made) undo.push({ type: "uncollect", id: made });
          });
          break;
        }
        case "expect": {
          const about = ctx.about!;
          if (waitingOn(rule.id, threadId)) {
            results.push({ ...base, ok: false, skip: "Already waiting on this conversation" });
            continue;
          }
          const a = effect.action;
          local.push(() => {
            const id = createExpectation({
              ruleId: rule.id,
              ruleName: rule.name,
              accountId: account.id,
              threadId,
              messageId: about.messageId,
              who: about.who,
              subject: about.subject,
              answer: a.answer,
              plan: { askSubject: "", ask: "", nudges: a.nudges, every: a.every, auto: a.auto },
              period: null,
              since: about.date,
              days: a.days,
            });
            if (id) undo.push({ type: "unexpect", id });
          });
          break;
        }
        case "space": {
          const space = effect.space;
          local.push(() => moveItems({ to: space, from: [], threads: [threadId] }));
          undo.push({ type: "unspace", space });
          break;
        }
        case "event": {
          local.push(() => {
            const id = addKiteEvent(account, { summary: effect.title, start: effect.start, allDay: effect.allDay });
            undo.push({ type: "unevent", id });
          });
          break;
        }
        case "notify":
          break;
      }
      results.push({ ...base, ok: true, ...(gmail ? { gmail } : {}) });
    }
    return { results, undo };
  });

  // Gmail: the net change per message, grouped so messages with the same change share a call.
  const groups = new Map<string, { add: string[]; remove: string[]; ids: string[] }>();
  for (const [id, before] of original) {
    const after = sim.get(id)!;
    const add = [...after].filter((l) => !before.has(l)).sort();
    const remove = [...before].filter((l) => !after.has(l)).sort();
    if (!add.length && !remove.length) continue;
    const sig = `${add.join(",")}|${remove.join(",")}`;
    const group = groups.get(sig) ?? { add, remove, ids: [] };
    group.ids.push(id);
    groups.set(sig, group);
  }
  const mail = mailOf(account);
  for (const g of groups.values()) await mail.modifyMessages(account, g.ids, { add: g.add, remove: g.remove });
  if (trashed.size) await mail.modifyMessages(account, [...trashed], { add: [TRASH], remove: [INBOX] });

  for (const g of groups.values()) updateMessageLabels(threadId, g.ids, g.add, g.remove);
  if (trashed.size) updateMessageLabels(threadId, [...trashed], ["TRASH"], ["INBOX"]);
  if (snoozeAt) setSnooze(account.id, key, snoozeAt);
  local.forEach((f) => f());
  return out;
}

/** Reverses one run's changes (Gmail first). Steps that no longer apply are harmless. */
export async function undoSteps(account: AccountRow, threadId: string, steps: UndoStep[]) {
  const mail = mailOf(account);
  for (const step of [...steps].reverse()) {
    switch (step.type) {
      case "labels":
        await mail.modifyMessages(account, step.ids, { add: step.add, remove: step.remove });
        updateMessageLabels(threadId, step.ids, step.add, step.remove);
        break;
      case "untrash":
        await mail.modifyMessages(account, step.ids, { add: [], remove: [TRASH] });
        await mail.modifyMessages(account, step.inbox, { add: [INBOX], remove: [] });
        updateMessageLabels(threadId, step.ids, [], ["TRASH"]);
        if (step.inbox.length) updateMessageLabels(threadId, step.inbox, ["INBOX"], []);
        break;
      case "unsnooze":
        setSnooze(account.id, step.key, null);
        if (step.ids.length) {
          await mail.modifyMessages(account, step.ids, { add: [INBOX], remove: [] });
          updateMessageLabels(threadId, step.ids, ["INBOX"], []);
        }
        break;
      case "override":
        updateOverride(threadId, { [step.field]: false });
        break;
      case "sender":
        // Still waiting: let them in. A choice made since (Allow, Block) stays.
        getDb().prepare("UPDATE senders SET status = 'allowed', updated_at = ? WHERE email = ? AND status = 'pending'").run(new Date().toISOString(), step.email);
        break;
      case "unprepare":
        discardPrepared(threadId, step.id);
        break;
      case "uncollect":
        removeRow(step.id);
        break;
      case "recollect":
        restoreRow(step.id, step.before);
        break;
      case "unexpect":
        removeExpectation(step.id);
        break;
      case "unevent":
        removeLocalEvent(step.id);
        break;
      case "unspace":
        moveItems({ to: null, from: [step.space], threads: [threadId] });
        break;
    }
  }
}
