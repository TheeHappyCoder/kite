import "server-only";

import { getDb } from "../../db";
import type { MailServers } from "../../mail/provider";
import { seal, unseal } from "../../secrets";

// Where an IMAP account's mail lives and its app password (sealed, never logged). One row per
// account in mail_servers; removed on Disconnect (revoke) and with the account.

type StoredServers = MailServers & { username: string; password: string; preset: string | null };

type Row = {
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  username: string;
  secret: string;
  preset: string | null;
};

export function saveServers(accountId: string, servers: MailServers, password: string, preset: string | null) {
  getDb()
    .prepare(
      `INSERT INTO mail_servers (account_id, imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure, username, secret, preset)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET imap_host = excluded.imap_host, imap_port = excluded.imap_port,
         imap_secure = excluded.imap_secure, smtp_host = excluded.smtp_host, smtp_port = excluded.smtp_port,
         smtp_secure = excluded.smtp_secure, username = excluded.username, secret = excluded.secret, preset = excluded.preset`,
    )
    .run(
      accountId,
      servers.imap.host,
      servers.imap.port,
      servers.imap.secure ? 1 : 0,
      servers.smtp.host,
      servers.smtp.port,
      servers.smtp.secure ? 1 : 0,
      servers.username ?? "",
      seal(password),
      preset,
    );
}

/** The account's servers and password, or null when it has none stored (it needs to sign in again). */
export function getServers(accountId: string): StoredServers | null {
  const row = getDb().prepare("SELECT * FROM mail_servers WHERE account_id = ?").get(accountId) as Row | undefined;
  if (!row) return null;
  return {
    imap: { host: row.imap_host, port: row.imap_port, secure: !!row.imap_secure },
    smtp: { host: row.smtp_host, port: row.smtp_port, secure: !!row.smtp_secure },
    username: row.username,
    password: unseal(row.secret),
    preset: row.preset,
  };
}

export function forgetServers(accountId: string) {
  getDb().prepare("DELETE FROM mail_servers WHERE account_id = ?").run(accountId);
}

/** The account's preset ("gmail", "icloud"…) without unsealing its password. */
export function presetOf(accountId: string): string | null {
  const row = getDb().prepare("SELECT preset FROM mail_servers WHERE account_id = ?").get(accountId) as { preset: string | null } | undefined;
  return row?.preset ?? null;
}
