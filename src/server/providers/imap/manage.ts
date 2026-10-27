import "server-only";

import type { LabelKind } from "@/lib/mail/providers";
import { getDb, type AccountRow } from "../../db";
import { LabelError } from "../../mail/errors";
import type { RemoteLabel } from "../../mail/types";
import { inFolder, onConnection } from "./client";
import { folders, forgetFolders, keywordId, keywordOf, type Folder, type Folders } from "./folders";
import { labelId, labelOf } from "./gmail";

// Making, renaming and deleting an IMAP account's own folders and tags (server/labels.ts calls
// these through the provider's `labels`). Folders are CREATE / RENAME / DELETE; in Gmail mode
// the folders are Gmail's labels, so the same commands make, rename and delete labels. Keywords
// (tags) exist only on the mail that carries them: renaming or deleting one is a STORE on every
// message with it. The provider's own index (imap_copies) follows each change here, so the next
// sync finds everything where it now is.

/** A name in Kite's form ("Work/Clients") as a path on this server (its own delimiter). */
function serverPath(f: Folders, name: string) {
  const delimiter = f.all.find((folder) => folder.delimiter)?.delimiter ?? "/";
  return name.split("/").join(delimiter);
}

/** Folders or Gmail labels at and under `path`, by the server's delimiter. */
const under = (folder: string, path: string, delimiter: string) => folder === path || folder.startsWith(path + delimiter);

/** The label for a folder (a Gmail label in Gmail mode). */
function asLabel(f: Folders, folder: Folder): RemoteLabel {
  return f.gmail
    ? { id: labelId(folder.path), name: folder.name, kind: "tag", color: null, hidden: false }
    : { id: folder.id, name: folder.name, kind: "folder", color: null, hidden: false };
}

/** The folder behind a label: a user folder by id, or in Gmail mode the label's folder. */
function folderOf(f: Folders, label: RemoteLabel) {
  const folder = f.gmail ? f.byPath.get(labelOf(label.id) ?? "") : f.byId.get(label.id);
  if (!folder || folder.role) throw new LabelError(`“${label.name}” isn't on the server any more. Refresh and try again.`);
  return folder;
}

