// A local IMAP + SMTP server for building and testing Kite's IMAP provider without a real mailbox:
// `node scripts/imap-test-server.mjs` (Hoodiecrow, in memory: every start is a fresh mailbox).
// Connect in Kite with the address below and the printed password, server 127.0.0.1 port 1143
// (no TLS) and SMTP port 1025. Mail sent through it lands in its own Inbox. `--gmail` plays Gmail. Dev only.
// The tests (test/imap/) import `startTestServer` and run one on free ports per test file.

import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const hoodiecrow = require("hoodiecrow-imap");
const { startSMTPServer } = require("hoodiecrow-imap/lib/hoodiecrowSMTPServer.js");

export const USER = "kite@example.test";

const day = (n) => new Date(Date.now() - n * 86_400_000);
const rfcDate = (d) => d.toUTCString().replace("GMT", "+0000");

/** One RFC 822 message as Hoodiecrow storage. `html` alone (no `body`) makes an HTML-only message. */
function message({ from, to = USER, subject, body, id, inReplyTo, references, date, flags = [], headers = [], html, files = [] }) {
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${rfcDate(date)}`,
    `Message-ID: <${id}@example.test>`,
    inReplyTo ? `In-Reply-To: <${inReplyTo}@example.test>` : null,
    references ? `References: ${references.map((r) => `<${r}@example.test>`).join(" ")}` : null,
    "MIME-Version: 1.0",
    ...headers,
  ].filter(Boolean);
  let raw;
  if (body === undefined && html && !files.length) {
    raw = [...head, "Content-Type: text/html; charset=utf-8", "", html].join("\r\n");
  } else if (!html && !files.length) {
    raw = [...head, "Content-Type: text/plain; charset=utf-8", "", body].join("\r\n");
  } else {
    const alt = "alt-" + id;
    const mixed = "mixed-" + id;
    const alternative = [
      `--${alt}`,
      "Content-Type: text/plain; charset=utf-8",
      "",
      body,
      `--${alt}`,
      "Content-Type: text/html; charset=utf-8",
      "",
      html ?? `<p>${body}</p>`,
      `--${alt}--`,
    ];
    raw = [
      ...head,
      `Content-Type: multipart/mixed; boundary="${mixed}"`,
      "",
      `--${mixed}`,
      `Content-Type: multipart/alternative; boundary="${alt}"`,
      "",
      ...alternative,
      ...files.flatMap((f) =>
        [
          `--${mixed}`,
          `Content-Type: ${f.type}; name="${f.name}"`,
          "Content-Transfer-Encoding: base64",
          f.cid ? `Content-ID: <${f.cid}>` : null,
          `Content-Disposition: ${f.cid ? "inline" : "attachment"}; filename="${f.name}"`,
          "",
          Buffer.from(f.data).toString("base64"),
        ].filter((l) => l !== null),
      ),
      `--${mixed}--`,
    ].join("\r\n");
  }
  return { raw, flags, internaldate: date };
}

const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

// ---- Fixtures shared by both modes ----

/** Midnight UTC today plus `days` and `hours`, as an iCalendar UTC time. */
const icsTime = (days, hours) => {
  const base = new Date();
  const at = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()) + days * 86_400_000 + hours * 3_600_000);
  return at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
};

const ORGANISER = { name: "Nomsa Dlamini", email: "nomsa@company.co.za" };

/** An iCalendar file: one VEVENT, from the organiser to Kite's address with `partstat`. */
function ics({ method, uid, seq = 0, summary, start, end, rrule, exdate, partstat = "NEEDS-ACTION", status }) {
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//Kite tests//EN",
    "VERSION:2.0",
    `METHOD:${method}`,
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `SEQUENCE:${seq}`,
    `DTSTAMP:${icsTime(0, 0)}`,
    `DTSTART:${start}`,
    `DTEND:${end}`,
    rrule ? `RRULE:${rrule}` : null,
    exdate ? `EXDATE:${exdate}` : null,
    status ? `STATUS:${status}` : null,
    `SUMMARY:${summary}`,
    `ORGANIZER;CN=${ORGANISER.name}:mailto:${ORGANISER.email}`,
    `ATTENDEE;CN=Kite Test;PARTSTAT=${partstat}:mailto:${USER}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ]
    .filter((l) => l !== null)
    .join("\r\n");
}

