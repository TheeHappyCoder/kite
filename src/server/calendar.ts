import "server-only";

import { buildReply, parseIcs } from "@/lib/calendar/ics";
import { hasInvite, isCalendarFile, type Invite, type InviteResponse } from "@/lib/calendar/invite";
import type { Message, Thread } from "@/lib/mail/types";
import { getAttachment } from "./attachments";
import { getDb, type AccountRow } from "./db";
import { calendarFor, mailOf } from "./providers/registry";
import { getThreadRow, saveInvite } from "./store";

// Meeting invites in mail: read when a conversation opens (a calendar part or .ics from the local
// attachment cache, or the provider's own event for Outlook), answered only when the user clicks.
// The answer goes to the account's calendar when the provider has one Kite may use (so both
// calendars update), else as an iTIP reply by email (IMAP, or an event missing from Google Calendar).

export class InviteError extends Error {
  constructor(
    message: string,
    public status: number,
    /** `calendar_permission`: the account needs Connect first (the card says why and offers it). */
    public code?: "calendar_permission" | "not_in_calendar",
  ) {
    super(message);
  }
}

type ReplyRow = { response: InviteResponse; note: string | null; via: "calendar" | "email"; at: string };

function storedReply(accountId: string, invite: Invite) {
  const row = getDb()
    .prepare("SELECT response, note, via, at FROM invite_replies WHERE account_id = ? AND uid = ? AND occurrence = ?")
    .get(accountId, invite.uid, invite.occurrence ?? "") as ReplyRow | undefined;
  return row ? { response: row.response, via: row.via, at: row.at, ...(row.note ? { note: row.note } : {}) } : undefined;
}

/** The invite in one message, or null. Calendar files come from the attachment cache after the first read. */
async function readInvite(account: AccountRow, message: Message): Promise<Invite | null> {
  if (message.invite) return message.invite;
  const file = message.attachments?.find((a) => isCalendarFile(a) && a.partId);
  if (file?.partId) {
    try {
      const { data } = await getAttachment(account, message.id, file.partId, file.name);
      return parseIcs(data.toString("utf-8"), account.email);
    } catch (error) {
      console.error("Couldn't read an invite:", error instanceof Error ? error.message : error);
      return null;
    }
  }
  const calendar = calendarFor(account);
  if (message.calendar && calendar?.invite) {
    try {
      return await calendar.invite(account, message);
    } catch (error) {
      console.error("Couldn't read an invite:", error instanceof Error ? error.message : error);
    }
  }
  return null;
}

/** Notes which event (and which version of it) a message carries, for `laterChange`. */
function remember(accountId: string, threadId: string, messageId: string, invite: Invite) {
  getDb()
    .prepare(
      `INSERT INTO invite_states (account_id, message_id, thread_id, uid, occurrence, method, sequence, cancelled) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, message_id) DO UPDATE SET thread_id = excluded.thread_id, uid = excluded.uid, occurrence = excluded.occurrence,
         method = excluded.method, sequence = excluded.sequence, cancelled = excluded.cancelled`,
    )
    .run(accountId, messageId, threadId, invite.uid, invite.occurrence ?? "", invite.method, invite.sequence, invite.cancelled ? 1 : 0);
}

/** Conversations checked per opened invite for updates Gmail threaded apart (newest first). */
const LOOK_AROUND = 10;

/**
 * Reads invites in other conversations that might be about the same event (calendar mail whose
 * subject names it), so an update or cancellation threaded apart is known. Each message is read once.
 */
async function lookAround(account: AccountRow, threadId: string, summary: string) {
  const title = summary.trim().toLowerCase();
  if (!title || title === "(no title)") return;
  const rows = getDb()
    .prepare(
      `SELECT id FROM threads WHERE account_id = ? AND id != ? AND full = 1 AND list_data LIKE '%"calendar":true%'
       AND instr(lower(json_extract(list_data, '$.subject')), ?) > 0 ORDER BY last_date DESC LIMIT ?`,
    )
    .all(account.id, threadId, title, LOOK_AROUND) as { id: string }[];
  const known = getDb().prepare("SELECT 1 FROM invite_states WHERE account_id = ? AND message_id = ?");
  for (const { id } of rows) {
    const row = getThreadRow(id);
    if (!row) continue;
    for (const message of (JSON.parse(row.data) as Thread).messages) {
      if (!hasInvite(message) || known.get(account.id, message.id)) continue;
      const found = await readInvite(account, message);
      if (found) remember(account.id, id, message.id, found);
    }
  }
}

/** A newer version of this event in another conversation: an update (higher sequence) or a cancellation. */
function laterChange(accountId: string, threadId: string, invite: Invite): Invite["later"] {
  const row = getDb()
    .prepare(
      `SELECT thread_id, method, cancelled FROM invite_states WHERE account_id = ? AND uid = ? AND thread_id != ?
       AND (occurrence = ? OR occurrence = '') AND method IN ('REQUEST', 'CANCEL')
       AND (sequence > ? OR (method = 'CANCEL' AND sequence >= ?)) ORDER BY sequence DESC, cancelled DESC LIMIT 1`,
    )
    .get(accountId, invite.uid, threadId, invite.occurrence ?? "", invite.sequence, invite.sequence) as
    | { thread_id: string; method: string; cancelled: number }
    | undefined;
  return row ? { threadId: row.thread_id, cancelled: row.method === "CANCEL" || row.cancelled === 1 } : undefined;
}

/**
 * The conversation holding the invite for a calendar event (matched by UID): one Kite has read already,
 * else calendar mail whose subject names the event (each message read once). Only on the user's click.
 */
