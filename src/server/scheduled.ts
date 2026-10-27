import "server-only";

import { compileText } from "@/lib/design/compile";
import { bodyToText } from "@/lib/mail/body";
import type { Thread } from "@/lib/mail/types";
import { scopeSql, type AccountScope } from "@/lib/mail/scope";
import { getDb, listAccounts } from "./db";
import type { OutgoingMessage } from "./mail/types";

export function scheduleMessage(accountId: string, message: OutgoingMessage, sendAt: string, remindDays: number | null) {
  const id = crypto.randomUUID();
  getDb()
    .prepare(
      "INSERT INTO scheduled (id, account_id, payload, send_at, remind_days, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)",
    )
    .run(id, accountId, JSON.stringify(message), sendAt, remindDays, new Date().toISOString());
  return id;
}

export function cancelScheduled(id: string) {
  return getDb().prepare("UPDATE scheduled SET status = 'cancelled' WHERE id = ? AND status = 'pending'").run(id).changes > 0;
}

export function getScheduledPayload(id: string) {
  const row = getDb().prepare("SELECT account_id, payload FROM scheduled WHERE id = ?").get(id) as
    | { account_id: string; payload: string }
    | undefined;
  return row ? { accountId: row.account_id, message: JSON.parse(row.payload) as OutgoingMessage } : null;
}

/** Pending scheduled messages, shaped as threads for the Scheduled mailbox. */
export function scheduledThreads(scope: AccountScope): Thread[] {
  const s = scopeSql(scope, "account_id");
  const accounts = new Map(listAccounts().map((a) => [a.id, a]));
  const rows = getDb()
    .prepare(
      // Held sends (undo send) only show here once they've failed.
      `SELECT * FROM scheduled WHERE (status = 'failed' OR (status = 'pending' AND json_extract(payload, '$.held') IS NULL))
       AND ${s.sql} ORDER BY send_at ASC`,
    )
    .all(...s.args) as {
    id: string;
    account_id: string;
    payload: string;
    send_at: string;
    remind_days: number | null;
  }[];
  return rows.map((row) => {
    const message = JSON.parse(row.payload) as OutgoingMessage;
    const account = accounts.get(row.account_id);
    const text = message.design ? compileText(message.design) : bodyToText(message.body);
    const contact = (a: OutgoingMessage["to"][number]) => ({ name: a.name || a.email, email: a.email });
    return {
      id: `scheduled:${row.id}`,
      accountId: row.account_id,
      subject: message.subject || "(no subject)",
      mailbox: "scheduled",
      category: "important",
      unread: false,
      starred: false,
      loaded: true,
      scheduled: { id: row.id, sendAt: row.send_at, remindDays: row.remind_days },
      messages: [
        {
          id: row.id,
          from: { name: "You", email: account?.email ?? "" },
          to: message.to.map(contact),
          cc: message.cc?.length ? message.cc.map(contact) : undefined,
          date: row.send_at,
          body: text.split(/\n{2,}/),
          snippet: text.slice(0, 140),
        },
      ],
    } satisfies Thread;
  });
}
