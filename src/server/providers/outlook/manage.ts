import "server-only";

import type { LabelKind } from "@/lib/mail/providers";
import { getDb, type AccountRow } from "../../db";
import { LabelError } from "../../mail/errors";
import type { LabelChange, RemoteLabel } from "../../mail/types";
import { folders, listUserFolders } from "./folders";
import { GraphError, graph, pages } from "./graph";
import { canEditCategories } from "./oauth";

// Making, renaming and deleting an Outlook account's own folders and categories (server/labels.ts
// calls these through the provider's `labels`). Folders nest by parent, so "Clients/2026" is made
// inside "Clients" (and "Inbox/x" inside the Inbox). Folder ids never change, so a rename keeps
// every message's label. Categories live in the mailbox's list (masterCategories, which needs
// MailboxSettings.ReadWrite) and as names on messages; Graph can't rename one.

type GraphFolder = { id: string; displayName: string };
type Category = { id: string; displayName: string; color?: string };

const leaf = (name: string) => name.split("/").pop() ?? name;
const parentPath = (name: string) => name.split("/").slice(0, -1).join("/");

/** The folder a path goes in: the mailbox's top level, the Inbox, or one of the user's folders. */
async function parentOf(account: AccountRow, name: string) {
  const parent = parentPath(name);
  if (!parent) return null;
  if (parent === "Inbox") return (await folders(account)).ids.inbox;
  const found = (await listUserFolders(account)).find((f) => f.name === parent);
  if (!found) throw new LabelError(`There's no folder called “${parent}” to put it in.`);
  return found.id;
}

async function makeFolder(account: AccountRow, name: string): Promise<RemoteLabel> {
  const parent = await parentOf(account, name);
  const made = await clash(
    graph<GraphFolder>(account.id, parent ? `/me/mailFolders/${parent}/childFolders` : "/me/mailFolders", { method: "POST", body: { displayName: leaf(name) } }),
    name,
  );
  return { id: made.id, name, kind: "folder", color: null, hidden: false };
}

async function renameFolder(account: AccountRow, label: RemoteLabel, name: string): Promise<RemoteLabel> {
  // A different parent moves the folder there first.
  if (parentPath(name) !== parentPath(label.name)) {
    const destinationId = (await parentOf(account, name)) ?? "msgfolderroot";
    await clash(graph(account.id, `/me/mailFolders/${label.id}/move`, { method: "POST", body: { destinationId } }), name);
  }
  if (leaf(name) !== leaf(label.name)) {
    await clash(graph(account.id, `/me/mailFolders/${label.id}`, { method: "PATCH", body: { displayName: leaf(name) } }), name);
  }
  return { ...label, name };
}

/** Outlook keeps a deleted folder's mail in Deleted Items: Kite deletes only folders with nothing in them. */
async function removeFolder(account: AccountRow, label: RemoteLabel) {
  const folder = await graph<{ totalItemCount?: number; childFolderCount?: number }>(account.id, `/me/mailFolders/${label.id}?$select=totalItemCount,childFolderCount`);
  if (folder.childFolderCount) throw new LabelError(`“${label.name}” has folders inside it. Delete or move those first.`);
  const held = folder.totalItemCount ?? 0;
  if (held) throw new LabelError(`“${label.name}” still holds ${held === 1 ? "a message" : `${held} messages`}. Move ${held === 1 ? "it" : "them"} out first.`);
  await graph(account.id, `/me/mailFolders/${label.id}`, { method: "DELETE" });
}

function needsCategories(account: AccountRow) {
  if (!canEditCategories(account.id)) throw new LabelError("Reconnect this account in Settings → Accounts so Kite can make and delete Outlook categories.");
}

/** Outlook's colour presets, picked by name so a new category always gets the same one. */
const presetFor = (name: string) => `preset${[...name].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 25, 7)}`;

async function makeCategory(account: AccountRow, name: string): Promise<RemoteLabel> {
  needsCategories(account);
  await clash(graph<Category>(account.id, "/me/outlook/masterCategories", { method: "POST", body: { displayName: name, color: presetFor(name) } }), name);
  return { id: name, name, kind: "tag", color: null, hidden: false };
}

/**
 * Deletes the category from the mailbox's list and takes it off the stored mail carrying it (a
 * category left on a message would come back as a name on mail). Mail Kite hasn't stored keeps it.
 */
async function removeCategory(account: AccountRow, label: RemoteLabel, modify: (ids: string[], change: LabelChange) => Promise<void>) {
  needsCategories(account);
  const master = await pages<Category>(account.id, "/me/outlook/masterCategories", 500);
  const found = master.find((c) => c.displayName === label.name);
  if (found) await graph(account.id, `/me/outlook/masterCategories/${found.id}`, { method: "DELETE" });
  const rows = getDb()
    .prepare("SELECT data FROM threads WHERE account_id = ? AND EXISTS (SELECT 1 FROM json_each(labels) WHERE value = ?)")
    .all(account.id, label.id) as { data: string }[];
  const ids = rows.flatMap((r) => (JSON.parse(r.data) as { messages: { id: string; labels?: string[] }[] }).messages.filter((m) => m.labels?.includes(label.id)).map((m) => m.id));
  if (ids.length) await modify(ids, { add: [], remove: [label.id] });
}

/** Graph's "already exists" answers as a plain line. */
async function clash<T>(request: Promise<T>, name: string) {
  try {
    return await request;
  } catch (error) {
    if (error instanceof GraphError && (error.status === 409 || error.code === "ErrorFolderExists" || error.code === "ErrorDuplicateCategory")) {
      throw new LabelError(`Outlook already has “${name}”.`);
    }
    throw error;
  }
}

/** The provider's `labels` create / rename / remove; `modify` is its MailAdapter's modifyMessages. */
export function manageLabels(modify: (account: AccountRow, ids: string[], change: LabelChange) => Promise<void>) {
  return {
    create: (account: AccountRow, { name, kind }: { name: string; kind: LabelKind }) => (kind === "folder" ? makeFolder(account, name) : makeCategory(account, name)),
    async rename(account: AccountRow, label: RemoteLabel, name: string) {
      if (label.kind !== "folder") throw new LabelError("Outlook can't rename a category. Make a new one and delete this one.");
      return renameFolder(account, label, name);
    },
    async remove(account: AccountRow, label: RemoteLabel) {
      if (label.kind === "folder") await removeFolder(account, label);
      else await removeCategory(account, label, (ids, change) => modify(account, ids, change));
      return null;
    },
  };
}
