// Expect (the `expect` verb, lib/rules/spec.ts): an automation waiting for an answer. Each one is
// a row in `expectations` (server/expectations.ts): who it's from, what counts as the answer, and
// the asks and nudges that follow when nothing comes. Shared by the server and the Waiting on view;
// `stepOf` decides what's next from the row alone, so both agree.

export type ExpectPerson = { email: string; name: string };

/** A nudge ladder to start from: polite, firmer, final. `{first_name}` is who it goes to. */
export const NUDGES = [
  "Hi {first_name},\n\nJust checking in on this. Could you let me know when you get a moment?\n\nThanks",
  "Hi {first_name},\n\nFollowing up again on this, as I haven't heard back. Could you send it through this week?\n\nThanks",
  "Hi {first_name},\n\nThis is still outstanding. Please could you sort it out today, or let me know if something's holding it up.",
];

/**
 * The messages that go with it: the request (schedules), then the nudge ladder. `period`: what a
 * scheduled run is about ("October 2026"), the `{period}` blank.
 */
export type ExpectPlan = { askSubject: string; ask: string; nudges: string[]; every: number; auto: boolean; period?: string };

export type ExpectStatus = "waiting" | "met" | "stopped";

export type Expectation = {
  id: string;
  ruleId: string;
  ruleName: string;
  accountId: string;
  /** The conversation it's about (Kite thread id), or null for a request not sent yet. */
  threadId: string | null;
  who: ExpectPerson[];
  /** What it's about (the email's subject, or the request's). */
  subject: string;
  /** What counts as the answer (search syntax); empty = any reply from them. */
  answer: string;
  plan: ExpectPlan;
  /** When waiting started (the email, or the scheduled run). */
  since: string;
  dueAt: string;
  askedAt: string | null;
  /** Nudges sent so far, and when the last one went. */
  nudged: number;
  nudgedAt: string | null;
  status: ExpectStatus;
  metAt: string | null;
  /** Where the answer came (Kite thread id), to open it. */
  metThreadId: string | null;
  /** The last automatic send that failed, in plain words. */
  error: string | null;
};

export type ExpectStep =
  /** The request is ready to send. */
  | { kind: "ask" }
  /** Nudge `index` (0-based) is ready to send. */
  | { kind: "nudge"; index: number }
  /** Not due yet, or the next nudge isn't (`next`). */
  | { kind: "waiting"; overdue: boolean; next: string | null }
  | { kind: "met" }
  | { kind: "stopped" };

const DAY = 86_400_000;

/** What's next for an expectation at `now`. */
export function stepOf(e: Pick<Expectation, "status" | "plan" | "askedAt" | "dueAt" | "nudged" | "nudgedAt">, now = Date.now()): ExpectStep {
  if (e.status === "met") return { kind: "met" };
  if (e.status === "stopped") return { kind: "stopped" };
  if (e.plan.ask && !e.askedAt) return { kind: "ask" };
  const due = Date.parse(e.dueAt);
  if (now < due) return { kind: "waiting", overdue: false, next: e.dueAt };
  if (e.nudged >= e.plan.nudges.length) return { kind: "waiting", overdue: true, next: null };
  const ready = e.nudged === 0 || !e.nudgedAt ? due : Date.parse(e.nudgedAt) + e.plan.every * DAY;
  if (now >= ready) return { kind: "nudge", index: e.nudged };
  return { kind: "waiting", overdue: true, next: new Date(ready).toISOString() };
}

/** Something to send now (a request or a nudge). */
export const isReady = (step: ExpectStep) => step.kind === "ask" || step.kind === "nudge";

/** "Acme", "Acme and 2 more". */
export function whoText(who: ExpectPerson[]) {
  const first = who[0] ? who[0].name || who[0].email : "someone";
  return who.length > 1 ? `${first} and ${who.length - 1} more` : first;
}

/** One line on where it stands, for the list. */
export function stepText(step: ExpectStep, e: Pick<Expectation, "plan" | "nudged">) {
  switch (step.kind) {
    case "ask":
      return e.plan.auto ? "Sending the request" : "Request ready to send";
    case "nudge": {
      const which = e.plan.nudges.length > 1 ? ["First", "Second", "Last"][Math.min(step.index, 2)] : "A";
      return `${which} nudge ${e.plan.auto ? "going out" : "ready to send"}`;
    }
    case "waiting":
      return step.overdue ? (step.next ? `Overdue · nudged ${e.nudged} time${e.nudged === 1 ? "" : "s"}` : "Overdue · no more nudges") : "Waiting";
    case "met":
      return "Answered";
    case "stopped":
      return "Stopped waiting";
  }
}
