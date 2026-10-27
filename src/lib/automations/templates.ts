import type { FieldCheck, FieldSpec } from "./fields";
import type { RuleAction, Schedule, Trigger } from "../rules/spec";

// The starters in Automations' gallery. Each is a head start in the same wizard every automation
// is built in (automations/guided.tsx): who to pick, what to click in their email, and the steps
// already switched on. Nothing is saved until the last step, and all of it can be changed.
// A collection a starter adds to is named `new:<name>`; it's made on Save (an existing one with
// that name is used instead).

export type Starter = {
  id: string;
  name: string;
  /** One line on the card. */
  about: string;
  /** Which shelf of the gallery it sits on. */
  group: "money" | "waiting" | "tidy";
  /** What starts it (new mail when absent). */
  when?: Trigger;
  /** A schedule starter's day. */
  schedule?: Schedule;
  /** New mail: minutes to wait before acting. */
  delay?: number;
  /** Step 1: whose emails to pick (for a schedule, who it's for). */
  pick: string;
  /** Step 1 starts from words instead of people (each email goes to someone different). */
  bySearch?: boolean;
  /** Step 2: what to click in their email, in order (each click takes the next name). */
  wants: string[];
  /** Fields read without a click (their company, a status the automation sets). */
  fields?: FieldSpec[];
  /** Words a search can start from, when the senders aren't enough (optional). */
  query?: string;
  /** The steps switched on at the start. */
  actions: RuleAction[];
  checks?: FieldCheck[];
};

const PAY_NUDGES = [
  "Hi {first_name},\n\nA friendly reminder that this invoice is now due. Could you let me know once it's paid?\n\nThanks",
  "Hi {first_name},\n\nFollowing up on this invoice, which is now overdue. When can I expect payment?\n\nThanks",
  "Hi {first_name},\n\nThis invoice is still unpaid. Please arrange payment today, or let me know if there's a problem with it.",
];

const DOC_ASK = "Hi {first_name},\n\nCould you send me your bank statements and receipts for {period} when you get a chance?\n\nThanks";
const DOC_NUDGES = [
  "Hi {first_name},\n\nJust checking in on the documents for {period}. Could you send them through this week?\n\nThanks",
  "Hi {first_name},\n\nI still need your documents for {period} to get started. Could you send them today?\n\nThanks",
];

