import type { Account, Contact, Thread } from "./types";
import type { MailLabel } from "./providers";
import type { CalendarEvent } from "../calendar/event";

// Demo mailbox shown until a real account is connected. Dates are relative to
// "now" so the inbox always looks current.

export const ACCOUNTS: Account[] = [
  { id: "personal", name: "Personal", email: "you@gmail.com", provider: "gmail", color: "#f59e0b" },
  { id: "work", name: "Work", email: "you@company.co.za", provider: "outlook", color: "#38bdf8" },
];

const ME_PERSONAL: Contact = { name: "You", email: "you@gmail.com" };
const ME_WORK: Contact = { name: "You", email: "you@company.co.za" };

function ago(minutes: number) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function inDays(days: number) {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

const H = 60;
const D = 24 * H;

/** Next Tuesday at `hour` (local), for the demo invite. */
function nextTuesday(hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + (((2 - d.getDay() + 7) % 7) || 7));
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

/** Demo labels (Gmail-style, so their name is also their id; see lib/mail/search.ts). */
/**
 * The demo calendar: a plausible fortnight (this week and next) around the sample mail, so Today and
 * Calendar have something to show. Times are local, relative to this week's Monday.
 */
export function demoCalendar(): CalendarEvent[] {
  const monday = new Date();
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  monday.setHours(0, 0, 0, 0);
  const at = (day: number, hour: number, minute = 0) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + day);
    d.setHours(hour, minute, 0, 0);
    return d.toISOString();
  };
  const ymd = (day: number) => {
    const d = new Date(monday);
    d.setDate(d.getDate() + day);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const thandi = { name: "Thandi Nkosi", email: "thandi@company.co.za" };
  const events: CalendarEvent[] = [];
  for (const week of [0, 7]) {
    for (const day of [0, 1, 2, 3, 4]) {
      events.push({ id: `work:standup-${week + day}`, accountId: "work", summary: "Standup", start: at(week + day, 9), end: at(week + day, 9, 15), allDay: false, join: "https://teams.microsoft.com/l/meetup-join/demo", recurring: true });
    }
    for (const day of [0, 2, 4]) {
      events.push({ id: `personal:gym-${week + day}`, accountId: "personal", summary: "Gym", start: at(week + day, 17, 30), end: at(week + day, 18, 30), allDay: false, location: "Virgin Active Sandton", recurring: true });
    }
    events.push({ id: `work:one-on-one-${week}`, accountId: "work", summary: "1:1 with Lerato", start: at(week + 2, 14), end: at(week + 2, 14, 30), allDay: false, join: "https://teams.microsoft.com/l/meetup-join/demo-1on1", recurring: true });
  }
  events.push(
    { id: "work:lunch-sarah", accountId: "work", summary: "Lunch with Sarah Chen", start: at(0, 12, 30), end: at(0, 13, 30), allDay: false, location: "Tashas, Rosebank" },
    { id: "personal:dentist", accountId: "personal", summary: "Dentist", start: at(1, 7, 30), end: at(1, 8, 15), allDay: false, location: "Dr Naidoo, Parktown" },
    { id: "work:infra-review", accountId: "work", summary: "Infra spend review", start: at(1, 15), end: at(1, 16), allDay: false, organizer: thandi, you: "accepted" },
    { id: "work:q4-planning", accountId: "work", summary: "Q4 planning", start: at(3, 10), end: at(3, 11, 30), allDay: false, location: "Big boardroom", organizer: thandi, you: "accepted" },
    { id: "work:mokoena-call", accountId: "work", summary: "Contract call: Mokoena Legal", start: at(4, 11), end: at(4, 12), allDay: false, join: "https://teams.microsoft.com/l/meetup-join/demo-legal", you: "accepted" },
    { id: "personal:civvies", accountId: "personal", summary: "Civvies Day at St Mary's", start: ymd(4), end: ymd(5), allDay: true },
    { id: "personal:braai", accountId: "personal", summary: "Braai at Pieter's", start: at(5, 16), end: at(5, 20), allDay: false, location: "14 Jacaranda Ave, Linden" },
    { id: "work:roadmap", accountId: "work", summary: "Roadmap workshop", start: at(8, 13), end: at(8, 16), allDay: false, location: "Boardroom 2", organizer: thandi, you: "tentative" },
    { id: "personal:flight", accountId: "personal", summary: "Flight to Cape Town (FA 205)", start: at(10, 6, 10), end: at(10, 8, 20), allDay: false, location: "O.R. Tambo, Terminal B" },
    { id: "personal:cape-town", accountId: "personal", summary: "Cape Town", start: ymd(10), end: ymd(13), allDay: true },
  );
  return events;
}