const invite = (id, subject, date, file, extra = {}) =>
  message({
    from: `${ORGANISER.name} <${ORGANISER.email}>`,
    subject,
    body: `${subject}. Details in the invite.`,
    id,
    date,
    files: [{ name: "invite.ics", type: `text/calendar; method=${/METHOD:(\w+)/.exec(file)[1]}; charset=utf-8`, data: file }],
    ...extra,
  });

const answer = (id, subject, parent, date, file) =>
  message({
    from: `Kite Test <${USER}>`,
    to: `${ORGANISER.name} <${ORGANISER.email}>`,
    subject,
    body: subject,
    id,
    inReplyTo: parent,
    references: [parent],
    date,
    flags: ["\\Seen"],
    files: [{ name: "reply.ics", type: "text/calendar; method=REPLY; charset=utf-8", data: file }],
  });

/** Mail calendar fixtures: each invite, its updates and your answers, as [where, thread, message]. */
function calendarMail() {
  const standupStart = icsTime(1, 9);
  const review = (seq, days, hours) => ics({ method: "REQUEST", uid: "review-1", seq, summary: "Design review", start: icsTime(days, hours), end: icsTime(days, hours + 1) });
  const reply = (uid, summary, start, partstat) =>
    ics({ method: "REPLY", uid, summary, start, end: start, partstat });
  return [
    // A weekly series of four with its second week left out (EXDATE), not answered yet.
    ["inbox", "7001", invite("standup-1", "Weekly stand-up", day(4), ics({ method: "REQUEST", uid: "standup-1", summary: "Weekly stand-up", start: standupStart, end: icsTime(1, 9.5), rrule: "FREQ=WEEKLY;COUNT=4", exdate: icsTime(8, 9) }))],
    // Updated twice; the last email is a stale SEQUENCE 1 resent after SEQUENCE 2. Answered Yes from another app.
    ["inbox", "7002", invite("review-1", "Design review", day(3), review(0, 2, 10))],
    ["inbox", "7002", invite("review-2", "Updated: Design review", day(1), review(2, 3, 14), { inReplyTo: "review-1", references: ["review-1"] })],
    ["inbox", "7002", invite("review-3", "Updated: Design review", day(0.3), review(1, 4, 16), { inReplyTo: "review-2", references: ["review-1", "review-2"] })],
    ["sent", "7002", answer("review-yes", "Accepted: Design review", "review-2", day(0.2), reply("review-1", "Design review", icsTime(3, 14), "ACCEPTED"))],
    // Answered Maybe.
    ["inbox", "7003", invite("budget-1", "Budget sync", day(2), ics({ method: "REQUEST", uid: "budget-1", summary: "Budget sync", start: icsTime(5, 11), end: icsTime(5, 12) }))],
    ["sent", "7003", answer("budget-maybe", "Tentative: Budget sync", "budget-1", day(1.5), reply("budget-1", "Budget sync", icsTime(5, 11), "TENTATIVE"))],
    // Answered No.
    ["inbox", "7004", invite("offsite-1", "Team offsite", day(2), ics({ method: "REQUEST", uid: "offsite-1", summary: "Team offsite", start: icsTime(6, 8), end: icsTime(6, 16) }))],
    ["sent", "7004", answer("offsite-no", "Declined: Team offsite", "offsite-1", day(1.8), reply("offsite-1", "Team offsite", icsTime(6, 8), "DECLINED"))],
    // Cancelled by the organiser.
    ["inbox", "7005", invite("lunch-1", "Team lunch", day(2), ics({ method: "REQUEST", uid: "lunch-1", summary: "Team lunch", start: icsTime(4, 12), end: icsTime(4, 13) }))],
    ["inbox", "7005", invite("lunch-2", "Cancelled: Team lunch", day(1), ics({ method: "CANCEL", uid: "lunch-1", seq: 1, summary: "Team lunch", start: icsTime(4, 12), end: icsTime(4, 13), status: "CANCELLED" }), { inReplyTo: "lunch-1", references: ["lunch-1"] })],
  ];
}

