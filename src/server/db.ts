import "server-only";

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataDir } from "./paths";
import { seal, unseal } from "./secrets";
import { freeColor } from "@/lib/mail/account-face";
import type { Provider } from "@/lib/mail/types";

// Local SQLite store at data/kite.sqlite (git-ignored).
// Tokens are sealed (AES-256-GCM, key wrapped by the OS: server/secrets.ts) before they're stored.

let db: DatabaseSync | null = null;

export function getDb() {
  if (db) return db;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(path.join(dir, "kite.sqlite"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL,
      -- Short hash of the cached photo (server/avatars.ts). NULL: not looked up yet; '': none.
      picture TEXT,
      -- What the user calls the account ("Work"). NULL: use the provider's name.
      nickname TEXT,
      -- The picture the user picked (lib/mail/account-face.ts): 'initials', 'gradient:<seed>', 'asset:<id>'. NULL: the provider's photo.
      face TEXT
    );
    CREATE TABLE IF NOT EXISTS document_text (
      account_id TEXT NOT NULL, message_id TEXT NOT NULL, part_id TEXT NOT NULL,
      text TEXT NOT NULL, PRIMARY KEY(account_id, message_id, part_id)
    );
    CREATE TABLE IF NOT EXISTS tokens (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER NOT NULL,
      scope TEXT
    );
    CREATE TABLE IF NOT EXISTS undos (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      at TEXT NOT NULL,
      steps TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS snoozes (
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      until TEXT NOT NULL,
      PRIMARY KEY (account_id, thread_id)
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      last_date TEXT NOT NULL,
      labels TEXT NOT NULL,
      sender_email TEXT,
      sender_name TEXT,
      unsubscribe TEXT,
      full INTEGER NOT NULL DEFAULT 0,
      data TEXT NOT NULL,
      -- The slim copy lists read (no bodies), kept by the triggers below (store.ts LIST_COLUMNS).
      list_data TEXT
    );
    CREATE INDEX IF NOT EXISTS threads_account_date ON threads(account_id, last_date DESC);
    CREATE INDEX IF NOT EXISTS threads_sender ON threads(sender_email);
    CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
      id UNINDEXED, subject, people, body, tokenize = 'porter unicode61'
    );
    CREATE TABLE IF NOT EXISTS sync_state (
      account_id TEXT PRIMARY KEY,
      history_id TEXT,
      synced_at TEXT,
      initial_done INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    CREATE TABLE IF NOT EXISTS senders (
      email TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      unsubscribed_at TEXT,
      -- Cleanup's "Keep": the user wants this sender's mail, so Cleanup stops suggesting them.
      kept_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS scheduled (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      send_at TEXT NOT NULL,
      remind_days INTEGER,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS followups (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      thread_remote_id TEXT NOT NULL,
      sent_at TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL
    );
    -- Lists look up each thread's nudge (store.ts REMINDER): without this every row scanned the table.
    CREATE INDEX IF NOT EXISTS followups_thread ON followups(account_id, thread_remote_id);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS drafts (
      draft_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS drafts_message ON drafts(message_id);
    -- Per-conversation local state (lib/mail/overrides.ts), keyed by Kite thread id. Kept when the mail cache is reset.
    CREATE TABLE IF NOT EXISTS thread_overrides (
      thread_id TEXT PRIMARY KEY,
      chat INTEGER,
      muted INTEGER NOT NULL DEFAULT 0,
      pinned_at TEXT,
      note TEXT,
      -- When the note was last written (the Notes view sorts by it).
      note_at TEXT,
      subject TEXT,
      -- Reply tracking (lib/replies.ts): Done on this message id, or Dismiss (never tracked).
      reply_done TEXT,
      reply_off INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
    -- Answers to meeting invites sent from Kite (server/calendar.ts), so the card shows yours before
    -- the organiser's update arrives. Keyed by the event's UID and the occurrence ('' for the whole event).
    CREATE TABLE IF NOT EXISTS invite_replies (
      account_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      occurrence TEXT NOT NULL DEFAULT '',
      response TEXT NOT NULL,
      note TEXT,
      via TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (account_id, uid, occurrence)
    );
    -- Every invite Kite has read, per message, so a card can tell when a later email in another
    -- conversation updated or cancelled the same event (server/calendar.ts).
    CREATE TABLE IF NOT EXISTS invite_states (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      occurrence TEXT NOT NULL DEFAULT '',
      method TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      cancelled INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (account_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS invite_states_uid ON invite_states(account_id, uid);
    -- A read-only copy of each account's own calendar around today (server/events.ts), for Today.
    -- Kept only while "Use your calendar" is on; start and end are ISO instants, or days for all-day events.
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT,
      data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS events_account_start ON events(account_id, start);
    -- Where each account's calendar read left off: the provider's cursor for the window starting at window_from.
    CREATE TABLE IF NOT EXISTS calendar_sync (
      account_id TEXT PRIMARY KEY,
      cursor TEXT,
      window_from TEXT NOT NULL,
      synced_at TEXT NOT NULL
    );
    -- The mail calendar (server/mail-calendar.ts), for accounts whose provider has no calendar Kite can reach:
    -- each stored message carrying a calendar file, read once (ics NULL: nothing usable in it). Rebuilt
    -- from stored mail after Reset local copy.
    CREATE TABLE IF NOT EXISTS mail_invites (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      uid TEXT NOT NULL,
      method TEXT NOT NULL,
      date TEXT NOT NULL,
      ics TEXT,
      PRIMARY KEY (account_id, message_id)
    );
    -- Events the user added with "Add to calendar" to a mail calendar: only in Kite (CalendarEvent JSON).
    -- Collections (server/collections.ts): your own tables, filled by automations' "Add to a
    -- collection". Each row keeps the fields it was read with, so a collection stays readable
    -- after the automation that filled it changes or is deleted. One row per email per collection.
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS collection_rows (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      rule_id TEXT,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      sender TEXT NOT NULL,
      at TEXT NOT NULL,
      fields TEXT NOT NULL,
      value_data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (collection_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS collection_rows_by ON collection_rows(collection_id, at);
    CREATE INDEX IF NOT EXISTS collection_rows_thread ON collection_rows(thread_id, at);
    CREATE TABLE IF NOT EXISTS local_events (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      start TEXT NOT NULL,
      end TEXT,
      data TEXT NOT NULL
    );
    -- Replies a rule prepared (prepare_reply, server/prepared.ts), one per conversation, keyed by
    -- Kite thread id. Waits in the quick-reply box; never sent by itself.
    CREATE TABLE IF NOT EXISTS prepared_replies (
      thread_id TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      message_id TEXT NOT NULL,
      body TEXT NOT NULL,
      missing TEXT NOT NULL,
      created_at TEXT NOT NULL,
      ai INTEGER NOT NULL DEFAULT 0
    );
    -- A rule's "Draft with AI" actions, waiting for or done by the AI (server/ai-drafts.ts). The id
    -- is the prepared reply's. What each call used is in ai_usage; no mail text is kept here.
    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      message_id TEXT NOT NULL,
      instruction TEXT NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      ran_at TEXT
    );
    -- Every AI call, one row each (server/ai-usage.ts): what it was for, tokens, cost at the price
    -- in force then, and whether it ran, failed or was refused at a limit. Ids only: no mail text,
    -- no addresses. Kept 400 days.
    CREATE TABLE IF NOT EXISTS ai_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      action TEXT NOT NULL,
      preset TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      cost REAL,
      outcome TEXT NOT NULL,
      reason TEXT,
      rule_id TEXT,
      thread_id TEXT
    );
    CREATE INDEX IF NOT EXISTS ai_usage_at ON ai_usage(at);
    -- Per-person local state (lib/mail/person-prefs.ts): VIP flag and a private note, keyed by
    -- lower-cased address. Set only by the user; sync and "Reset local copy" never touch it.
    CREATE TABLE IF NOT EXISTS people (
      email TEXT PRIMARY KEY,
      vip INTEGER NOT NULL DEFAULT 0,
      note TEXT,
      -- When the note was last written (the Notes view sorts by it).
      note_at TEXT,
      updated_at TEXT NOT NULL,
      -- "Always load images from this sender".
      images INTEGER NOT NULL DEFAULT 0
    );
    -- Apps and scripts the user let into the Kite bar (server/bar/integrations.ts). Only a hash of
    -- each token is kept; the token itself is shown once, when it's made.
    CREATE TABLE IF NOT EXISTS bar_integrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      -- The token's last 4 characters, so the user can tell tokens apart.
      token_hint TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_seen TEXT
    );
    -- Local splits and merges (server/regroup.ts). Gmail's threading is never changed; these
    -- decide which Kite thread each Gmail message is stored in, and survive cache resets.
    CREATE TABLE IF NOT EXISTS regroups (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      source_id TEXT NOT NULL,
      source_subject TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    -- A Gmail message placed in another Kite thread. previous* is what the regroup replaced (for undo).
    CREATE TABLE IF NOT EXISTS message_moves (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      regroup_id TEXT NOT NULL,
      previous TEXT,
      previous_regroup TEXT,
      PRIMARY KEY (account_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS message_moves_remote ON message_moves(account_id, remote_id);
    -- New messages in a Gmail thread go to this Kite thread (it was merged into another).
    CREATE TABLE IF NOT EXISTS thread_merges (
      account_id TEXT NOT NULL,
      remote_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      regroup_id TEXT NOT NULL,
      previous TEXT,
      previous_regroup TEXT,
      PRIMARY KEY (account_id, remote_id)
    );
    -- The user's own labels/folders per account (server/labels.ts), refreshed from the provider.
    -- filled_at: when the conversations carrying it were last fetched into the local copy.
    CREATE TABLE IF NOT EXISTS labels (
      account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT,
      hidden INTEGER NOT NULL DEFAULT 0,
      filled_at TEXT,
      kind TEXT NOT NULL DEFAULT 'tag',
      PRIMARY KEY (account_id, id)
    );
    -- Fill & sign "sign like last time" (server/fill-layouts.ts). fingerprint: salted hashes of the
    -- form's printed lines, never the text. Kept when the mail cache is reset.
    CREATE TABLE IF NOT EXISTS fill_layouts (
      id TEXT PRIMARY KEY,
      sender TEXT NOT NULL,
      name TEXT NOT NULL,
      pages TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      spec TEXT NOT NULL,
      created_at TEXT NOT NULL,
      used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS fill_layouts_sender ON fill_layouts(sender);
    -- Sign-in codes and links found in arriving mail (server/codes.ts), for the code popup, the
    -- desktop toasts and tray. Pruned after a day.
    CREATE TABLE IF NOT EXISTS codes (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      service TEXT NOT NULL,
      code TEXT,
      choices TEXT,
      link TEXT,
      received_at TEXT NOT NULL,
      PRIMARY KEY (account_id, message_id)
    );
    -- The rules engine (server/rules.ts): rules run top to bottom by position; data is the zod
    -- Rule. rule_runs is the activity log and what Undo reverses (pruned after 30 days).
    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      position INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      preset TEXT UNIQUE,
      data TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rule_runs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_ids TEXT NOT NULL,
      at TEXT NOT NULL,
      trigger TEXT NOT NULL,
      batch_id TEXT,
      actions TEXT NOT NULL,
      undo TEXT NOT NULL,
      undone_at TEXT
    );
    CREATE INDEX IF NOT EXISTS rule_runs_rule_thread ON rule_runs(rule_id, thread_id);
    CREATE INDEX IF NOT EXISTS rule_runs_at ON rule_runs(at);
    -- The expect verb (server/expectations.ts): an answer an automation waits for. who / plan are
    -- JSON (lib/automations/expect.ts); period: a scheduled run's occurrence, one row per person.
    CREATE TABLE IF NOT EXISTS expectations (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT,
      message_id TEXT,
      who TEXT NOT NULL,
      subject TEXT NOT NULL,
      answer TEXT NOT NULL,
      plan TEXT NOT NULL,
      period TEXT,
      since TEXT NOT NULL,
      due_at TEXT NOT NULL,
      asked_at TEXT,
      nudged INTEGER NOT NULL DEFAULT 0,
      nudged_at TEXT,
      surfaced INTEGER NOT NULL DEFAULT -1,
      status TEXT NOT NULL,
      met_at TEXT,
      met_thread TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (rule_id, period, who)
    );
    CREATE INDEX IF NOT EXISTS expectations_open ON expectations(status, account_id);
    -- Schedule automations: the last occurrence each one ran for (server/schedules.ts).
    CREATE TABLE IF NOT EXISTS rule_schedules (rule_id TEXT PRIMARY KEY, last_at TEXT NOT NULL);
    -- A rule's "wait before acting": runs waiting for their time (server/rules.ts runDelayed).
    CREATE TABLE IF NOT EXISTS rule_delays (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_ids TEXT NOT NULL,
      read_data TEXT,
      run_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rule_delays_at ON rule_delays(run_at);
    -- "Also run in Gmail" (server/providers/gmail/filters.ts): one row per rule and account it covers,
    -- with the Gmail filter Kite made (filter_id) and how it stands. Only Kite's own filters are listed.
    CREATE TABLE IF NOT EXISTS gmail_filters (
      rule_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      filter_id TEXT,
      signature TEXT,
      state TEXT NOT NULL,
      detail TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (rule_id, account_id)
    );
    -- The optional Google sign-in of a Gmail-over-IMAP account (server/mail/google/link.ts): calendar,
    -- contact photos and the profile photo. Tokens sealed, like the tokens table.
    CREATE TABLE IF NOT EXISTS google_links (
      account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at INTEGER NOT NULL,
      scope TEXT
    );
    -- IMAP/SMTP accounts (server/providers/imap): where the mail lives and the app password, sealed.
    CREATE TABLE IF NOT EXISTS mail_servers (
      account_id TEXT PRIMARY KEY,
      imap_host TEXT NOT NULL,
      imap_port INTEGER NOT NULL,
      imap_secure INTEGER NOT NULL,
      smtp_host TEXT NOT NULL,
      smtp_port INTEGER NOT NULL,
      smtp_secure INTEGER NOT NULL,
      username TEXT NOT NULL,
      secret TEXT NOT NULL,
      preset TEXT
    );
    -- IMAP has no conversations or stable ids, so the IMAP provider keeps its own index: one row per
    -- message (id from its Message-ID, so it survives moves; thread from References/In-Reply-To),
    -- one per copy of it in a folder (a note to yourself sits in Sent and Inbox), and the
    -- Message-IDs each message points at (to find a thread when replies arrive before their parent).
    CREATE TABLE IF NOT EXISTS imap_messages (
      account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      message_id TEXT,
      date TEXT NOT NULL,
      meta TEXT NOT NULL,
      -- Gmail mode: the Inbox tab (CATEGORY_PROMOTIONS...) from X-GM-RAW category: searches; null = Primary.
      category TEXT,
      PRIMARY KEY (account_id, id)
    );
    CREATE INDEX IF NOT EXISTS imap_messages_thread ON imap_messages (account_id, thread_id);
    CREATE INDEX IF NOT EXISTS imap_messages_header ON imap_messages (account_id, message_id);
    CREATE TABLE IF NOT EXISTS imap_copies (
      account_id TEXT NOT NULL,
      folder TEXT NOT NULL,
      uid INTEGER NOT NULL,
      id TEXT NOT NULL,
      flags TEXT NOT NULL,
      -- Gmail's X-GM-LABELS on this copy (Gmail mode only, else []).
      labels TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (account_id, folder, uid)
    );
    CREATE INDEX IF NOT EXISTS imap_copies_message ON imap_copies (account_id, id);
    CREATE TABLE IF NOT EXISTS imap_refs (
      account_id TEXT NOT NULL,
      ref TEXT NOT NULL,
      id TEXT NOT NULL,
      PRIMARY KEY (account_id, ref, id)
    );
    CREATE TRIGGER IF NOT EXISTS threads_list_insert_v1 AFTER INSERT ON threads BEGIN UPDATE threads SET list_data = ${listCopy("NEW.data")} WHERE id = NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS threads_list_update_v1 AFTER UPDATE OF data ON threads BEGIN UPDATE threads SET list_data = ${listCopy("NEW.data")} WHERE id = NEW.id; END;
  `);
  return db;
}

/**
 * A thread JSON as lists carry it: each message without `html`, `trackersBlocked` and `labels`,
 * and `body` cut to its first part unless there's a snippet (the same cut as `hydrate` in
 * store.ts, which still applies it). Bump the trigger names (`_v1`) when this changes; drop the old ones by hand.
 */
function listCopy(source: string) {
  return `json_set(${source}, '$.messages', (SELECT json_group_array(json(json_set(json_remove(m.value, '$.html', '$.trackersBlocked', '$.labels'), '$.body',
    CASE WHEN COALESCE(json_extract(m.value, '$.snippet'), '') != '' OR COALESCE(json_array_length(m.value, '$.body'), 0) = 0 THEN json('[]')
    ELSE json_array(json_extract(m.value, '$.body[0]')) END))) FROM json_each(${source}, '$.messages') m))`;
}


export type AccountRow = {
  id: string;
  provider: Provider;
  email: string;
  name: string;
  color: string;
  created_at: string;
  /** Short hash of the cached profile photo (a version for its URL). Null until looked up, "" when the account has none. */
  picture: string | null;
  /** Set only by the user in Settings; null shows the provider's name. */
  nickname: string | null;
  /** The picture the user picked (AccountFaceChoice); null shows the provider's photo. */
  face: string | null;
};

type TokenRow = {
  account_id: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  scope: string | null;
};

export function listAccounts() {
  return getDb().prepare("SELECT * FROM accounts ORDER BY created_at").all() as AccountRow[];
}

export function getAccount(id: string) {
  return getDb().prepare("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | undefined;
}

export function upsertAccount(input: { email: string; name: string; provider: Provider }) {
  const existing = getDb().prepare("SELECT * FROM accounts WHERE email = ?").get(input.email) as AccountRow | undefined;
  if (existing) return existing;
  const taken = (getDb().prepare("SELECT color FROM accounts").all() as { color: string }[]).map((r) => r.color);
  const row: AccountRow = {
    id: crypto.randomUUID(),
    provider: input.provider,
    email: input.email,
    name: input.name,
    color: freeColor(taken),
    created_at: new Date().toISOString(),
    picture: null,
    nickname: null,
    face: null,
  };
  getDb()
    .prepare("INSERT INTO accounts (id, provider, email, name, color, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(row.id, row.provider, row.email, row.name, row.color, row.created_at);
  return row;
}

export function setAccountName(id: string, name: string) {
  getDb().prepare("UPDATE accounts SET name = ? WHERE id = ?").run(name, id);
}

export function setAccountPicture(id: string, picture: string | null) {
  getDb().prepare("UPDATE accounts SET picture = ? WHERE id = ?").run(picture, id);
}

export function setAccountNickname(id: string, nickname: string | null) {
  getDb().prepare("UPDATE accounts SET nickname = ? WHERE id = ?").run(nickname, id);
}

export function setAccountColor(id: string, color: string) {
  getDb().prepare("UPDATE accounts SET color = ? WHERE id = ?").run(color, id);
}

export function setAccountFace(id: string, face: string | null) {
  getDb().prepare("UPDATE accounts SET face = ? WHERE id = ?").run(face, id);
}

/** Whether any account still shows this picture (one upload can be picked for several). */
export function faceInUse(face: string) {
  return !!getDb().prepare("SELECT 1 FROM accounts WHERE face = ?").get(face);
}

export function deleteAccount(id: string) {
  const d = getDb();
  d.prepare("DELETE FROM tokens WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM snoozes WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM undos WHERE EXISTS (SELECT 1 FROM json_each(undos.steps) WHERE json_extract(value, '$.accountId') = ?)").run(id);
  d.prepare("DELETE FROM threads_fts WHERE id IN (SELECT id FROM threads WHERE account_id = ?)").run(id);
  d.prepare("DELETE FROM threads WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM sync_state WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM scheduled WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM followups WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM document_text WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM drafts WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM regroups WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM message_moves WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM thread_merges WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM labels WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM rule_runs WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM rule_delays WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM expectations WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM collection_rows WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM gmail_filters WHERE account_id = ?").run(id);
  for (const table of ["mail_servers", "imap_messages", "imap_copies", "imap_refs", "google_links"]) d.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(id);
  d.prepare("DELETE FROM prepared_replies WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM invite_replies WHERE account_id = ?").run(id);
  for (const table of ["invite_states", "events", "calendar_sync", "mail_invites", "local_events"]) d.prepare(`DELETE FROM ${table} WHERE account_id = ?`).run(id);
  d.prepare("DELETE FROM ai_jobs WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM thread_overrides WHERE substr(thread_id, 1, length(?) + 1) = ? || ':'").run(id, id);
  // Codes hold text read from this account's mail.
  d.prepare("DELETE FROM codes WHERE account_id = ?").run(id);
  d.prepare("DELETE FROM accounts WHERE id = ?").run(id);
}

/**
 * Empties every table (the schema stays, so the app opens fresh) and compacts the file so the
 * old pages are gone from disk. Full-text index shadow tables are emptied through their index.
 */
export function eraseAllRows() {
  const d = getDb();
  const tables = d
    .prepare(
      `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
    )
    .all() as { name: string; sql: string | null }[];
  const virtual = tables.filter((t) => /^CREATE VIRTUAL/i.test(t.sql ?? "")).map((t) => t.name);
  const shadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`));
  for (const name of virtual) {
    try {
      d.exec(`INSERT INTO "${name}"("${name}") VALUES('delete-all')`);
    } catch {
      d.exec(`DELETE FROM "${name}"`);
    }
  }
  for (const { name } of tables) if (!virtual.includes(name) && !shadow(name)) d.exec(`DELETE FROM "${name}"`);
  compactSearchIndex();
}

/**
 * Deleted rows leave their words in the full-text index's segments until it's merged: merge it
 * and compact the file, so removed mail is really gone from disk.
 */
export function compactSearchIndex() {
  const d = getDb();
  d.exec("INSERT INTO threads_fts(threads_fts) VALUES('optimize')");
  d.exec("VACUUM");
}

/** The scopes an account granted. Not secret, so no key is needed (lists and settings read this at startup). */
export function getTokenScope(accountId: string): string | null {
  const row = getDb().prepare("SELECT scope FROM tokens WHERE account_id = ?").get(accountId) as { scope: string | null } | undefined;
  return row?.scope ?? null;
}

/** An account's tokens, decrypted (they're stored sealed, see server/secrets.ts). */
export function getToken(accountId: string) {
  const row = getDb().prepare("SELECT * FROM tokens WHERE account_id = ?").get(accountId) as TokenRow | undefined;
  if (!row) return undefined;
  return { ...row, access_token: unseal(row.access_token), refresh_token: row.refresh_token ? unseal(row.refresh_token) : row.refresh_token };
}

export function saveToken(token: TokenRow) {
  token = { ...token, access_token: seal(token.access_token), refresh_token: token.refresh_token ? seal(token.refresh_token) : token.refresh_token };
  getDb()
    .prepare(
      `INSERT INTO tokens (account_id, access_token, refresh_token, expires_at, scope) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         access_token = excluded.access_token,
         refresh_token = COALESCE(excluded.refresh_token, tokens.refresh_token),
         expires_at = excluded.expires_at,
         scope = COALESCE(excluded.scope, tokens.scope)`,
    )
    .run(token.account_id, token.access_token, token.refresh_token, token.expires_at, token.scope);
}

/** How long a move's Undo stays offered (the toast is gone long before). */
const UNDO_MS = 10 * 60_000;

/** Keeps the way back from a move (folder moves, Cleanup's archives), so Undo survives a restart. Each step names its `accountId`. */
export function saveUndo(kind: "move" | "cleanup" | "mail-preview" | "mail-undo", steps: { accountId: string }[]) {
  const d = getDb();
  d.prepare("DELETE FROM undos WHERE at < ?").run(new Date(Date.now() - UNDO_MS).toISOString());
  const id = crypto.randomUUID();
  d.prepare("INSERT INTO undos (id, kind, at, steps) VALUES (?, ?, ?, ?)").run(id, kind, new Date().toISOString(), JSON.stringify(steps));
  return id;
}

/** The way back saved under `id` (gone once taken, or after UNDO_MS), or null. */
export function takeUndo<T>(kind: "move" | "cleanup" | "mail-preview" | "mail-undo", id: string): T[] | null {
  const d = getDb();
  const row = d.prepare("DELETE FROM undos WHERE id = ? AND kind = ? RETURNING at, steps").get(id, kind) as { at: string; steps: string } | undefined;
  if (!row || Date.now() - new Date(row.at).getTime() > UNDO_MS) return null;
  return JSON.parse(row.steps) as T[];
}

export function setSnooze(accountId: string, threadId: string, until: string | null) {
  if (until) {
    getDb()
      .prepare("INSERT OR REPLACE INTO snoozes (account_id, thread_id, until) VALUES (?, ?, ?)")
      .run(accountId, threadId, until);
  } else {
    getDb().prepare("DELETE FROM snoozes WHERE account_id = ? AND thread_id = ?").run(accountId, threadId);
  }
}

export function listSnoozes(accountId: string) {
  return getDb().prepare("SELECT thread_id, until FROM snoozes WHERE account_id = ?").all(accountId) as {
    thread_id: string;
    until: string;
  }[];
}
