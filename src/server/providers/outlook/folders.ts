import "server-only";

import { DRAFT, INBOX, SENT, SPAM, TRASH } from "@/lib/mail/mailboxes";
import type { AccountRow } from "../../db";
import type { RemoteLabel } from "../../mail/types";
import { batchGet, GraphError, pages } from "./graph";

// Outlook keeps each message in exactly one folder. The built-in ones are Kite's mailboxes
// (Inbox is INBOX, Deleted Items is TRASH...); Archive is "archived" (no mailbox label); any
// other folder is one of the user's own, labelled by its id.

/** Graph's well-known folder names Kite maps, and what each one is in Kite. */
const MAILBOXES = {
  inbox: INBOX,
  sentitems: SENT,
  drafts: DRAFT,
  deleteditems: TRASH,
  junkemail: SPAM,
  archive: null,
} as const;
type WellKnown = keyof typeof MAILBOXES;

/** Built-in folders that are never the user's own (and whose mail Kite doesn't list). */
const HIDDEN = ["outbox", "conversationhistory", "clutter", "syncissues", "recoverableitemsdeletions", "scheduled", "searchfolders"];

export type Folders = {
  /** Folder id for each well-known folder (null when the mailbox has none). */
  ids: Record<WellKnown, string | null>;
  /** Folder id -> Kite mailbox label (null for Archive). */
  mailbox: Map<string, string | null>;
  /** Built-in folders that aren't mailboxes in Kite (Outbox, Conversation History...). */
  hidden: Set<string>;
};

const g = globalThis as typeof globalThis & { __kiteOutlookFolders?: Map<string, Promise<Folders>> };
const cache = (g.__kiteOutlookFolders ??= new Map());

/** The account's built-in folders, looked up once per server process (one batched request). */
export function folders(account: Pick<AccountRow, "id">): Promise<Folders> {
  let found = cache.get(account.id);
  if (!found) {
    found = (async () => {
      const names = Object.keys(MAILBOXES) as WellKnown[];
      const answers = await batchGet(account.id, [...names, ...HIDDEN].map((n) => `/me/mailFolders/${n}?$select=id`));
      if (answers.some((a) => a.status >= 500 || a.status === 429 || a.status === 401)) throw new GraphError("Outlook folders couldn't be read", 503);
      // A folder this mailbox doesn't have answers 404 (or 400 for names it doesn't know).
      const idOf = (i: number) => (answers[i]?.status === 200 ? ((answers[i].body as { id?: string })?.id ?? null) : null);
      const ids = Object.fromEntries(names.map((n, i) => [n, idOf(i)])) as Folders["ids"];
      const hidden = HIDDEN.map((_, i) => idOf(names.length + i)).filter((id): id is string => !!id);
      const mailbox = new Map(names.flatMap((n) => (ids[n] ? [[ids[n]!, MAILBOXES[n]] as const] : [])));
      return { ids, mailbox, hidden: new Set(hidden) };
    })();
    cache.set(account.id, found);
    // A failed lookup is tried again next time.
    found.catch(() => cache.delete(account.id));
  }
  return found;
}

/** Kite's mailbox label for a folder: INBOX, SENT..., null for Archive, or the folder's own id. */
export function folderLabel(f: Folders, folderId: string | undefined): string | null {
  if (!folderId) return null;
  if (f.mailbox.has(folderId)) return f.mailbox.get(folderId) ?? null;
  return f.hidden.has(folderId) ? null : folderId;
}

type GraphFolder = { id: string; displayName: string; childFolderCount?: number; isHidden?: boolean };

/**
 * The user's own folders, nested names joined with "/". Folders inside Inbox count (Outlook users
 * often file mail there, shown as "Inbox/Clients"); the other built-in folders' children don't.
 */
export async function listUserFolders(account: AccountRow): Promise<RemoteLabel[]> {
  const f = await folders(account);
  const out: RemoteLabel[] = [];
  const builtIn = new Set([...f.mailbox.keys(), ...f.hidden]);
  const walk = async (path: string, parent: string | null, depth: number) => {
    const list = await pages<GraphFolder>(
      account.id,
      `${parent ? `/me/mailFolders/${parent}/childFolders` : "/me/mailFolders"}?$top=100&$select=id,displayName,childFolderCount,isHidden`,
      1000,
    );
    for (const folder of list) {
      const name = path ? `${path}/${folder.displayName}` : folder.displayName;
      const isBuiltIn = builtIn.has(folder.id);
      if (!isBuiltIn) out.push({ id: folder.id, name, kind: "folder", color: null, hidden: !!folder.isHidden });
      const descend = (!isBuiltIn || folder.id === f.ids.inbox) && (folder.childFolderCount ?? 0) > 0 && depth < 6;
      if (descend) await walk(isBuiltIn ? "Inbox" : name, folder.id, depth + 1);
    }
  };
  await walk("", null, 0);
  return out;
}