/** HTML mail whose <head> styles run past the 2 KB snippet read, the cut landing inside an Outlook comment. */
function longStyles() {
  const rules = Array.from({ length: 40 }, (_, i) => `.row${i} td { font-family: Arial, sans-serif; padding: 4px 8px; color: #333333; }`).join("\n");
  const mso = Array.from({ length: 20 }, (_, i) => `.mso${i} { mso-line-height-rule: exactly; line-height: 120%; }`).join("\n");
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Statement</title><style>\n${rules}\n</style><!--[if mso]><style>\n${mso}\n</style><![endif]--></head><body><table><tr><td><p>Your September statement is ready. Closing balance R 12 480.00.</p></td></tr></table></body></html>`;
}

const STATEMENT = {
  from: "Discovery Bank <statements@discovery.example>",
  subject: "Your September statement",
  html: longStyles(),
  id: "statement-9",
  date: day(0.6),
};

export const LABELS = { align: "Align – Discovery Bank Ltd", clients: "Work/Clients", dues: "Échéances" };

/** A name as Hoodiecrow stores mailboxes and labels: modified UTF-7 (RFC 3501 section 5.1.3). */
const mutf7 = (name) =>
  name.replace(/&/g, "&-").replace(/[^\x20-\x7e]+/g, (run) => `&${Buffer.from(run, "utf16le").swap16().toString("base64").replace(/=+$/, "").replace(/\//g, ",")}-`);
const ALIGN = mutf7(LABELS.align);
const DUES = mutf7(LABELS.dues);

/** Plain IMAP: folders are labels, keywords are tags. */
function plainStorage() {
  const cal = calendarMail();
  return {
    INBOX: {
      messages: [
        message({ from: "Thandi Nkosi <thandi@company.co.za>", subject: "Quarterly numbers", body: "Hi, the Q3 numbers are attached. Can you check page 2?", id: "q3-1", date: day(3), flags: ["\\Seen"], files: [{ name: "q3.pdf", type: "application/pdf", data: "%PDF-1.4 test" }] }),
        message({ from: "Thandi Nkosi <thandi@company.co.za>", subject: "Re: Quarterly numbers", body: "Also, page 4 has the forecast.", id: "q3-3", inReplyTo: "q3-2", references: ["q3-1", "q3-2"], date: day(1) }),
        message({
          from: "Weekly Digest <news@digest.example>",
          subject: "Your weekly digest",
          body: "Ten things worth reading this week.",
          html: '<h1>Weekly digest</h1><p>Ten things worth reading.</p><img src="cid:logo@digest"><img src="https://tracker.example/open.gif" width="1" height="1">',
          id: "digest-1",
          date: day(0.5),
          headers: ["List-Unsubscribe: <https://digest.example/unsub?u=1>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"],
          files: [{ name: "logo.gif", type: "image/gif", data: PIXEL, cid: "logo@digest" }],
        }),
        message({ from: "Sipho Plumbing <accounts@siphoplumbing.co.za>", subject: "Invoice INV-2041", body: "Your invoice for R 1 450.00 is due on Friday.", id: "inv-2041", date: day(0.2), flags: ["$Invoices"] }),
        message({ from: "Lerato <lerato@mokoena-legal.co.za>", subject: "Contract draft", body: "Here's the draft we discussed.", id: "contract-1", date: day(0.1), flags: ["\\Flagged"] }),
        ...cal.filter(([where]) => where === "inbox").map(([, , m]) => m),
      ],
    },
    "": {
      separator: "/",
      folders: {
        Sent: {
          "special-use": "\\Sent",
          messages: [
            message({ from: `Kite Test <${USER}>`, to: "Thandi Nkosi <thandi@company.co.za>", subject: "Re: Quarterly numbers", body: "Thanks, looking now.", id: "q3-2", inReplyTo: "q3-1", references: ["q3-1"], date: day(2), flags: ["\\Seen"] }),
            ...cal.filter(([where]) => where === "sent").map(([, , m]) => m),
          ],
        },
        Drafts: {
          "special-use": "\\Drafts",
          // A draft another app saved twice without deleting the first version: one Message-ID, two copies.
          messages: [
            message({ from: `Kite Test <${USER}>`, to: "Thandi Nkosi <thandi@company.co.za>", subject: "Lunch on Friday?", body: "First version.", id: "twice-1", date: day(0.5), flags: ["\\Seen", "\\Draft"] }),
            message({ from: `Kite Test <${USER}>`, to: "Thandi Nkosi <thandi@company.co.za>", subject: "Lunch on Friday?", body: "Second version.", id: "twice-1", date: day(0.4), flags: ["\\Seen", "\\Draft"] }),
          ],
        },
        Trash: { "special-use": "\\Trash", messages: [] },
        Junk: { "special-use": "\\Junk", messages: [message({ from: "Prize Team <win@prizes.example>", subject: "You won!", body: "Claim now.", id: "spam-1", date: day(2) })] },
        Archive: {
          "special-use": "\\Archive",
          messages: [message({ from: "Old Friend <friend@example.org>", subject: "Long time", body: "How have you been?", id: "old-1", date: day(40), flags: ["\\Seen"] })],
        },
        Receipts: { messages: [message({ from: "Shop <orders@shop.example>", subject: "Order 7781 shipped", body: "Your order is on the way.", id: "order-7781", date: day(5), flags: ["\\Seen"] })] },
        [ALIGN]: { messages: [message({ ...STATEMENT, flags: ["\\Seen"] })] },
        [DUES]: { messages: [message({ from: "City Rates <rates@city.example>", subject: "Rates account due", body: "Your rates account is due on the 7th.", id: "rates-10", date: day(8), flags: ["\\Seen"] })] },
        Work: {
          folders: {
            Clients: { messages: [message({ from: "Lerato <lerato@mokoena-legal.co.za>", subject: "Retainer renewal", body: "The retainer renews next month.", id: "retainer-1", date: day(6), flags: ["\\Seen"] })] },
          },
        },
      },
    },
  };
}

/**
 * Gmail (X-GM-EXT-1): every message once in [Gmail]/All Mail with its labels and thread id, Trash
 * and Spam apart, the user's labels as empty folders. Hoodiecrow doesn't mirror labels into folders
 * like Gmail does, which Kite's Gmail mode never reads anyway. Hoodiecrow has no `category:`: the
 * fixtures carry the Inbox tab as a system label (\CategoryPromotions), which Kite drops like Gmail's
 * others, and category:x finds it. \CategoryPrimary marks mail Gmail shows in Primary although it's
 * sorted into a tab the user turned off.
 */
function gmailStorage() {
  const gm = (labels, thread, opts) => ({ ...message(opts), "X-GM-LABELS": labels, ...(thread ? { "X-GM-THRID": thread } : {}) });
  const me = `Kite Test <${USER}>`;
  const draft = (body, date) => gm(["\\Draft", "\\Drafts"], null, { from: me, to: "Thandi Nkosi <thandi@company.co.za>", subject: "Lunch on Friday?", body, id: "twice-1", date, flags: ["\\Seen", "\\Draft"] });
  const allMail = [
    gm(["\\Inbox", "\\Important"], "9001", { from: "Thandi Nkosi <thandi@company.co.za>", subject: "Quarterly numbers", body: "Hi, the Q3 numbers are attached. Can you check page 2?", id: "q3-1", date: day(3), flags: ["\\Seen"], files: [{ name: "q3.pdf", type: "application/pdf", data: "%PDF-1.4 test" }] }),
    gm(["\\Sent"], "9001", { from: me, to: "Thandi Nkosi <thandi@company.co.za>", subject: "Re: Quarterly numbers", body: "Thanks, looking now.", id: "q3-2", inReplyTo: "q3-1", references: ["q3-1"], date: day(2), flags: ["\\Seen"] }),
    gm(["\\Inbox", "\\Important"], "9001", { from: "Thandi Nkosi <thandi@company.co.za>", subject: "Re: Quarterly numbers", body: "Also, page 4 has the forecast.", id: "q3-3", inReplyTo: "q3-2", references: ["q3-1", "q3-2"], date: day(1) }),
    gm(["\\Inbox", "\\CategoryPromotions"], null, { from: "Weekly Digest <news@digest.example>", subject: "Your weekly digest", body: "Ten things worth reading this week.", id: "digest-1", date: day(0.5), headers: ["List-Unsubscribe: <https://digest.example/unsub?u=1>", "List-Unsubscribe-Post: List-Unsubscribe=One-Click"] }),
    gm(["\\Inbox", "\\CategoryUpdates", "Receipts", DUES], null, { from: "Sipho Plumbing <accounts@siphoplumbing.co.za>", subject: "Invoice INV-2041", body: "Your invoice for R 1 450.00 is due on Friday.", id: "inv-2041", date: day(0.2) }),
    gm(["\\Inbox", "\\Starred", LABELS.clients], null, { from: "Lerato <lerato@mokoena-legal.co.za>", subject: "Contract draft", body: "Here's the draft we discussed.", id: "contract-1", date: day(0.1), flags: ["\\Flagged"] }),
    gm(["\\Inbox", "\\CategorySocial", "\\CategoryPrimary"], null, { from: "Circle <notify@circle.example>", subject: "Sipho tagged you in a photo", body: "See the photo from Saturday.", id: "social-1", date: day(0.7) }),
    gm(["\\Inbox", "\\CategoryUpdates", ALIGN], null, STATEMENT),
    gm([], null, { from: "Old Friend <friend@example.org>", subject: "Long time", body: "How have you been?", id: "old-1", date: day(40), flags: ["\\Seen"] }),
    // A draft saved twice in another app before the old version was removed: one Message-ID, two copies.
    draft("First version.", day(0.5)),
    draft("Second version.", day(0.4)),
    gm(["Receipts"], null, { from: "Shop <orders@shop.example>", subject: "Order 7781 shipped", body: "Your order is on the way.", id: "order-7781", date: day(5), flags: ["\\Seen"] }),
    ...calendarMail().map(([where, thread, m]) => ({ ...m, "X-GM-LABELS": where === "inbox" ? ["\\Inbox"] : ["\\Sent"], "X-GM-THRID": thread })),
  ];
  return {
    INBOX: { messages: [] },
    "": {
      separator: "/",
      folders: {
        "[Gmail]": {
          flags: ["\\Noselect"],
          folders: {
            "All Mail": { "special-use": "\\All", messages: allMail },
            "Sent Mail": { "special-use": "\\Sent", messages: [] },
            Drafts: { "special-use": "\\Drafts", messages: [] },
            Trash: { "special-use": "\\Trash", messages: [] },
            Spam: { "special-use": "\\Junk", messages: [gm([], null, { from: "Prize Team <win@prizes.example>", subject: "You won!", body: "Claim now.", id: "spam-1", date: day(2) })] },
            Starred: { "special-use": "\\Flagged", messages: [] },
            Important: { "special-use": "\\Important", messages: [] },
          },
        },
        Receipts: { messages: [] },
        [ALIGN]: { messages: [] },
        [DUES]: { messages: [] },
        Work: { folders: { Clients: { messages: [] } } },
      },
    },
  };
}

/** `cleanup`: newsletter senders for Cleanup: volume, unread, archived unread, mailto / web unsubscribe. */
function addCleanup(storage) {
  const lists = [
    { from: "Deals Daily <deals@dealsdaily.example>", n: 14, every: 3, seen: false, folder: "INBOX", unsub: ["List-Unsubscribe: <mailto:unsubscribe@dealsdaily.example?subject=unsubscribe>"] },
    { from: "Tech Weekly <hello@techweekly.example>", n: 8, every: 7, seen: true, folder: "INBOX", unsub: ["List-Unsubscribe: <mailto:leave@techweekly.example>"] },
    { from: "Promo Blast <promo@promoblast.example>", n: 9, every: 4, seen: false, folder: "Archive", unsub: ["List-Unsubscribe: <https://promoblast.example/unsubscribe?u=7>"] },
    { from: "Still Spammy <news@stillspammy.example>", n: 6, every: 2, seen: false, folder: "INBOX", unsub: ["List-Unsubscribe: <mailto:stop@stillspammy.example>"] },
  ];
  for (const list of lists) {
    const slug = list.from.split("@")[1].split(".")[0];
    const folder = list.folder === "INBOX" ? storage.INBOX : storage[""].folders[list.folder];
    for (let i = 0; i < list.n; i++) {
      folder.messages.push(
        message({
          from: list.from,
          subject: `${list.from.split(" <")[0]} #${list.n - i}`,
          body: "This week's offers and news.",
          id: `${slug}-${i}`,
          date: day(i * list.every + 0.3),
          flags: list.seen || i % 4 === 3 ? ["\\Seen"] : [],
          headers: list.unsub,
        }),
      );
    }
  }
}

/**
 * Starts the servers. Ports 0 pick free ones. `uidplus: false` plays a server that doesn't say where
 * moved messages went (no COPYUID). Resolves once both listen.
 */
export async function startTestServer({ gmail = false, cleanup = false, uidplus = true, imapPort = 0, smtpPort = 0, password = randomBytes(9).toString("base64url"), quiet = false } = {}) {
  const storage = gmail ? gmailStorage() : plainStorage();
  if (cleanup && !gmail) addCleanup(storage);
  const plugins = ["ID", "IDLE", "ENABLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE", "LIST-EXTENDED", "LIST-STATUS", "NAMESPACE", "UNSELECT", "LITERALPLUS", "ESEARCH", "CREATE-SPECIAL-USE", ...(gmail ? ["X-GM-EXT-1", "OBJECTID"] : [])];
  const server = hoodiecrow({
    plugins: uidplus ? plugins : plugins.filter((p) => p !== "UIDPLUS"),
    users: { [USER]: { password } },
    storage,
  });

  // Gmail files mail it sends in All Mail; the test SMTP server delivers there instead of INBOX.
  // A draft appended to Drafts lives in All Mail too, labelled \Draft (hoodiecrow's in:drafts looks
  // for \Drafts, so it gets both).
  if (gmail) {
    const raw = server.searchHandlers["X-GM-RAW"];
    const [parse] = raw.argumentTypes();
    const tab = (name) => `label:\\Category${name.charAt(0).toUpperCase()}${name.slice(1).toLowerCase()}`;
    // Gmail's `label:` takes the label's name as people write it; Hoodiecrow compares it with the mailbox-name
    // form (modified UTF-7), so names outside ASCII are written that way first. The query arrives as UTF-8 bytes.
    const labels = (query) => {
      const binary = !/[^\x00-\xff]/.test(query);
      const text = binary ? Buffer.from(query, "latin1").toString("utf8") : query;
      const out = text.replace(/(label:)(?:"([^"]*)"|([^\s(){}"]+))/gi, (_, op, quoted, bare) => {
        const name = mutf7(quoted ?? bare);
        return quoted !== undefined ? `${op}"${name}"` : `${op}${name}`;
      });
      return binary ? Buffer.from(out, "utf8").toString("latin1") : out;
    };
    raw.argumentTypes = () => [(query, ...rest) => parse(labels(String(query)).replace(/category:(\w+)/gi, (_, name) => tab(name)), ...rest)];
    // A message keeps its labels, thread and id when it moves between All Mail, Trash and Spam (Hoodiecrow's
    // copy would start with the destination's label alone).
    server.copyHandlers.push((_, source, properties) => {
      properties["X-GM-LABELS"] = (source["X-GM-LABELS"] ?? []).filter((l) => !["\\All", "\\Trash", "\\Junk"].includes(l));
      for (const key of ["X-GM-THRID", "X-GM-MSGID"]) if (source[key]) properties[key] = source[key];
    });
    // Gmail's label folders are its labels: renaming or deleting one renames or removes the label on
    // every message (and the labels nested under it on a rename), with a new MODSEQ like any label
    // change. Hoodiecrow only renames or deletes the (empty) folder.
    const relabel = (change) => {
      for (const path of ["[Gmail]/All Mail", "[Gmail]/Trash", "[Gmail]/Spam"]) {
        const box = server.getMailbox(path);
        for (const m of box?.messages ?? []) {
          const before = m["X-GM-LABELS"] ?? [];
          const after = change(before);
          if (after.length === before.length && after.every((l, i) => l === before[i])) continue;
          m["X-GM-LABELS"] = after;
          box.HIGHESTMODSEQ = Math.max(Number(box.HIGHESTMODSEQ) || 1, Number(m.MODSEQ) || 0) + 1;
          m.MODSEQ = box.HIGHESTMODSEQ;
        }
      }
    };
    const nested = (label, path) => label === path || label.startsWith(`${path}/`);
    const rename = server.getCommandHandler("RENAME");
    server.setCommandHandler("RENAME", (connection, parsed, data, callback) => {
      const [from, to] = (parsed.attributes ?? []).map((a) => String(a?.value ?? ""));
      rename(connection, parsed, data, (...args) => {
        if (from && to && server.getMailbox(to) && !server.getMailbox(from)) relabel((labels) => labels.map((l) => (nested(l, from) ? to + l.slice(from.length) : l)));
        callback(...args);
      });
    });
    const remove = server.getCommandHandler("DELETE");
    server.setCommandHandler("DELETE", (connection, parsed, data, callback) => {
      const path = String(parsed.attributes?.[0]?.value ?? "");
      remove(connection, parsed, data, (...args) => {
        if (path && !server.getMailbox(path)) relabel((labels) => labels.filter((l) => l !== path));
        callback(...args);
      });
    });
    const append = server.appendMessage.bind(server);
    server.appendMessage = (box, flags, internaldate, raw, ignore, properties) => {
      const path = typeof box === "string" ? box : box.path;
      // Gmail files mail appended to INBOX in All Mail, labelled \Inbox (new mail arriving, for the change feed tests).
      if (path === "INBOX") return append("[Gmail]/All Mail", flags, internaldate, raw, ignore, { "X-GM-LABELS": ["\\Inbox"], ...properties });
      if (path === "[Gmail]/Drafts") return append("[Gmail]/All Mail", flags, internaldate, raw, ignore, { ...properties, "X-GM-LABELS": ["\\Draft", "\\Drafts"] });
      return append(box, flags, internaldate, raw, ignore, properties);
    };
  }

  const log = console.log;
  if (quiet) console.log = () => {};
  try {
    await new Promise((resolve) => server.listen(imapPort, "127.0.0.1", resolve));
    const smtp = await new Promise((resolve) => {
      const s = startSMTPServer(smtpPort, server, () => resolve(s));
    });
    return {
      user: USER,
      password,
      imapPort: server.server.address().port,
      smtpPort: smtp.server.address().port,
      /** The Hoodiecrow server, to look at what it holds. */
      imap: server,
      async close() {
        await new Promise((resolve) => smtp.close(resolve));
        await new Promise((resolve) => server.close(resolve));
      },
    };
  } finally {
    console.log = log;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const started = await startTestServer({
    gmail: process.argv.includes("--gmail"),
    cleanup: process.argv.includes("--cleanup"),
    uidplus: !process.argv.includes("--no-uidplus"),
    imapPort: Number(process.env.KITE_IMAP_TEST_PORT ?? 1143),
    smtpPort: Number(process.env.KITE_SMTP_TEST_PORT ?? 1025),
    password: process.env.KITE_IMAP_TEST_PASSWORD,
    quiet: true,
  });
  console.log(`IMAP test server on 127.0.0.1:${started.imapPort} (SMTP ${started.smtpPort})`);
  console.log(`Sign in as ${started.user} with password ${started.password}`);
}
