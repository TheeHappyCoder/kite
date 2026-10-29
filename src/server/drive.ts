import "server-only";

import { createHash } from "node:crypto";
import { bytesOf, DRIVE_FOLDER_INFO, driveEntries, driveFolders, peopleGroups, previewTree, runnable, splitGroup, type DriveEntry, type DriveFile, type DriveGroup, type DrivePrefs } from "@/lib/drive";
import { attachmentKind } from "@/lib/mail/attachments";
import { accountName, type Attachment, type Contact } from "@/lib/mail/types";
import { spacePath } from "@/lib/spaces";
import { acquaintance } from "./contacts";
import { getDb, listAccounts } from "./db";
import { listPeople } from "./people";
import { getPreferences } from "./settings";
import { listSpaces } from "./spaces";
import { searchThreads } from "./store";

// The whole Kite drive tree for the desktop shell (src-tauri/src/drive.rs), from the local copy only:
// one pass over the stored threads' slim copies, then the user's building blocks, each split by its
// levels (lib/drive.ts).

/** Plenty for a saved-search folder; older matches stay in Kite. */
const SEARCH_LIMIT = 2000;

function storedFiles() {
  const accounts = listAccounts();
  const own = new Set(accounts.map((a) => a.email.toLowerCase()));
  const names = new Map(accounts.map((a) => [a.id, accountName({ email: a.email, name: a.name, nickname: a.nickname ?? undefined })]));
  const rows = getDb()
    .prepare(
      `SELECT t.id AS threadId, t.account_id AS accountId, t.labels AS labels, json_extract(m.value, '$.id') AS messageId,
         json_extract(m.value, '$.date') AS date, json_extract(m.value, '$.from') AS sender,
         json_extract(m.value, '$.to') AS recipients, json_extract(m.value, '$.cc') AS copied, a.value AS attachment
       FROM threads t, json_each(t.list_data, '$.messages') m, json_each(m.value, '$.attachments') a
       WHERE NOT EXISTS (SELECT 1 FROM json_each(t.labels) x WHERE x.value IN ('TRASH', 'SPAM'))
         AND COALESCE(json_extract(m.value, '$.draft'), 0) = 0
         AND COALESCE(json_extract(a.value, '$.inline'), 0) = 0 AND json_extract(a.value, '$.partId') IS NOT NULL`,
    )
    .all() as { threadId: string; accountId: string; labels: string; messageId: string; date: string; sender: string; recipients: string | null; copied: string | null; attachment: string }[];
  const labels = new Map<string, string[]>();
  const safe = rows.filter((r) => !runnable((JSON.parse(r.attachment) as Attachment).name));
  const files = safe.map((r): DriveFile => {
    const a = JSON.parse(r.attachment) as Attachment;
    const from = JSON.parse(r.sender) as Contact;
    const mine = own.has(from.email.toLowerCase());
    const to = [...(JSON.parse(r.recipients ?? "[]") as Contact[]), ...(JSON.parse(r.copied ?? "[]") as Contact[])];
    if (!labels.has(r.threadId)) labels.set(r.threadId, JSON.parse(r.labels) as string[]);
    return {
      accountId: r.accountId,
      threadId: r.threadId,
      messageId: r.messageId,
      partId: a.partId!,
      name: a.name,
      bytes: a.bytes ?? bytesOf(a.size),
      date: r.date,
      people: (mine ? to : [from]).filter((p) => !own.has(p.email.toLowerCase())),
      sender: mine ? "You" : from.name || from.email,
      kind: attachmentKind(a.name, a.mimeType),
      account: names.get(r.accountId) ?? r.accountId,
    };
  });
  return { files, labels };
}

/** The tree's groups: each building block's folders, split inside by its levels. */
function driveGroups(drive: DrivePrefs): DriveGroup[] {
  const prefs = getPreferences();
  const { files, labels } = storedFiles();
  const groups: DriveGroup[] = [];
  const top = new Set<string>();
  for (const block of driveFolders(drive)) {
    if (!block.on) continue;
    const root = DRIVE_FOLDER_INFO[block.kind].name;
    if (root) top.add(root.toLowerCase());
    const split = (dir: string[], list: DriveFile[]) => groups.push(...splitGroup(dir, list, block.levels, drive.splitOver));
    if (block.kind === "people") {
      const vips = listPeople();
      const keep =
        drive.people === "vips" ? (email: string) => !!vips[email]?.vip
        : drive.people === "written" ? (email: string) => acquaintance(email).sent > 0
        : () => true;
      for (const g of peopleGroups(files, keep)) split([root, ...g.dir], g.files);
    } else if (block.kind === "months") {
      // By date's levels are its folders: the first always splits, the rest by size.
      groups.push(...splitGroup([root], files, block.levels, drive.splitOver, true));
    } else if (block.kind === "spaces") {
      const spaces = listSpaces();
      const items = getDb().prepare("SELECT space_id AS space, ref FROM space_items WHERE kind = 'thread'").all() as { space: string; ref: string }[];
      for (const space of spaces) {
        const threads = new Set(items.filter((i) => i.space === space.id).map((i) => i.ref));
        // Every space is a folder (pockets inside it), even before it holds files.
        split([root, ...spacePath(spaces, space.id).map((s) => s.name)], files.filter((f) => threads.has(f.threadId)));
      }
    } else if (block.kind === "labels") {
      const rows = getDb().prepare("SELECT account_id AS account, id, name FROM labels WHERE hidden = 0").all() as { account: string; id: string; name: string }[];
      const accounts = new Set(rows.map((r) => r.account)).size;
      const emails = new Map(listAccounts().map((a) => [a.id, a.email]));
      for (const label of rows) {
        const list = files.filter((f) => f.accountId === label.account && labels.get(f.threadId)?.includes(label.id));
        if (!list.length) continue;
        split([root, label.name.replace(/\//g, " - ") + (accounts > 1 ? ` (${emails.get(label.account) ?? label.account})` : "")], list);
      }
    } else {
      for (const id of drive.searches) {
        const search = prefs.savedSearches.find((s) => s.id === id);
        // A saved search named like a building block stays out rather than mixing into it.
        if (!search || top.has(search.name.toLowerCase())) continue;
        top.add(search.name.toLowerCase());
        const threads = new Set(searchThreads(search.query, "all", SEARCH_LIMIT).map((t) => t.id));
        split([search.name], files.filter((f) => threads.has(f.threadId)));
      }
    }
  }
  return groups;
}

export function driveTree(): { version: string; entries: DriveEntry[] } {
  const entries = driveEntries(driveGroups(getPreferences().drive));
  const version = createHash("sha1").update(JSON.stringify(entries)).digest("hex");
  return { version, entries };
}

/** Settings' preview: the same tree, small, whether or not the drive is on. */
export function drivePreview() {
  return previewTree(driveEntries(driveGroups(getPreferences().drive)));
}
