import "server-only";

import type { ListResponse } from "imapflow";
import { DRAFT, INBOX, SENT, SPAM, TRASH } from "@/lib/mail/mailboxes";
import type { AccountRow } from "../../db";
import { onConnection } from "./client";
import { presetOf } from "./servers";

// An IMAP account's folders. The built-in ones are found by their SPECIAL-USE flag (or, on servers
// without it, by common names, which imapflow matches) and become Kite's mailboxes; the user's own
// become labels of kind "folder". Folder ids are the path, base64url-encoded so they fit REMOTE_ID.
// Virtual folders (Gmail-style All Mail, Flagged, Important) are skipped: they'd repeat every message.
// Gmail is the exception (gmail.ts): Kite reads All Mail, Trash and Spam only, and the other folders
// are labels (tags) read from each message.

type Role = "inbox" | "sent" | "drafts" | "trash" | "junk" | "archive" | "all";

export type Folder = { path: string; name: string; delimiter: string; role: Role | null; id: string };

export type Folders = {
  all: Folder[];
  /** Built-in folders by role (missing on servers without one). */
  role: Partial<Record<Role, Folder>>;
  byPath: Map<string, Folder>;
  byId: Map<string, Folder>;
  /** Gmail over IMAP: labels are tags on each message, and only `scan` holds mail. */
  gmail: boolean;
  /** The folders Kite reads mail from: every folder, or Gmail's All Mail, Trash and Spam. */
  scan: Folder[];
};

const READ_MS = 10 * 60_000;
const SPECIAL: Record<string, Role> = {
  "\\Inbox": "inbox",
  "\\Sent": "sent",
  "\\Drafts": "drafts",
  "\\Trash": "trash",
  "\\Junk": "junk",
  "\\Archive": "archive",
  "\\All": "all",
};
const VIRTUAL = new Set(["\\All", "\\Flagged", "\\Important"]);

const encode = (value: string) => Buffer.from(value, "utf8").toString("base64url");

/** A folder's label id, from its path. */
const folderId = (path: string) => `f-${encode(path)}`;
/** A keyword's label id (a tag). */
export const keywordId = (keyword: string) => `k-${encode(keyword)}`;
export const keywordOf = (id: string) => (id.startsWith("k-") ? Buffer.from(id.slice(2), "base64url").toString("utf8") : null);
export const isFolderId = (id: string) => id.startsWith("f-");

const g = globalThis as typeof globalThis & { __kiteImapFolders?: Map<string, { at: number; folders: Promise<Folders> }> };
const cache = (g.__kiteImapFolders ??= new Map());

function build(list: ListResponse[], gmail: boolean): Folders {
  const all: Folder[] = [];
  for (const f of list) {
    if (f.flags.has("\\Noselect") || f.flags.has("\\NonExistent")) continue;
    // Some servers flag Gmail's Important only in the folder's flags, not as its special use.
    const virtual = [f.specialUse, ...f.flags].find((flag) => flag && VIRTUAL.has(flag));
    if (virtual && !(gmail && virtual === "\\All")) continue;
    const role = f.path.toUpperCase() === "INBOX" ? "inbox" : f.specialUse ? (SPECIAL[f.specialUse] ?? null) : null;
    all.push({ path: f.path, name: f.path.split(f.delimiter || "/").join("/"), delimiter: f.delimiter || "/", role, id: role ? "" : folderId(f.path) });
  }
  const role: Folders["role"] = {};
  // The first folder with a role keeps it (servers can flag two as \Sent).
  for (const f of all) if (f.role && !role[f.role]) role[f.role] = f;
  for (const f of all) if (f.role && role[f.role] !== f) Object.assign(f, { role: null, id: folderId(f.path) });
  const scan = gmail ? [role.all, role.trash, role.junk].filter((f): f is Folder => !!f) : all;
  return { all, role, byPath: new Map(all.map((f) => [f.path, f])), byId: new Map(all.filter((f) => f.id).map((f) => [f.id, f])), gmail, scan };
}

/** The account's folders, read from the server at most every 10 minutes (`fresh` reads them now). */
export function folders(account: Pick<AccountRow, "id">, fresh = false): Promise<Folders> {
  const hit = cache.get(account.id);
  if (hit && !fresh && Date.now() - hit.at < READ_MS) return hit.folders;
  const gmail = presetOf(account.id) === "gmail";
  const folders = onConnection(account, (client) => client.list()).then((list) => build(list, gmail));
  cache.set(account.id, { at: Date.now(), folders });
  folders.catch(() => cache.delete(account.id));
  return folders;
}

export function forgetFolders(accountId: string) {
  cache.delete(accountId);
}

/** The Kite label a copy in this folder carries: a mailbox for built-in folders, the folder's id for the user's own; none for Archive. */
export function folderLabel(folder: Folder | undefined): string | null {
  if (!folder) return null;
  switch (folder.role) {
    case "inbox":
      return INBOX;
    case "sent":
      return SENT;
    case "drafts":
      return DRAFT;
    case "trash":
      return TRASH;
    case "junk":
      return SPAM;
    case "archive":
    case "all":
      return null;
    default:
      return folder.id;
  }
}

/** Folders whose mail stays out of lists unless asked for (like spam and trash elsewhere). */
export const outOfSight = (folder: Folder | undefined) => folder?.role === "trash" || folder?.role === "junk";