/** A keyword is an IMAP atom: no spaces or ( ) { % * " \ ] in it. */
function keywordName(name: string) {
  if (!/^[^\s(){%*"\\\]]+$/.test(name)) throw new LabelError("Tags on this account can't have spaces or ( ) { % * \" \\ ] in them.");
  return name;
}

async function refreshed(account: AccountRow) {
  forgetFolders(account.id);
  return folders(account, true);
}

export async function createLabel(account: AccountRow, { name, kind }: { name: string; kind: LabelKind }): Promise<RemoteLabel> {
  const f = await folders(account, true);
  if (kind === "tag" && !f.gmail) throw new LabelError("Tags on this account appear once some mail carries them.");
  const path = serverPath(f, name);
  if (f.byPath.has(path)) throw new LabelError(`There's a ${f.gmail ? "label" : "folder"} called “${name}” already.`);
  const made = await onConnection(account, (client) => client.mailboxCreate(path));
  const now = await refreshed(account);
  const folder = now.byPath.get(made.path) ?? now.byPath.get(path);
  if (!folder) throw new LabelError(`The server didn't keep “${name}”. Try another name.`);
  return asLabel(now, folder);
}

export async function renameLabel(account: AccountRow, label: RemoteLabel, name: string): Promise<RemoteLabel> {
  const f = await folders(account, true);
  const keyword = f.gmail ? null : keywordOf(label.id);
  if (keyword) {
    const next = keywordName(name);
    await retag(account, f, keyword, next);
    return { id: keywordId(next), name: next.replace(/^\$/, ""), kind: "tag", color: null, hidden: false };
  }
  const folder = folderOf(f, label);
  const path = serverPath(f, name);
  if (f.byPath.has(path)) throw new LabelError(`There's a ${f.gmail ? "label" : "folder"} called “${name}” already.`);
  await onConnection(account, (client) => client.mailboxRename(folder.path, path));
  // The index follows: a folder's copies (and those of folders inside it) now live at the new
  // path; in Gmail mode the messages carry the new label names.
  const db = getDb();
  const moved = (from: string) => path + from.slice(folder.path.length);
  if (f.gmail) {
    relabelCopies(account.id, (labels) => labels.map((l) => (under(l, folder.path, folder.delimiter) ? moved(l) : l)));
  } else {
    const rows = db.prepare("SELECT DISTINCT folder FROM imap_copies WHERE account_id = ?").all(account.id) as { folder: string }[];
    const update = db.prepare("UPDATE imap_copies SET folder = ? WHERE account_id = ? AND folder = ?");
    for (const { folder: from } of rows) if (under(from, folder.path, folder.delimiter)) update.run(moved(from), account.id, from);
  }
  const now = await refreshed(account);
  const renamed = now.byPath.get(path);
  if (!renamed) throw new LabelError(`The server didn't keep “${name}”. Refresh to see what it has.`);
  return asLabel(now, renamed);
}

export async function removeLabel(account: AccountRow, label: RemoteLabel): Promise<null> {
  const f = await folders(account, true);
  const keyword = f.gmail ? null : keywordOf(label.id);
  if (keyword) {
    await retag(account, f, keyword, null);
    return null;
  }
  const folder = folderOf(f, label);
  if (!f.gmail) {
    // IMAP deletes a folder's mail with it: only an empty folder with nothing inside goes.
    if (f.all.some((other) => other !== folder && under(other.path, folder.path, folder.delimiter))) {
      throw new LabelError(`“${label.name}” has folders inside it. Delete or move those first.`);
    }
    const status = await onConnection(account, (client) => client.status(folder.path, { messages: true }));
    const held = status ? (status.messages ?? 0) : 0;
    if (held) {
      throw new LabelError(`“${label.name}” still holds ${held === 1 ? "a message" : `${held} messages`}. Move ${held === 1 ? "it" : "them"} out first: deleting an IMAP folder deletes its mail.`);
    }
  }
  await onConnection(account, (client) => client.mailboxDelete(folder.path));
  // Gmail mode: the label leaves every message; the messages stay in All Mail.
  if (f.gmail) relabelCopies(account.id, (labels) => labels.filter((l) => l !== folder.path));
  await refreshed(account);
  return null;
}

/** Every message with `keyword` gets `next` instead (null: none), folder by folder, and the index follows. */
async function retag(account: AccountRow, f: Folders, keyword: string, next: string | null) {
  for (const folder of f.scan) {
    await inFolder(account, folder.path, async (client) => {
      const found = await client.search({ keyword }, { uid: true });
      const uids = Array.isArray(found) ? found : [];
      if (!uids.length) return;
      if (next) await client.messageFlagsAdd(uids, [next], { uid: true });
      await client.messageFlagsRemove(uids, [keyword], { uid: true });
    });
  }
  const db = getDb();
  const rows = db
    .prepare("SELECT folder, uid, flags FROM imap_copies WHERE account_id = ? AND EXISTS (SELECT 1 FROM json_each(flags) WHERE value = ?)")
    .all(account.id, keyword) as { folder: string; uid: number; flags: string }[];
  const update = db.prepare("UPDATE imap_copies SET flags = ? WHERE account_id = ? AND folder = ? AND uid = ?");
  for (const row of rows) {
    const flags = (JSON.parse(row.flags) as string[]).filter((flag) => flag !== keyword);
    if (next && !flags.includes(next)) flags.push(next);
    update.run(JSON.stringify(flags), account.id, row.folder, row.uid);
  }
}

/** Gmail mode: rewrites the label names stored on each copy. */
function relabelCopies(accountId: string, change: (labels: string[]) => string[]) {
  const db = getDb();
  const rows = db.prepare("SELECT folder, uid, labels FROM imap_copies WHERE account_id = ? AND labels <> '[]'").all(accountId) as { folder: string; uid: number; labels: string }[];
  const update = db.prepare("UPDATE imap_copies SET labels = ? WHERE account_id = ? AND folder = ? AND uid = ?");
  for (const row of rows) {
    const before = JSON.parse(row.labels) as string[];
    const after = change(before);
    if (after.length !== before.length || after.some((l, i) => l !== before[i])) update.run(JSON.stringify(after), accountId, row.folder, row.uid);
  }
}