export const DEMO_LABELS:Omit<MailLabel, "total" | "unread">[] = [
  { accountId: "personal", id: "Receipts", name: "Receipts", kind: "tag", color: "#16a766" },
  { accountId: "personal", id: "Travel", name: "Travel", kind: "tag", color: "#4a86e8" },
  { accountId: "personal", id: "Family", name: "Family", kind: "tag", color: null },
  { accountId: "work", id: "Clients", name: "Clients", kind: "tag", color: "#a479e2" },
  { accountId: "work", id: "Clients/Mokoena Legal", name: "Clients/Mokoena Legal", kind: "tag", color: "#a479e2" },
  { accountId: "work", id: "Projects/Kite", name: "Projects/Kite", kind: "tag", color: null },
];

const DEMO_THREAD_LABELS: Record<string, string[]> = {
  "t-pieter": ["Family"],
  "t-takealot": ["Receipts"],
  "t-flysafair": ["Travel", "Receipts"],
  "t-uber": ["Receipts", "Travel"],
  "t-archived": ["Receipts"],
  "t-lerato": ["Clients/Mokoena Legal"],
  "t-draft": ["Clients/Mokoena Legal"],
  "t-github": ["Projects/Kite"],
};

export function createDemoThreads(): Thread[] {
  return demoThreads().map((t) => (DEMO_THREAD_LABELS[t.id] ? { ...t, labels: DEMO_THREAD_LABELS[t.id] } : t));
}