export const STARTERS: Starter[] = [
  {
    id: "get-paid",
    name: "Get paid",
    group: "waiting",
    when: "sent",
    about: "Invoices you send in one list, and a polite nudge ready when payment doesn't come.",
    pick: "Pick the clients you invoice.",
    query: "invoice",
    wants: ["Amount", "Invoice number"],
    actions: [
      { verb: "collect", collection: "new:Invoices sent", match: null },
      { verb: "expect", days: 14, answer: "", askSubject: "", ask: "", nudges: PAY_NUDGES, every: 7, auto: false },
    ],
  },
  {
    id: "client-documents",
    name: "Client documents",
    group: "waiting",
    when: "schedule",
    schedule: { every: "month", day: 1, time: "09:00" },
    about: "On the 1st, ask each client for last month's documents, see who's sent them, nudge the rest.",
    pick: "Pick the clients to ask.",
    wants: [],
    actions: [{ verb: "expect", days: 7, answer: "", askSubject: "Documents for {period}", ask: DOC_ASK, nudges: DOC_NUDGES, every: 4, auto: false }],
  },
  {
    id: "waiting-reply",
    name: "Waiting for a reply",
    group: "waiting",
    when: "sent",
    about: "Mail you send to these people: a nudge ready if they haven't answered in a few days.",
    pick: "Pick the people whose answers you can't afford to lose track of.",
    wants: [],
    actions: [{ verb: "expect", days: 4, answer: "", askSubject: "", ask: "", nudges: ["Hi {first_name},\n\nJust bringing this back to the top of your inbox. Any thoughts?\n\nThanks"], every: 7, auto: false }],
  },
  {
    id: "month-end",
    name: "Month-end pack",
    group: "money",
    when: "schedule",
    schedule: { every: "month", day: 1, time: "08:00" },
    about: "On the 1st, last month's invoices and receipts in one email to your accountant, files attached.",
    pick: "",
    wants: [],
    actions: [{ verb: "pack", collection: "", to: "", subject: "Invoices and receipts for {period}", auto: false }],
  },
  {
    id: "spending",
    name: "Spending",
    group: "money",
    about: "Every card payment from your bank's emails, totalled by month.",
    pick: "Pick your bank. Choose every address it sends payment emails from.",
    wants: ["Amount", "Shop", "Card"],
    actions: [{ verb: "collect", collection: "new:Spending", match: null }],
  },
  {
    id: "bills",
    name: "Bills",
    group: "money",
    about: "Every bill in one list, back in your inbox two days before it's due.",
    pick: "Pick the companies that send you bills.",
    wants: ["Amount", "Due date"],
    actions: [
      { verb: "collect", collection: "new:Bills", match: null },
      { verb: "remind", field: "due_date", daysBefore: 2, time: "09:00" },
    ],
  },
  {
    id: "receipts",
    name: "Receipts",
    group: "money",
    about: "Receipts filed out of your inbox, with a running total by month (and ready for the month-end pack).",
    pick: "Pick the shops and suppliers you buy from.",
    wants: ["Total", "Download link"],
    actions: [{ verb: "collect", collection: "new:Receipts", match: null }, { verb: "mark_read" }, { verb: "archive" }],
  },
  {
    id: "purchases",
    name: "Purchases",
    group: "money",
    about: "Orders in one list, and back in your inbox a few days before a 30-day return window closes.",
    pick: "Pick the shops you order from.",
    query: "order",
    wants: ["Total", "Order number"],
    actions: [{ verb: "collect", collection: "new:Purchases", match: null }, { verb: "snooze", for: { kind: "after", amount: 26, unit: "days" } }],
  },
  {
    id: "job-applications",
    name: "Job applications",
    group: "waiting",
    when: "sent",
    bySearch: true,
    about: "Every application you send in one table, one row per company, and a follow-up ready after three weeks.",
    pick: "Which emails are applications? Kite starts from these words; change them to how you write yours.",
    query: "subject:application OR subject:applying OR subject:CV OR subject:resume",
    wants: [],
    fields: [
      { key: "company", name: "Company", type: "text", from: { kind: "builtin", builtin: "company" } },
      { key: "role", name: "Role", type: "text", from: { kind: "builtin", builtin: "subject" } },
      { key: "status", name: "Status", type: "text", from: { kind: "fixed", value: "Applied" } },
      { key: "applied", name: "Applied", type: "date", from: { kind: "builtin", builtin: "received" } },
    ],
    actions: [
      { verb: "collect", collection: "new:Applications", match: "company" },
      {
        verb: "expect",
        days: 21,
        answer: "",
        askSubject: "",
        ask: "",
        nudges: ["Hi {first_name},\n\nI applied for this role three weeks ago and wanted to check where things stand. I'm still very interested.\n\nThanks"],
        every: 7,
        auto: false,
      },
    ],
  },
  {
    id: "job-replies",
    name: "Job replies",
    group: "waiting",
    bySearch: true,
    about: "Replies about your applications update the same table: interview, rejection, offer.",
    pick: "Which emails are replies to your applications? Kite starts from these words.",
    query: "application OR candidacy OR interview OR applying",
    wants: [],
    fields: [
      { key: "company", name: "Company", type: "text", from: { kind: "builtin", builtin: "company" } },
      { key: "status", name: "Status", type: "text", from: { kind: "fixed", value: "Heard back" } },
      { key: "replied", name: "Replied", type: "date", from: { kind: "builtin", builtin: "received" } },
    ],
    actions: [{ verb: "collect", collection: "new:Applications", match: "company" }, { verb: "star" }],
  },
  {
    id: "school",
    name: "School dates",
    group: "tidy",
    about: "Dates from the school's emails on your calendar, and every notice in one list.",
    pick: "Pick the school, the class teacher and the clubs.",
    wants: ["Date"],
    actions: [
      { verb: "calendar", field: "date", title: "{subject}" },
      { verb: "collect", collection: "new:School", match: null },
      { verb: "star" },
    ],
  },
  {
    id: "alerts-later",
    name: "Alerts, then away",
    group: "tidy",
    delay: 60,
    about: "Alerts stay in your inbox for an hour so you see them, then file themselves.",
    pick: "Pick who sends the alerts (monitoring, banking, deliveries).",
    wants: [],
    actions: [{ verb: "mark_read" }, { verb: "archive" }],
  },
  {
    id: "trips",
    name: "Trips",
    group: "tidy",
    about: "Flights and hotels on your calendar, with the booking reference.",
    pick: "Pick your airlines and booking sites.",
    wants: ["Date", "Reference"],
    actions: [
      { verb: "calendar", field: "date", title: "{subject} ({reference})" },
      { verb: "collect", collection: "new:Trips", match: null },
      { verb: "star" },
    ],
  },
  {
    id: "parcels",
    name: "Parcels",
    group: "tidy",
    about: "What's on its way: tracking links in one list, the emails out of your inbox.",
    pick: "Pick the shops and couriers you order from.",
    wants: ["Tracking link", "Order"],
    actions: [{ verb: "collect", collection: "new:Parcels", match: null }, { verb: "archive" }],
  },
  {
    id: "big-payments",
    name: "Big payments",
    group: "money",
    about: "A notification the moment a big payment leaves your account.",
    pick: "Pick your bank.",
    wants: ["Amount"],
    checks: [{ field: "amount", op: "more", value: "5000" }],
    actions: [{ verb: "notify", mode: "now" }, { verb: "star" }],
  },
  {
    id: "invoices",
    name: "Invoice received",
    group: "money",
    about: "A thank-you reply with the invoice number filled in, ready for you to send.",
    pick: "Pick the people and companies who invoice you.",
    wants: ["Invoice number"],
    actions: [{ verb: "prepare_reply", template: "Hi {first_name},\n\nThanks, invoice {invoice_number} received. I'll pay it by the due date." }],
  },
];

export const STARTER_GROUPS: { id: Starter["group"]; name: string }[] = [
  { id: "waiting", name: "Chase and wait" },
  { id: "money", name: "Money" },
  { id: "tidy", name: "Tidy and remember" },
];

/** "new:Bills" -> "Bills": a collection a starter makes on Save. */
export const newCollectionName = (id: string) => (id.startsWith("new:") ? id.slice(4) : null);