export async function inviteThread(account: AccountRow, uid: string, summary: string): Promise<{ threadId: string; subject: string } | null> {
  const find = () =>
    getDb()
      .prepare(
        `SELECT s.thread_id, json_extract(t.list_data, '$.subject') AS subject FROM invite_states s JOIN threads t ON t.id = s.thread_id
         WHERE s.account_id = ? AND s.uid = ? ORDER BY s.method = 'REQUEST' DESC, s.sequence DESC LIMIT 1`,
      )
      .get(account.id, uid) as { thread_id: string; subject: string | null } | undefined;
  const row = find() ?? (await lookAround(account, "", summary), find());
  return row ? { threadId: row.thread_id, subject: row.subject ?? summary } : null;
}

/**
 * Adds `invite` (with your answer from Kite, if any) to messages that carry one, and marks invites
 * a later email updated or cancelled, even in another conversation.
 */
export async function withInvites(account: AccountRow, threadId: string, messages: Message[]): Promise<Message[]> {
  return Promise.all(
    messages.map(async (message) => {
      if (!hasInvite(message)) return message;
      const fresh = !message.invite;
      const invite = await readInvite(account, message);
      if (!invite) return message;
      // Read from the provider (no local file to parse again): keep it with the message.
      if (fresh && !message.attachments?.some(isCalendarFile)) saveInvite(threadId, message.id, invite);
      remember(account.id, threadId, message.id, invite);
      if (invite.method === "REQUEST" && !invite.cancelled) {
        await lookAround(account, threadId, invite.summary).catch((error) => console.error("Looking for invite updates:", error instanceof Error ? error.message : error));
      }
      const later = invite.method === "REQUEST" && !invite.cancelled ? laterChange(account.id, threadId, invite) : undefined;
      const replied = storedReply(account.id, invite);
      return { ...message, invite: { ...invite, ...(replied ? { replied } : {}), ...(later ? { later } : {}) } };
    }),
  );
}

/** An iTIP REPLY by email to the organiser, in the invite's conversation. */
async function replyByEmail(account: AccountRow, message: Message, invite: Invite, response: InviteResponse, note?: string) {
  if (!invite.organizer) throw new InviteError("This invite doesn't say who sent it, so Kite can't answer it.", 400);
  const me = { name: account.name, email: account.email };
  const word = { accepted: "Accepted", tentative: "Tentatively accepted", declined: "Declined" }[response];
  const text = [`${account.name} ${word.toLowerCase()} this invitation.`, note?.trim()].filter(Boolean).join("\n\n");
  await mailOf(account).send(
    account,
    {
      to: [{ name: invite.organizer.name, email: invite.organizer.email }],
      subject: `${word}: ${invite.summary}`,
      body: text,
      threadId: message.remoteThread,
      inReplyTo: message.messageIdHeader,
      references: message.references,
    },
    { text, html: null, inline: [], attachments: [], calendar: { method: "REPLY", text: buildReply(invite, me, response, note) } },
  );
}

/**
 * Answers the invite in one message: in the calendar when the provider has one, by email when it
 * doesn't (or when `byEmail`, the card's fallback). Returns the invite with your answer.
 */
export async function respondToInvite(
  account: AccountRow,
  input: { threadId: string; messageId: string; response: InviteResponse; note?: string; byEmail?: boolean },
): Promise<Invite> {
  const row = getThreadRow(input.threadId);
  if (!row || row.account_id !== account.id) throw new InviteError("That conversation isn't here any more.", 404);
  const message = (JSON.parse(row.data) as Thread).messages.find((m) => m.id === input.messageId);
  const invite = message ? await readInvite(account, message) : null;
  if (!message || !invite) throw new InviteError("Kite couldn't read this invite.", 404);
  if (invite.method !== "REQUEST" || invite.cancelled) throw new InviteError("This invite can't be answered.", 400);
  const later = laterChange(account.id, input.threadId, invite);
  if (later) throw new InviteError(later.cancelled ? "This event was cancelled in a later email." : "This invite changed in a later email. Answer the newer one.", 409);
  if (invite.organizer?.email.toLowerCase() === account.email.toLowerCase()) throw new InviteError("This is your own invite.", 400);

  const calendar = calendarFor(account);
  const canEmail = !calendar || calendar.email;
  let via: "calendar" | "email" = "email";
  if (calendar && !input.byEmail) {
    if (calendar.missing(account.id)) throw new InviteError(calendar.missing(account.id)!, 409, "calendar_permission");
    const result = await calendar.respond(account, { message, invite, response: input.response, note: input.note });
    if (result === "done") via = "calendar";
    else if (!canEmail) throw new InviteError("This event isn't in your calendar any more.", 404);
    else throw new InviteError("This event isn't in your calendar, so Kite can answer by email instead.", 404, "not_in_calendar");
  } else {
    if (!canEmail) throw new InviteError("This account answers invites in its calendar.", 400);
    await replyByEmail(account, message, invite, input.response, input.note);
  }

  const at = new Date().toISOString();
  const note = input.note?.trim() || null;
  getDb()
    .prepare(
      `INSERT INTO invite_replies (account_id, uid, occurrence, response, note, via, at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, uid, occurrence) DO UPDATE SET response = excluded.response, note = excluded.note, via = excluded.via, at = excluded.at`,
    )
    .run(account.id, invite.uid, invite.occurrence ?? "", input.response, note, via, at);
  return { ...invite, replied: { response: input.response, via, at, ...(note ? { note } : {}) } };
}