function demoThreads(): Thread[] {
  return [
    {
      id: "t-thandi",
      accountId: "work",
      subject: "Q4 planning: can we move to Thursday?",
      mailbox: "inbox",
      category: "important",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: ME_WORK,
          to: [{ name: "Thandi Nkosi", email: "thandi@company.co.za" }],
          date: ago(26 * H),
          body: [
            "Hi Thandi,",
            "Sharing the draft agenda for Q4 planning. Main items are the roadmap review, hiring plan and the budget split for infra.",
            "Let me know if anything is missing.",
          ],
        },
        {
          id: "m2",
          from: { name: "Thandi Nkosi", email: "thandi@company.co.za" },
          to: [ME_WORK],
          date: ago(14),
          unread: true,
          body: [
            "Thanks, the agenda looks good.",
            "Something came up on Wednesday though. Can we move the session to Thursday 10:00? I can book the big boardroom.",
            "Also, could you bring the numbers for the infra spend? Finance wants to see the trend before we commit.",
            "Thandi",
          ],
        },
      ],
    },
    {
      id: "t-ria",
      accountId: "personal",
      subject: "Kersfees by ons?",
      mailbox: "inbox",
      category: "important",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Ria du Plessis", email: "ria.duplessis@gmail.com" },
          to: [ME_PERSONAL],
          date: ago(5 * H),
          unread: true,
          // In Afrikaans, so the demo shows Translate (components/mail/translate.tsx).
          body: [
            "Goeie môre!",
            "Ons beplan om Kersfees by die plaas te hou, van die 24ste tot die 27ste. Julle is almal welkom, en daar is genoeg plek vir almal om oor te bly.",
            "Kan jy my teen Vrydag laat weet hoeveel mense saamkom? Ek moet die vleis bestel en die beddens regkry.",
            "Baie liefde,",
            "Ria",
          ],
        },
      ],
    },
    {
      id: "t-pieter",
      accountId: "personal",
      subject: "Braai on Saturday?",
      mailbox: "inbox",
      category: "important",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Pieter van Wyk", email: "pieter.vw@gmail.com" },
          to: [ME_PERSONAL, { name: "Anja Botha", email: "anja.botha@gmail.com" }],
          date: ago(3 * H + 20),
          messageIdHeader: "<braai-1@gmail.com>",
          body: [
            "Hey!",
            "We're doing a braai at ours on Saturday from 4pm. Bring whoever you like, we'll sort the meat if you bring drinks.",
            "Let me know numbers by Thursday?",
          ],
        },
        {
          id: "m2",
          from: ME_PERSONAL,
          to: [{ name: "Pieter van Wyk", email: "pieter.vw@gmail.com" }, { name: "Anja Botha", email: "anja.botha@gmail.com" }],
          date: ago(3 * H),
          messageIdHeader: "<braai-2@gmail.com>",
          inReplyTo: "<braai-1@gmail.com>",
          body: [
            "Count me in, plus one. I'll bring a cooler box.",
            "On Tue, Pieter van Wyk <pieter.vw@gmail.com> wrote:\n> We're doing a braai at ours on Saturday from 4pm.\n> Let me know numbers by Thursday?",
          ],
        },
        {
          id: "m3",
          from: ME_PERSONAL,
          to: [{ name: "Pieter van Wyk", email: "pieter.vw@gmail.com" }, { name: "Anja Botha", email: "anja.botha@gmail.com" }],
          date: ago(2 * H + 56),
          messageIdHeader: "<braai-3@gmail.com>",
          inReplyTo: "<braai-2@gmail.com>",
          body: ["Should I bring a salad as well?"],
        },
        {
          id: "m4",
          from: { name: "Anja Botha", email: "anja.botha@gmail.com" },
          to: [{ name: "Pieter van Wyk", email: "pieter.vw@gmail.com" }, ME_PERSONAL],
          date: ago(70),
          messageIdHeader: "<braai-4@gmail.com>",
          inReplyTo: "<braai-1@gmail.com>",
          unread: true,
          attachments: [{ name: "directions.png", size: "240 KB", kind: "image" }],
          body: [
            "We're in! Is the gate code still 2580? Map attached in case anyone needs it.",
            "Sent from my iPhone",
            "On Tue, Pieter van Wyk <pieter.vw@gmail.com> wrote:\n> We're doing a braai at ours on Saturday from 4pm.",
          ],
        },
        {
          id: "m5",
          from: { name: "Pieter van Wyk", email: "pieter.vw@gmail.com" },
          to: [ME_PERSONAL, { name: "Anja Botha", email: "anja.botha@gmail.com" }],
          date: ago(52),
          messageIdHeader: "<braai-5@gmail.com>",
          inReplyTo: "<braai-3@gmail.com>",
          unread: true,
          body: [
            "Salad would be great, thanks. And yes Anja, same code.",
            "-- \nPieter van Wyk\n082 555 0101",
            "On Tue, You <you@gmail.com> wrote:\n> Should I bring a salad as well?",
          ],
        },
      ],
    },
    {
      id: "t-discovery",
      accountId: "personal",
      subject: "Transaction update",
      mailbox: "inbox",
      category: "notifications",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Discovery Bank", email: "notifications@discovery.co.za" },
          to: [ME_PERSONAL],
          date: ago(95),
          trackersBlocked: ["Salesforce Marketing Cloud"],
          body: [
            "Card payment Woolworths Food Cape Quarter: R842.50",
            "From ****7713, card ending ****4821",
            "Available balance: R18 204.11",
          ],
        },
      ],
    },
    {
      id: "t-netflix",
      accountId: "personal",
      subject: "Your membership renews on Tuesday",
      mailbox: "inbox",
      category: "notifications",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Netflix", email: "info@account.netflix.com" },
          to: [ME_PERSONAL],
          date: ago(3 * H),
          trackersBlocked: ["Netflix pixel", "Braze"],
          remoteImages: true,
          body: [
            "Hi there,",
            "Just a reminder that your Standard plan renews on Tuesday for R199.",
            "No action is needed. To change your plan, visit your account settings.",
          ],
        },
      ],
    },
    {
      id: "t-takealot",
      accountId: "personal",
      subject: "Your order is on its way",
      mailbox: "inbox",
      category: "notifications",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Takealot", email: "orders@takealot.com" },
          to: [ME_PERSONAL],
          date: ago(5 * H),
          trackersBlocked: ["Google Analytics"],
          remoteImages: true,
          attachments: [{ name: "Invoice-TA-48213907.pdf", size: "84 KB", kind: "pdf" }],
          body: [
            "Good news! Order TA-48213907 has left our warehouse.",
            "Logitech MX Keys S × 1: R2 199",
            "Expected delivery: tomorrow between 08:00 and 17:00.",
          ],
        },
      ],
    },
    {
      id: "t-lerato",
      accountId: "work",
      subject: "Contract draft v3",
      mailbox: "inbox",
      category: "important",
      unread: true,
      starred: true,
      messages: [
        {
          id: "m1",
          from: { name: "Lerato Mokoena", email: "lerato@mokoena-legal.co.za" },
          to: [ME_WORK],
          date: ago(3 * D),
          messageIdHeader: "<contract-1@mokoena-legal.co.za>",
          attachments: [{ name: "Services-Agreement-v2.docx", size: "204 KB", kind: "doc" }],
          body: [
            "Hi,",
            "Here is v2 of the services agreement with the changes from our call. Please mark up anything you'd like changed.",
            "Kind regards,\nLerato",
          ],
        },
        {
          id: "m2",
          from: ME_WORK,
          to: [{ name: "Lerato Mokoena", email: "lerato@mokoena-legal.co.za" }],
          date: ago(2 * D),
          messageIdHeader: "<contract-2@company.co.za>",
          inReplyTo: "<contract-1@mokoena-legal.co.za>",
          attachments: [{ name: "Services-Agreement-v2 (1).docx", size: "209 KB", kind: "doc" }],
          body: [
            "Thanks Lerato. My comments are in the attached copy, mostly on clauses 9 and 14.",
            "From: Lerato Mokoena <lerato@mokoena-legal.co.za>\nSent: Monday, 6 October 2026 09:12\nTo: You <you@company.co.za>\nSubject: Contract draft v3",
            "Here is v2 of the services agreement with the changes from our call.",
          ],
        },
        {
          id: "m3",
          from: { name: "Lerato Mokoena", email: "lerato@mokoena-legal.co.za" },
          to: [ME_WORK],
          date: ago(7 * H),
          messageIdHeader: "<contract-3@mokoena-legal.co.za>",
          inReplyTo: "<contract-2@company.co.za>",
          unread: true,
          attachments: [{ name: "Services-Agreement-v3.docx", size: "212 KB", kind: "doc" }],
          body: [
            "Morning,",
            "Attached is v3 of the services agreement. I've accepted most of your comments. The open items are the liability cap (clause 9.2) and the notice period.",
            "If you're happy, I'll send it for signature this week.",
            "Kind regards,",
            "Lerato",
            "On Wed, You <you@company.co.za> wrote:\n> Thanks Lerato. My comments are in the attached copy, mostly on clauses 9 and 14.",
          ],
        },
      ],
    },
    {
      // Sent days ago with no answer: Today's "Waiting on" (lib/replies.ts).
      id: "t-garden-wall",
      accountId: "personal",
      subject: "Quote for the garden wall",
      mailbox: "sent",
      category: "important",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: ME_PERSONAL,
          to: [{ name: "Johan Smit", email: "johan@smitbuilders.co.za" }],
          date: ago(4 * D),
          messageIdHeader: "<garden-wall-1@gmail.com>",
          body: [
            "Hi Johan,",
            "Thanks for coming round on Saturday. Could you send the quote for the garden wall when you get a chance? We'd like to start before December.",
            "Thanks",
          ],
        },
      ],
    },
    {
      id: "t-flysafair",
      accountId: "personal",
      subject: "Booking confirmed: CPT → JNB",
      mailbox: "inbox",
      category: "notifications",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "FlySafair", email: "bookings@flysafair.co.za" },
          to: [ME_PERSONAL],
          date: ago(1 * D + 2 * H),
          attachments: [{ name: "Itinerary-QX7P2M.pdf", size: "120 KB", kind: "pdf" }],
          trackersBlocked: ["Mailchimp"],
          body: [
            "Your booking is confirmed.",
            "FA 212 Cape Town (CPT) → Johannesburg (JNB), departing 24 October at 06:10.",
            "Booking reference QX7P2M. Online check-in opens 24 hours before departure.",
          ],
        },
      ],
    },
    {
      id: "t-github",
      accountId: "work",
      subject: "[kite] Add IMAP IDLE sync (#12)",
      mailbox: "inbox",
      category: "notifications",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "GitHub", email: "notifications@github.com" },
          to: [ME_WORK],
          date: ago(9 * H),
          body: [
            "@sipho-d requested your review on this pull request.",
            "Adds a long-lived IMAP connection per account using IDLE, with reconnect and backoff.",
            "3 files changed, 214 additions, 18 deletions.",
          ],
        },
      ],
    },
    {
      id: "t-daily-byte",
      accountId: "personal",
      subject: "The Daily Byte: chips, clouds and a quiet Friday",
      mailbox: "inbox",
      category: "newsletters",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "The Daily Byte", email: "hello@dailybyte.news" },
          to: [ME_PERSONAL],
          date: ago(11 * H),
          remoteImages: true,
          trackersBlocked: ["Substack open pixel", "Bitly", "Google Analytics"],
          body: [
            "Good morning.",
            "Today: a new generation of laptop chips, what the latest cloud outage teaches about redundancy, and five tools worth trying this weekend.",
            "Read time: 6 minutes.",
          ],
        },
      ],
    },
    {
      id: "t-design-notes",
      accountId: "personal",
      subject: "Design Notes #88: the case for dense interfaces",
      mailbox: "inbox",
      category: "newsletters",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Design Notes", email: "letters@designnotes.io" },
          to: [ME_PERSONAL],
          date: ago(2 * D),
          remoteImages: true,
          trackersBlocked: ["ConvertKit"],
          body: [
            "This week: why power users prefer dense layouts, and how to make density feel calm instead of cluttered.",
          ],
        },
      ],
    },
    {
      id: "t-calendar",
      accountId: "work",
      subject: "Invitation: Design review, Tue 10:00–11:00",
      mailbox: "inbox",
      category: "other",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Sipho Dlamini", email: "sipho@company.co.za" },
          to: [ME_WORK],
          date: ago(4 * H),
          body: [
            "Sipho Dlamini has invited you to Design review.",
            "Tuesday 10:00–11:00 (SAST), Boardroom 2 / Google Meet.",
            "Agenda: inbox layout, keyboard shortcuts, onboarding.",
          ],
          calendar: true,
          invite: {
            uid: "demo-design-review@company.co.za",
            method: "REQUEST",
            sequence: 0,
            summary: "Design review",
            start: nextTuesday(10),
            end: nextTuesday(11),
            allDay: false,
            recurrence: "Weekly on Tuesday",
            location: "Boardroom 2",
            join: "https://meet.google.com/abc-defg-hij",
            organizer: { name: "Sipho Dlamini", email: "sipho@company.co.za" },
            attendees: [
              { name: "Sipho Dlamini", email: "sipho@company.co.za", status: "accepted" },
              { name: "Lerato Mokoena", email: "lerato@company.co.za", status: "accepted" },
              { name: "Daniel Botha", email: "daniel@company.co.za", status: "needs-action" },
              { name: "You", email: "you@company.co.za", status: "needs-action" },
            ],
            you: "needs-action",
          },
        },
      ],
    },
    {
      id: "t-uber",
      accountId: "personal",
      subject: "Your Thursday evening trip with Uber",
      mailbox: "inbox",
      category: "other",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Uber Receipts", email: "noreply@uber.com" },
          to: [ME_PERSONAL],
          date: ago(2 * D + 5 * H),
          remoteImages: true,
          trackersBlocked: ["Uber pixel"],
          body: ["Thanks for riding, here's your receipt.", "Total: R128.40 · Sea Point → Woodstock · 18 min"],
        },
      ],
    },
    {
      id: "t-vodacom",
      accountId: "personal",
      subject: "Your October bill is ready",
      mailbox: "inbox",
      category: "other",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Vodacom", email: "billing@vodacom.co.za" },
          to: [ME_PERSONAL],
          date: ago(3 * D),
          attachments: [{ name: "Statement-Oct.pdf", size: "310 KB", kind: "pdf" }],
          body: ["Your October statement is attached.", "Amount due: R649.00 by 25 October."],
        },
      ],
    },
    {
      id: "t-spotify",
      accountId: "personal",
      subject: "An update to your Premium price",
      mailbox: "inbox",
      category: "notifications",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Spotify", email: "no-reply@spotify.com" },
          to: [ME_PERSONAL],
          date: ago(4 * D),
          remoteImages: true,
          trackersBlocked: ["Spotify pixel"],
          body: [
            "We're updating the price of Premium Individual from R69.99 to R79.99 per month.",
            "The new price applies from your next billing date. You can cancel anytime.",
          ],
        },
      ],
    },
    {
      id: "t-school",
      accountId: "personal",
      subject: "Term 4 newsletter and Civvies Day",
      mailbox: "inbox",
      category: "other",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "St Mary's Primary", email: "office@stmarys.edu.za" },
          to: [ME_PERSONAL],
          date: ago(6 * H),
          attachments: [{ name: "Term4-Newsletter.pdf", size: "1.2 MB", kind: "pdf" }],
          body: [
            "Dear parents,",
            "Welcome to Term 4. Friday is Civvies Day: learners may wear casual clothes for a R20 donation to the library fund.",
            "Exam timetables will be sent home next week.",
          ],
        },
      ],
    },
    {
      id: "t-sarah",
      accountId: "work",
      subject: "Intro: platform engineering role",
      mailbox: "inbox",
      category: "important",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Sarah Chen", email: "sarah@talentbridge.io" },
          to: [ME_WORK],
          date: ago(3 * H),
          body: ["Hi, I came across your profile and wanted to share a platform engineering role that could be a great fit."],
        },
      ],
    },
    {
      id: "t-growth",
      accountId: "work",
      subject: "10x your pipeline in 30 days",
      mailbox: "inbox",
      category: "other",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Growth Partners", email: "outreach@growthpartners.agency" },
          to: [ME_WORK],
          date: ago(8 * H),
          trackersBlocked: ["HubSpot", "Lemlist"],
          body: ["Quick question: are you the right person to talk to about lead generation?"],
        },
      ],
    },
    {
      id: "t-jordan",
      accountId: "personal",
      subject: "Quick question about your talk",
      mailbox: "inbox",
      category: "important",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Jordan Blake", email: "jordan.blake@fastmail.com" },
          to: [ME_PERSONAL],
          date: ago(1 * D),
          body: ["Loved your talk at the meetup. Would you be open to sharing the slides?"],
        },
      ],
    },
    {
      id: "t-licence",
      accountId: "personal",
      subject: "Reminder: vehicle licence disc expires this month",
      mailbox: "snoozed",
      category: "other",
      unread: false,
      starred: false,
      snoozedUntil: inDays(1),
      messages: [
        {
          id: "m1",
          from: { name: "City of Cape Town", email: "noreply@capetown.gov.za" },
          to: [ME_PERSONAL],
          date: ago(5 * D),
          body: ["Your vehicle licence disc expires at the end of this month. Renew online or at any licensing office."],
        },
      ],
    },
    {
      id: "t-sent-agenda",
      accountId: "work",
      subject: "Re: Office move logistics",
      mailbox: "sent",
      category: "important",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: ME_WORK,
          to: [{ name: "Facilities", email: "facilities@company.co.za" }],
          date: ago(2 * D),
          body: ["Thanks, Monday works for the movers. We'll have everything packed by Friday afternoon."],
        },
      ],
    },
    {
      id: "t-draft",
      accountId: "work",
      subject: "Re: Contract draft v3",
      mailbox: "drafts",
      category: "important",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: ME_WORK,
          to: [{ name: "Lerato Mokoena", email: "lerato@mokoena-legal.co.za" }],
          date: ago(6 * H),
          body: ["Hi Lerato, on 9.2 I'd propose capping liability at 12 months of fees…"],
        },
      ],
    },
    {
      id: "t-archived",
      accountId: "personal",
      subject: "Your parking receipt",
      mailbox: "archive",
      category: "other",
      unread: false,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "V&A Waterfront Parking", email: "receipts@waterfront.co.za" },
          to: [ME_PERSONAL],
          date: ago(9 * D),
          body: ["Parking: 2h 14m · R45.00"],
        },
      ],
    },
    // Gmail grouped two unrelated invoices by subject: split the newest one off.
    {
      id: "t-invoice",
      accountId: "personal",
      subject: "Invoice",
      mailbox: "inbox",
      category: "important",
      unread: true,
      starred: false,
      messages: [
        {
          id: "m1",
          from: { name: "Sipho Dlamini Plumbing", email: "accounts@siphoplumbing.co.za" },
          to: [ME_PERSONAL],
          date: ago(9 * D),
          messageIdHeader: "<inv-2231@siphoplumbing.co.za>",
          body: ["Hi, please find the invoice for the geyser repair on the 3rd.", "Total due: R2,850.00. Banking details are on the invoice.", "Sipho"],
          attachments: [{ name: "INV-2231.pdf", size: "84 KB", kind: "pdf" }],
        },
        {
          id: "m2",
          from: ME_PERSONAL,
          to: [{ name: "Sipho Dlamini Plumbing", email: "accounts@siphoplumbing.co.za" }],
          date: ago(8 * D),
          inReplyTo: "<inv-2231@siphoplumbing.co.za>",
          body: ["Paid this morning, thanks Sipho. Geyser is working perfectly."],
        },
        {
          id: "m3",
          from: { name: "Naledi Studio", email: "hello@naledistudio.co.za" },
          to: [ME_PERSONAL],
          date: ago(2 * H),
          unread: true,
          messageIdHeader: "<logo-final@naledistudio.co.za>",
          body: [
            "Hi! Attached is the invoice for the logo refresh (final files are in the shared folder).",
            "Payment within 14 days please. Let me know if you'd like the extra social media sizes as well.",
            "Naledi",
          ],
          attachments: [{ name: "Naledi-Studio-0042.pdf", size: "61 KB", kind: "pdf" }],
        },
      ],
    },
  ];
}
