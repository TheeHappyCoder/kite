import "server-only";

import * as z from "zod";
import { findCode, looksLikeCodeMail, serviceName, shapeOf } from "@/lib/codes";
import { FRESH_CODE_MS, type DesktopCode } from "@/lib/desktop";
import type { Message, Thread } from "@/lib/mail/types";
import { getDb } from "./db";

/*
 * Codes, built in: sign-in codes and magic links from arriving mail (lib/codes.ts reads them), kept
 * a day in the `codes` table for the code bar, the desktop card, toasts and the tray. When Kite
 * can't tell which part of a code to copy ("6246-160281"), it offers the parts and remembers the
 * user's pick per sender and shape (settings key `code_picks`), so the next one is copied directly.
 * Never logged.
 */

const KEEP_MS = 24 * 60 * 60_000;

/** `${sender}|${shape}` -> which choice the user copies (0 first part, 1 second, 2 whole). */
const Picks = z.record(z.string(), z.number().int().min(0).max(2));

function picks(): z.infer<typeof Picks> {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'code_picks'").get() as { value: string } | undefined;
  const parsed = row ? Picks.safeParse(JSON.parse(row.value)) : null;
  return parsed?.success ? parsed.data : {};
}

/** Whether a message may be sign-in mail, from what lists already carry (so only those need a body). */
export function maybeCode(message: Message, subject: string) {
  return looksLikeCodeMail(message.subject ?? subject, message.snippet ?? "");
}

function textOf(message: Message) {
  const body = message.body.join("\n");
  const html = message.html
    ? message.html
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
    : "";
  return `${body || html || message.snippet || ""}`.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

type Row = {
  account_id: string;
  message_id: string;
  thread_id: string;
  sender: string;
  service: string;
  code: string | null;
  choices: string | null;
  link: string | null;
  received_at: string;
};

function toCode(r: Row): DesktopCode {
  return {
    id: `${r.account_id}:${r.message_id}`,
    service: r.service,
    code: r.code ?? undefined,
    link: r.link ?? undefined,
    choices: r.choices ? (JSON.parse(r.choices) as string[]) : undefined,
    receivedAt: r.received_at,
    threadId: r.thread_id,
  };
}

/** Reads the codes in these messages of a conversation and returns the ones it found. */
export function recordCodes(thread: Thread, messageIds: string[], own: string): DesktopCode[] {
  const d = getDb();
  d.prepare("DELETE FROM codes WHERE received_at < ?").run(new Date(Date.now() - KEEP_MS).toISOString());
  const picked = picks();
  const found: DesktopCode[] = [];
  for (const m of thread.messages) {
    if (!messageIds.includes(m.id) || m.draft || m.from.email.toLowerCase() === own) continue;
    const hit = findCode(m.subject ?? thread.subject, textOf(m), m.html);
    if (!hit) continue;
    const sender = m.from.email.toLowerCase();
    // A shape this sender's codes came in before: copy the part the user picked then.
    const pick = hit.choices ? picked[`${sender}|${hit.shape}`] : undefined;
    const code = pick != null ? hit.choices![pick] : hit.code;
    const choices = pick != null ? undefined : hit.choices;
    const row: Row = {
      account_id: thread.accountId,
      message_id: m.id,
      thread_id: thread.id,
      sender,
      service: serviceName(m.from),
      code: code ?? null,
      choices: choices ? JSON.stringify(choices) : null,
      link: hit.link ?? null,
      received_at: m.date,
    };
    d.prepare(
      `INSERT INTO codes (account_id, message_id, thread_id, sender, service, code, choices, link, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, message_id) DO NOTHING`,
    ).run(row.account_id, row.message_id, row.thread_id, row.sender, row.service, row.code, row.choices, row.link, row.received_at);
    found.push(toCode(row));
  }
  return found;
}

/**
 * The user copied one of a code's parts: remember it for this sender's codes of the same shape,
 * and settle this code. Returns the copied value, or null when the code is gone or `index` is off.
 */
export function pickCode(id: string, index: number): string | null {
  const d = getDb();
  const row = d.prepare("SELECT * FROM codes WHERE account_id || ':' || message_id = ?").get(id) as Row | undefined;
  const choices = row?.choices ? (JSON.parse(row.choices) as string[]) : null;
  if (!row || !choices?.[index]) return null;
  const next = { ...picks(), [`${row.sender}|${shapeOf(choices)}`]: index };
  d.prepare("INSERT INTO settings (key, value) VALUES ('code_picks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(next));
  d.prepare("UPDATE codes SET code = ?, choices = NULL WHERE account_id = ? AND message_id = ?").run(choices[index], row.account_id, row.message_id);
  return choices[index];
}

/** Codes and links under ten minutes old, newest first. */
export function freshCodes(limit = 5): DesktopCode[] {
  const since = new Date(Date.now() - FRESH_CODE_MS).toISOString();
  const rows = getDb().prepare("SELECT * FROM codes WHERE received_at >= ? ORDER BY received_at DESC LIMIT ?").all(since, limit) as Row[];
  return rows.map(toCode);
}
