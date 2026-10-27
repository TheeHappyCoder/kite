import "server-only";

import { accountSpec, canManage, cleanLabelName, providerSpec, serviceName, type LabelKind, type MailLabel, type ProviderSpec } from "@/lib/mail/providers";
import { scopeSql, type AccountScope } from "@/lib/mail/scope";
import { getDb, listAccounts, type AccountRow } from "./db";
import { LabelError } from "./mail/errors";
import type { MailProvider } from "./mail/provider";
import type { RemoteLabel } from "./mail/types";
import { providerFor } from "./providers/registry";

// The user's own labels/folders per account. Each provider reads them its own way (MailProvider
// `labels`); everything after that (storage, counts, views, search) is provider-neutral and
// keyed by the provider's id. How each provider behaves is declared in lib/mail/providers.ts.

/** A provider's `labels` (MailProvider): list, and where it can, create / rename / remove. */
type LabelAdapter = NonNullable<MailProvider["labels"]>;

/** How this account's provider reads labels/folders, or null while Kite doesn't handle them for it. */
export function labelAdapter(account: Pick<AccountRow, "provider">): LabelAdapter | null {
  return providerSpec(account.provider).labelsSupported ? (providerFor(account).labels ?? null) : null;
}

/** Reads an account's labels from the provider and replaces the stored list (renames and deletions included). */
export async function refreshLabels(account: AccountRow) {
  const adapter = labelAdapter(account);
  if (!adapter) return false;
  const remote = await adapter.list(account);
  const db = getDb();
  const before = db.prepare("SELECT id, name, kind, color, hidden FROM labels WHERE account_id = ?").all(account.id) as {
    id: string;
    name: string;
    kind: string;
    color: string | null;
    hidden: number;
  }[];
  const known = new Map(before.map((l) => [l.id, l]));
  const changed =
    remote.length !== before.length ||
    remote.some((l) => {
      const old = known.get(l.id);
      return !old || old.name !== l.name || old.kind !== l.kind || old.color !== l.color || !!old.hidden !== l.hidden;
    });
  if (!changed) return false;
  const upsert = db.prepare(
    `INSERT INTO labels (account_id, id, name, kind, color, hidden) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, kind = excluded.kind, color = excluded.color, hidden = excluded.hidden`,
  );
  db.exec("BEGIN");
  try {
    for (const l of remote) upsert.run(account.id, l.id, l.name, l.kind, l.color, l.hidden ? 1 : 0);
    const ids = new Set(remote.map((l) => l.id));
    for (const old of before) if (!ids.has(old.id)) db.prepare("DELETE FROM labels WHERE account_id = ? AND id = ?").run(account.id, old.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

/** A label whose conversations haven't been fetched into the local copy yet (one per sync pass). */
export function labelToFill(accountId: string) {
  return (getDb().prepare("SELECT id FROM labels WHERE account_id = ? AND filled_at IS NULL ORDER BY name LIMIT 1").get(accountId) as
    | { id: string }
    | undefined)?.id;
}

export function markLabelFilled(accountId: string, id: string) {
  getDb().prepare("UPDATE labels SET filled_at = ? WHERE account_id = ? AND id = ?").run(new Date().toISOString(), accountId, id);
}

/** Labels for the sidebar and pickers, with conversation counts from the local copy. */
export function listStoredLabels(accountId: AccountScope): MailLabel[] {
  const { sql: filter, args } = scopeSql(accountId, "account_id");
  const scope = `AND ${filter}`;
  const db = getDb();
  const rows = db.prepare(`SELECT account_id, id, name, kind, color FROM labels WHERE hidden = 0 ${scope}`).all(...args) as {
    account_id: string;
    id: string;
    name: string;
    kind: LabelKind;
    color: string | null;
  }[];
  // One pass over the stored threads for every label's counts (trash and spam left out).
  const counts = db
    .prepare(
      `SELECT t.account_id, j.value AS id, COUNT(*) AS total,
         SUM(EXISTS (SELECT 1 FROM json_each(t.labels) u WHERE u.value = 'UNREAD')) AS unread
       FROM threads t, json_each(t.labels) j
       WHERE NOT EXISTS (SELECT 1 FROM json_each(t.labels) x WHERE x.value IN ('TRASH', 'SPAM')) ${scope.replace("account_id", "t.account_id")}
       GROUP BY t.account_id, j.value`,
    )
    .all(...args) as { account_id: string; id: string; total: number; unread: number }[];
  const byId = new Map(counts.map((c) => [`${c.account_id}:${c.id}`, c]));
  return rows.map((r) => {
    const c = byId.get(`${r.account_id}:${r.id}`);
    return { accountId: r.account_id, id: r.id, name: r.name, kind: r.kind, color: r.color, total: c?.total ?? 0, unread: c?.unread ?? 0 };
  });
}

/** Whether every id is one of the account's own labels (so ops can't touch system mailboxes this way). */
export function ownLabels(accountId: string, ids: string[]) {
  if (!ids.length) return true;
  const rows = getDb()
    .prepare("SELECT COUNT(*) AS n FROM labels WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))")
    .get(accountId, JSON.stringify([...new Set(ids)])) as { n: number };
  return rows.n === new Set(ids).size;
}

/** Whether a label id is one of the account's folders (filing in one moves the message). */
export function folderTest(accountId: string) {
  const rows = getDb().prepare("SELECT id FROM labels WHERE account_id = ? AND kind = 'folder'").all(accountId) as { id: string }[];
  const folders = new Set(rows.map((r) => r.id));
  return (id: string) => folders.has(id);
}

/** Label ids on the account's stored mail that aren't built-in mailboxes (for providers whose tags are free text). */
export function labelIdsOnMail(account: Pick<AccountRow, "id" | "provider">) {
  const rows = getDb()
    .prepare("SELECT DISTINCT j.value AS id FROM threads t, json_each(t.labels) j WHERE t.account_id = ?")
    .all(account.id) as { id: string }[];
  const system = providerSpec(account.provider).system;
  return rows.map((r) => r.id).filter((id) => !system.has(id));
}

/** Ids that are the user's own (not built-in mailboxes) for each account's provider. */
export function userLabelFilter() {
  const providers = new Map(listAccounts().map((a) => [a.id, providerSpec(a.provider)]));
  return (accountId: string, labels: string[]) => {
    const spec = providers.get(accountId) ?? providerSpec("gmail");
    return labels.filter((l) => !spec.system.has(l));
  };
}

// Making, renaming and deleting the user's own labels/folders. The provider's adapter does it at
// the provider (and keeps its own local index right); here the stored list and the stored mail
// follow at once, so the sidebar, lists and pickers show the change before the next sync.

function storedLabel(accountId: string, id: string): RemoteLabel | null {
  const row = getDb().prepare("SELECT id, name, kind, color, hidden FROM labels WHERE account_id = ? AND id = ?").get(accountId, id) as
    | { id: string; name: string; kind: LabelKind; color: string | null; hidden: number }
    | undefined;
  return row ? { id: row.id, name: row.name, kind: row.kind, color: row.color, hidden: !!row.hidden } : null;
}

/** The account's label adapter and its words (Gmail over IMAP says labels, like Gmail). */
function manager(account: AccountRow) {
  const adapter = labelAdapter(account);
  const spec = accountSpec({ provider: account.provider, organisesLike: providerFor(account).organisesLike?.(account.id) ?? null });
  return { adapter, spec };
}

/** The word for one kind on this account ("label", "folder"), for messages. */
const nounOf = (spec: ProviderSpec, kind: LabelKind) => spec.organise[kind]?.noun ?? spec.organise.noun;

function upsertLabel(accountId: string, l: RemoteLabel) {
  getDb()
    .prepare(
      `INSERT INTO labels (account_id, id, name, kind, color, hidden) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, kind = excluded.kind, color = excluded.color, hidden = excluded.hidden`,
    )
    .run(accountId, l.id, l.name, l.kind, l.color, l.hidden ? 1 : 0);
}

/**
 * Stored mail carrying label `from` carries `to` instead (null: nothing), message by message.
 * Returns the conversations it changed.
 */
function relabelStored(accountId: string, from: string, to: string | null) {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, data FROM threads WHERE account_id = ? AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)")
    .all(accountId, from) as { id: string; data: string }[];
  const write = db.prepare("UPDATE threads SET labels = ?, data = ? WHERE id = ?");
  for (const row of rows) {
    const thread = JSON.parse(row.data) as { messages: { labels?: string[] }[] };
    thread.messages = thread.messages.map((m) => {
      if (!m.labels?.includes(from)) return m;
      const next = new Set(m.labels.filter((l) => l !== from));
      if (to) next.add(to);
      return { ...m, labels: [...next] };
    });
    write.run(JSON.stringify([...new Set(thread.messages.flatMap((m) => m.labels ?? []))]), JSON.stringify(thread), row.id);
  }
  return rows.map((r) => r.id);
}

/** Stored labels of the same kind nested under this one (by the kind's separator). */
function childrenOf(accountId: string, label: RemoteLabel, separator: string | null): RemoteLabel[] {
  if (!separator) return [];
  const rows = getDb().prepare("SELECT id, name, kind, color, hidden FROM labels WHERE account_id = ? AND kind = ?").all(accountId, label.kind) as {
    id: string;
    name: string;
    kind: LabelKind;
    color: string | null;
    hidden: number;
  }[];
  return rows.filter((r) => r.name.startsWith(label.name + separator)).map((r) => ({ ...r, hidden: !!r.hidden }));
}

function taken(accountId: string, name: string, kind: LabelKind, except?: string) {
  return !!getDb()
    .prepare("SELECT 1 FROM labels WHERE account_id = ? AND lower(name) = lower(?) AND kind = ? AND id <> ?")
    .get(accountId, name, kind, except ?? "");
}

/** Makes a new label/folder in the provider and keeps it in the stored list. */
export async function createLabel(account: AccountRow, input: { name: string; kind: LabelKind }) {
  const { adapter, spec } = manager(account);
  const noun = nounOf(spec, input.kind);
  if (!adapter?.create || !canManage(spec, "create", input.kind)) throw new LabelError(`Kite can't make ${serviceName(account)} ${noun}s.`);
  const clean = cleanLabelName(input.name, spec, input.kind);
  if ("error" in clean) throw new LabelError(clean.error);
  if (taken(account.id, clean.name, input.kind)) throw new LabelError(`There's a ${noun} called “${clean.name}” already.`);
  const made = await adapter.create(account, { name: clean.name, kind: input.kind });
  upsertLabel(account.id, made);
  return made;
}

/** Renames a label/folder (nested ones under it move along), relabelling stored mail when ids change. */
export async function renameLabel(account: AccountRow, id: string, name: string) {
  const { adapter, spec } = manager(account);
  const label = storedLabel(account.id, id);
  if (!label) throw new LabelError("That label isn't in this account any more. Refresh and try again.");
  const noun = nounOf(spec, label.kind);
  if (!adapter?.rename || !canManage(spec, "rename", label.kind)) throw new LabelError(`Kite can't rename ${serviceName(account)} ${noun}s.`);
  const clean = cleanLabelName(name, spec, label.kind);
  if ("error" in clean) throw new LabelError(clean.error);
  if (clean.name === label.name) return label;
  if (taken(account.id, clean.name, label.kind, id)) throw new LabelError(`There's a ${noun} called “${clean.name}” already.`);
  const children = childrenOf(account.id, label, spec.organise[label.kind]?.separator ?? null);
  const renamed = await adapter.rename(account, label, clean.name);
  replaceLabel(account.id, label, renamed);
  // The provider moved the nested ones with it (IMAP RENAME; Gmail's adapter renames each). Ids
  // that are paths change, so their mail is relabelled too.
  if (children.length) {
    const now = new Map((await adapter.list(account)).map((l) => [`${l.kind}:${l.name}`, l]));
    for (const child of children) {
      const moved = now.get(`${child.kind}:${clean.name}${child.name.slice(label.name.length)}`);
      if (moved) replaceLabel(account.id, child, moved);
    }
  }
  return renamed;
}

function replaceLabel(accountId: string, before: RemoteLabel, after: RemoteLabel) {
  if (after.id !== before.id) {
    getDb().prepare("DELETE FROM labels WHERE account_id = ? AND id = ?").run(accountId, before.id);
    relabelStored(accountId, before.id, after.id);
  }
  upsertLabel(accountId, after);
}

/**
 * Deletes a label/folder in the provider. Mail keeps everything else (a tag just goes); what
 * happens to a folder's mail is the provider's (Outlook: Deleted Items; IMAP refuses a folder that
 * still holds mail).
 */
export async function deleteLabel(account: AccountRow, id: string) {
  const { adapter, spec } = manager(account);
  const label = storedLabel(account.id, id);
  if (!label) return;
  const noun = nounOf(spec, label.kind);
  if (!adapter?.remove || !canManage(spec, "remove", label.kind)) throw new LabelError(`Kite can't delete ${serviceName(account)} ${noun}s.`);
  const movedTo = await adapter.remove(account, label);
  getDb().prepare("DELETE FROM labels WHERE account_id = ? AND id = ?").run(account.id, id);
  relabelStored(account.id, id, movedTo);
}
