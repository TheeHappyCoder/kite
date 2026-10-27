import "server-only";

import type { FetchMessageObject, ImapFlow, SearchObject } from "imapflow";
import { labelNamed, toGmailQuery, type SearchTerm } from "@/lib/mail/search";
import { CursorExpired } from "../../mail/errors";
import type { AccountRow } from "../../db";
import type { ThreadList } from "../../mail/types";
import { inFolder, onConnection } from "./client";
import type { Copy } from "./mirror";
import { folders, isFolderId, keywordId, keywordOf, outOfSight, type Folder, type Folders } from "./folders";
import {
  copiesIn,
  dropCopies,
  dropFolder,
  FETCH_HEADERS,
  keyOf,
  labelsOf,
  messageRow,
  messagesWithFiles,
  setCategories,
  setCopyFlags,
  setSnippet,
  storeCopy,
  storedKeywords,
  threadsOf,
  type Meta,
} from "./mirror";
import { isGmail, labelOf, RAW, TABS, TABS_EVERY_MS, withLabel } from "./gmail";

// Reading an IMAP mailbox into the index (mirror.ts): lists (newest N of a folder, searches) and
// the change feed. The cursor is each folder's UIDVALIDITY, UIDNEXT, message and unread counts and
// HIGHESTMODSEQ (servers with CONDSTORE); one LIST-STATUS per check tells which folders moved.
// In a folder that moved: UIDs from the old UIDNEXT are new; flags come from CHANGEDSINCE (or are
// read again for the copies Kite has); a count that doesn't add up means something was expunged,
// found with one UID SEARCH. A changed UIDVALIDITY means the folder's UIDs are new: its copies are
// dropped and its newest mail read again. Gmail mode (gmail.ts) does the same for All Mail, Trash and
// Spam only, with each copy's X-GM-LABELS read alongside its flags, and lists from Gmail's own search.

type FolderState = { v: string; n: number; c: number; u?: number; m?: string };
/** Folder states, and (Gmail) when the Inbox was last sorted into tabs. */
type Cursor = { f: Record<string, FolderState>; tabs?: number; flags?: number };

const META_QUERY = { uid: true, flags: true, envelope: true, bodyStructure: true, internalDate: true, size: true, headers: FETCH_HEADERS };
const GMAIL_QUERY = { ...META_QUERY, labels: true, threadId: true };
const CHUNK = 100;
/** Newest messages read again from a folder whose UIDVALIDITY changed. */
const REFILL = 200;
const SNIPPET_BYTES = 2048;
/** HTML mail often opens with kilobytes of styles: read this much when the first slice had no text. */
const SNIPPET_BYTES_HTML = 32_768;

/** Gmail mode: how often Trash and Spam have their flags read while their counts stay put. */
const GMAIL_FLAGS_EVERY_MS = 5 * 60_000;

const flagsOf = (m: FetchMessageObject) => [...(m.flags ?? [])].sort();

/**
 * Fetches metadata for UIDs in the open folder and stores each copy. Returns the touched threads, message ids and UIDs.
 * `from`: only UIDs from there (`n:*` also answers with the last message when nothing is newer).
 */
export async function fetchInto(client: ImapFlow, accountId: string, folder: string, uids: number[] | string, from = 0) {
  const box = client.mailbox;
  const uidValidity = box ? String(box.uidValidity) : "0";
  const range = Array.isArray(uids) ? uids.join(",") : uids;
  if (!range) return { threads: [] as string[], ids: [] as string[], uids: [] as number[] };
  const gmail = isGmail(accountId);
  const found = (await client.fetchAll(range, gmail ? GMAIL_QUERY : META_QUERY, { uid: true })).filter((m) => m.uid >= from);
  const threads = new Set<string>();
  const ids: string[] = [];
  for (const m of found) {
    storeCopy(accountId, folder, uidValidity, m, flagsOf(m), gmail).forEach((t) => threads.add(t));
    ids.push(keyOf(m, folder, uidValidity, gmail));
  }
  await fillSnippets(client, accountId, found, uidValidity, folder, gmail);
  return { threads: [...threads], ids, uids: found.map((m) => m.uid) };
}

/** Short previews for list rows: the first bytes of each new message's text part, decoded here. */
async function fillSnippets(client: ImapFlow, accountId: string, found: FetchMessageObject[], uidValidity: string, folder: string, gmail: boolean) {
  const byPart = new Map<string, { uid: number; id: string; meta: Meta }[]>();
  for (const m of found) {
    const id = keyOf(m, folder, uidValidity, gmail);
    const row = messageRow(accountId, id);
    if (!row || row.parsed.snippet) continue;
    const part = row.parsed.text ?? row.parsed.html;
    if (!part) continue;
    byPart.set(part, [...(byPart.get(part) ?? []), { uid: m.uid, id, meta: row.parsed }]);
  }
  for (const [part, list] of byPart) {
    // Styles fill the first slice of some HTML mail (banks, newsletters): those get one bigger read.
    let pending = list;
    for (const maxLength of [SNIPPET_BYTES, SNIPPET_BYTES_HTML]) {
      if (!pending.length) break;
      const got = await client.fetchAll(pending.map((l) => l.uid).join(","), { uid: true, bodyParts: [{ key: part, maxLength }] }, { uid: true });
      const again: typeof list = [];
      for (const m of got) {
        const item = pending.find((l) => l.uid === m.uid);
        const raw = m.bodyParts?.get(part);
        if (!item || !raw) continue;
        const info = item.meta.parts.find((p) => p.part === part);
        const text = decodePart(raw, info?.encoding, info?.charset);
        const snippet = snippetOf(info?.type === "text/html" ? htmlText(text) : text);
        if (!snippet && raw.length >= maxLength && maxLength < SNIPPET_BYTES_HTML) again.push(item);
        else setSnippet(accountId, item.id, snippet);
      }
      pending = again;
    }
  }
}

/** A body part's bytes as text: transfer encoding undone, then its charset (a cut-off end is fine). */
function decodePart(raw: Buffer, encoding?: string, charset?: string) {
  let bytes = raw;
  const enc = (encoding ?? "").toLowerCase();
  if (enc === "base64") {
    const clean = raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, "");
    bytes = Buffer.from(clean.slice(0, clean.length - (clean.length % 4)), "base64");
  } else if (enc === "quoted-printable") {
    const qp = raw.toString("latin1").replace(/=\r?\n/g, "");
    const out: number[] = [];
    for (let i = 0; i < qp.length; i++) {
      const hex = qp[i] === "=" ? qp.slice(i + 1, i + 3) : "";
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
      } else out.push(qp.charCodeAt(i) & 0xff);
    }
    bytes = Buffer.from(out);
  }
  try {
    return new TextDecoder(charset || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** The readable text of an HTML slice that may be cut off anywhere (an unclosed style or comment runs to the end). */
const htmlText = (html: string) =>
  html
    .replace(/<!--[\s\S]*?(-->|$)/g, " ")
    .replace(/<(style|script|head|title)\b[\s\S]*?(<\/\1\s*>|$)/gi, " ")
    .replace(/<[^>]*$/, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

const snippetOf = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200);

/** The newest `max` messages of a folder (by sequence number, so no SEARCH is needed). */
async function newestOf(account: AccountRow, folder: Folder, max: number, onIds?: (ids: string[]) => void) {
  return inFolder(account, folder.path, async (client) => {
    const exists = client.mailbox ? client.mailbox.exists : 0;
    const ids: string[] = [];
    for (let top = exists; top >= 1 && ids.length < max; top -= CHUNK) {
      const from = Math.max(1, top - CHUNK + 1, exists - max + 1);
      const seq = await client.fetchAll(`${from}:${top}`, { uid: true }, {});
      const got = await fetchInto(client, account.id, folder.path, seq.map((m) => m.uid));
      ids.push(...got.ids);
      onIds?.(got.ids);
      if (from === Math.max(1, exists - max + 1)) break;
    }
    return ids;
  });
}

/** UIDs matching a search in a folder, newest `max` of them, fetched into the index (`then` runs on them before the lock goes). */
async function searchIn(account: AccountRow, folder: Folder, query: SearchObject, max: number, then?: (client: ImapFlow, uids: number[]) => Promise<unknown>) {
  return inFolder(account, folder.path, async (client) => {
    if (!client.mailbox || !client.mailbox.exists) return [];
    const uids = ((await client.search(query, { uid: true })) || []).sort((a, b) => b - a).slice(0, max);
    const { ids } = await fetchInto(client, account.id, folder.path, uids);
    await then?.(client, uids);
    return ids;
  });
}

const visible = (f: Folders) => f.scan.filter((folder) => !outOfSight(folder));

/** A search as IMAP SEARCH keys, and the folders it covers. Terms IMAP can't search (files) are checked by Kite on the results. */
function toImap(terms: SearchTerm[], f: Folders, accountId: string): { query: SearchObject; folders: Folder[] } {
  const and: SearchObject[] = [];
  let scope: Folder[] | null = null;
  const labels = [
    ...f.all.filter((folder) => !folder.role).map((folder) => ({ id: folder.id, name: folder.name })),
    ...storedKeywords(accountId).map((k) => ({ id: keywordId(k), name: k.replace(/^\$/, "") })),
  ];
  /** A term as one SEARCH key, or null when IMAP can't say it (in: and label: folders are scopes, set below). */
  const keyOf = (t: SearchTerm): SearchObject | null => {
    switch (t.field) {
      case "any": {
        const sides = (t.any ?? []).map((s) => {
          const k = keyOf(s);
          return k && s.negate ? { not: k } : k;
        });
        return sides.length > 1 && sides.every(Boolean) ? { or: sides as SearchObject[] } : null;
      }
      case "text":
        return { text: t.value };
      case "from":
        return { from: t.value };
      case "to":
        return { or: [{ to: t.value }, { cc: t.value }] };
      case "subject":
        return { subject: t.value };
      case "before":
        return { before: new Date(t.value) };
      case "after":
        return { since: new Date(t.value) };
      case "is":
        return t.value === "unread" ? { seen: false } : t.value === "read" ? { seen: true } : t.value === "starred" ? { flagged: true } : null;
      default:
        return null;
    }
  };
  for (const t of terms) {
    let key: SearchObject | null = keyOf(t);
    switch (t.field) {
      case "in": {
        if (t.negate) break;
        const role = { inbox: "inbox", sent: "sent", drafts: "drafts", archive: "archive", trash: "trash", spam: "junk" }[t.value as string] as Folder["role"] | undefined;
        scope = t.value === "anywhere" ? f.all : role && f.role[role] ? [f.role[role]!] : [];
        break;
      }
      case "label": {
        const label = labels.find((l) => labelNamed(l.name, t.value));
        if (!label) {
          scope = t.negate ? scope : [];
          break;
        }
        if (isFolderId(label.id)) {
          if (!t.negate) scope = f.byId.get(label.id) ? [f.byId.get(label.id)!] : [];
        } else key = { keyword: keywordOf(label.id) ?? "" };
        break;
      }
      default:
        break;
    }
    if (key) and.push(t.negate ? { not: key } : key);
  }
  const query: SearchObject = and.length ? Object.assign({}, ...and.filter((k) => !("or" in k) && !("not" in k))) : { all: true };
  // Keys that can't be merged into one object (or / not) are nested one at a time.
  const nested = and.filter((k) => "or" in k || "not" in k);
  let merged: SearchObject = query;
  // One OR per query: a second one is left out (a wider search; Kite checks the results it stores against the whole query).
  for (const k of nested) merged = "or" in k ? (merged.or ? merged : { ...merged, or: k.or }) : { ...merged, not: { ...(merged.not ?? {}), ...k.not } };
  return { query: merged, folders: scope ?? visible(f) };
}

/** Message ids for a Kite list, newest first per folder, fetched into the index as they're found. */
export async function scanList(account: AccountRow, list: ThreadList, max: number, onIds?: (ids: string[]) => void): Promise<string[]> {
  const f = await folders(account);
  const collect = async (pairs: [Folder, SearchObject | null][], perFolder: number) => {
    const ids: string[] = [];
    for (const [folder, query] of pairs) {
      if (ids.length >= max) break;
      const got = query ? await searchIn(account, folder, query, Math.min(perFolder, max - ids.length)) : await newestOf(account, folder, Math.min(perFolder, max - ids.length));
      ids.push(...got);
      onIds?.(got);
    }
    return ids;
  };
  if (f.gmail) return gmailList(account, f, list, max, collect, onIds);
  switch (list.kind) {
    case "mailbox": {
      if (list.mailbox === "starred") return collect(visible(f).map((folder) => [folder, { flagged: true }]), max);
      const folder = f.role[list.mailbox === "inbox" ? "inbox" : list.mailbox === "sent" ? "sent" : "drafts"];
      return folder ? newestOf(account, folder, max, onIds) : [];
    }
    case "recent": {
      const since = new Date(Date.now() - list.days * 86_400_000);
      return collect(visible(f).map((folder) => [folder, { since }]), max);
    }
    case "attachments":
      // IMAP can't search for files; the index knows which messages have them.
      return messagesWithFiles(account.id, max);
    case "label": {
      const folder = f.byId.get(list.id);
      if (folder) return newestOf(account, folder, max, onIds);
      const keyword = keywordOf(list.id);
      return keyword ? collect(visible(f).map((fd) => [fd, { keyword }]), max) : [];
    }
    case "search": {
      const { query, folders: scope } = toImap(list.terms, f, account.id);
      return collect(scope.map((folder) => [folder, query]), 50);
    }
    case "inboxFrom": {
      const inbox = f.role.inbox;
      return inbox ? collect([[inbox, { from: list.email }]], max) : [];
    }
  }
}

type Collect = (pairs: [Folder, SearchObject | null][], perFolder: number) => Promise<string[]>;

/** A Kite list on Gmail: X-GM-RAW in All Mail (Trash and Spam hold what's left out of All Mail). */
async function gmailList(account: AccountRow, f: Folders, list: ThreadList, max: number, collect: Collect, onIds?: (ids: string[]) => void): Promise<string[]> {
  const all = f.role.all;
  if (!all) return [];
  switch (list.kind) {
    case "mailbox": {
      if (list.mailbox !== "inbox") return collect([[all, { gmraw: RAW[list.mailbox] }]], max);
      // The Inbox is sorted into tabs as it's read, so a first sync files each conversation in its tab from the start.
      const ids = await searchIn(account, all, { gmraw: RAW.inbox }, max, (client, uids) => sortIntoTabs(client, account.id, all.path, uids));
      onIds?.(ids);
      return ids;
    }
    case "recent":
      return collect([[all, { since: new Date(Date.now() - list.days * 86_400_000) }]], max);
    case "attachments":
      return messagesWithFiles(account.id, max);
    case "label": {
      const name = labelOf(list.id);
      return name ? collect([[all, withLabel(name)]], max) : [];
    }
    case "search": {
      // Gmail searches the folder it's in: in:trash and in:spam are those folders, in:anywhere all three.
      const where = list.terms.find((t) => t.field === "in" && !t.negate)?.value;
      const scope = where === "trash" ? [f.role.trash] : where === "spam" ? [f.role.junk] : where === "anywhere" ? f.scan : [all];
      // `label:` names the label exactly as Gmail has it; a label the account doesn't have finds nothing.
      const names = f.all.filter((folder) => !folder.role).map((folder) => folder.path);
      const terms = list.terms.map((t) => (t.field === "label" ? { ...t, value: names.find((name) => labelNamed(name, t.value)) ?? null } : t));
      if (terms.some((t) => t.value === null && !t.negate)) return [];
      const gmraw = toGmailQuery(terms.filter((t): t is SearchTerm => t.value !== null)) || "in:anywhere";
      return collect(
        scope.filter((folder): folder is Folder => !!folder).map((folder) => [folder, { gmraw }]),
        50,
      );
    }
    case "inboxFrom":
      return collect([[all, { gmraw: `in:inbox from:${list.email}` }]], max);
  }
}

const STATUS_QUERY = { messages: true, uidNext: true, uidValidity: true, unseen: true, highestModseq: true };

async function statuses(account: AccountRow, f: Folders) {
  // Gmail lists every label as a folder; only the three Kite reads are asked about.
  const listed = f.gmail
    ? await onConnection(account, async (client) => {
        const out = [];
        for (const folder of f.scan) out.push({ path: folder.path, status: (await client.status(folder.path, STATUS_QUERY)) || undefined });
        return out;
      })
    : await onConnection(account, (client) => client.list({ statusQuery: STATUS_QUERY }));
  const out = new Map<string, FolderState>();
  for (const l of listed) {
    const s = l.status;
    if (!s?.uidValidity || s.uidNext === undefined) continue;
    out.set(l.path, { v: String(s.uidValidity), n: s.uidNext, c: s.messages ?? 0, u: s.unseen, m: s.highestModseq ? String(s.highestModseq) : undefined });
  }
  return out;
}

/**
 * Gmail's Inbox tabs for messages in All Mail (the selected folder): one X-GM-RAW `in:inbox
 * category:` search per tab, over these UIDs or, without them, the whole Inbox. Returns the
 * conversations whose tab changed. A server that can't search by category leaves every tab as is.
 */
async function sortIntoTabs(client: ImapFlow, accountId: string, path: string, uids?: number[]): Promise<string[]> {
  if (uids && !uids.length) return [];
  const asked = uids ? new Set(uids) : null;
  const copies = copiesIn(accountId, path).filter((c) => (asked ? asked.has(c.uid) : c.labels.includes("\\Inbox")));
  // New mail outside the Inbox has no tab: no searches for it.
  const inbox = uids ? copies.filter((c) => c.labels.includes("\\Inbox")).map((c) => c.uid) : undefined;
  const tabOf = new Map<number, string>();
  const search = async (name: string, among?: number[]) =>
    ((await client.search({ gmraw: `in:inbox category:${name}`, ...(among ? { uid: among.join(",") } : {}) }, { uid: true })) || []) as number[];
  try {
    if (!inbox || inbox.length) {
      // Gmail still sorts mail into tabs the user turned off, and shows it in Primary: `category:primary`
      // follows the user's tab settings, so what it finds stays in Primary whatever else it matches.
      const primary = new Set(await search("primary", inbox));
      // New mail all in Primary (people, sign-in codes) needs no more searches, so it reaches the list sooner.
      const rest = inbox?.filter((uid) => !primary.has(uid));
      if (!rest || rest.length) {
        for (const [name, label] of Object.entries(TABS)) {
          for (const uid of await search(name, rest)) if (!primary.has(uid)) tabOf.set(uid, label);
        }
      }
    }
  } catch {
    return [];
  }
  return setCategories(accountId, copies.map((c) => [c.id, tabOf.get(c.uid) ?? null]));
}

/** The feed's position now: every folder's state. */
export async function startCursor(account: AccountRow) {
  const f = await folders(account, true);
  const now = await statuses(account, f);
  const cursor: Cursor = { f: {} };
  for (const folder of f.scan) {
    const s = now.get(folder.path);
    if (s) cursor.f[folder.path] = s;
  }
  return JSON.stringify(cursor);
}

/**
 * Whether the folder new mail lands in (Gmail: All Mail, else the Inbox) moved past the cursor: one STATUS.
 * Gmail's HIGHESTMODSEQ is the account's, so there any change says yes.
 */
export async function peek(account: AccountRow, raw: string): Promise<boolean> {
  let cursor: Cursor;
  try {
    cursor = JSON.parse(raw) as Cursor;
  } catch {
    return true;
  }
  const f = await folders(account);
  const folder = f.gmail ? f.role.all : f.role.inbox;
  const old = folder && cursor?.f?.[folder.path];
  if (!folder || !old) return true;
  const s = (await onConnection(account, (client) => client.status(folder.path, STATUS_QUERY))) || null;
  if (!s?.uidValidity || s.uidNext === undefined) return true;
  const m = s.highestModseq ? String(s.highestModseq) : undefined;
  return String(s.uidValidity) !== old.v || s.uidNext !== old.n || (s.messages ?? 0) !== old.c || s.unseen !== old.u || m !== old.m;
}

/** Threads changed since the cursor (new mail, flags, moves, deletions), and the new cursor. */
export async function changes(account: AccountRow, raw: string): Promise<{ changed: string[]; cursor: string }> {
  let cursor: Cursor;
  try {
    cursor = JSON.parse(raw) as Cursor;
    if (!cursor?.f) throw new Error("old cursor");
  } catch {
    throw new CursorExpired();
  }
  const f = await folders(account);
  const now = await statuses(account, f);
  const touched = new Set<string>();
  // Gmail's HIGHESTMODSEQ is the account's, so Trash and Spam look changed whenever anything changes. Their
  // flags are read when their counts move (mail in or out, read or unread), else every few minutes, so a
  // push for new mail selects only All Mail.
  const flagsDue = Date.now() - (cursor.flags ?? 0) >= GMAIL_FLAGS_EVERY_MS;
  const next: Cursor = { f: {}, tabs: cursor.tabs, flags: f.gmail && flagsDue ? Date.now() : cursor.flags };
  for (const folder of f.scan) {
    const state = now.get(folder.path);
    const old = cursor.f[folder.path];
    if (!state) {
      if (old) next.f[folder.path] = old;
      continue;
    }
    // A folder that appeared since the last check: its mail is new from here on.
    if (!old) {
      next.f[folder.path] = state;
      continue;
    }
    if (old.v !== state.v) {
      dropFolder(account.id, folder.path).forEach((t) => touched.add(t));
      threadsOf(account.id, await newestOf(account, folder, REFILL)).forEach((t) => touched.add(t));
      next.f[folder.path] = state;
      continue;
    }
    const counted = old.n === state.n && old.c === state.c && old.u === state.u;
    if (counted && (old.m === state.m || (f.gmail && folder.role !== "all" && !flagsDue))) {
      next.f[folder.path] = old;
      continue;
    }
    await inFolder(account, folder.path, async (client) => {
      let added = 0;
      if (state.n > old.n) {
        const got = await fetchInto(client, account.id, folder.path, `${old.n}:*`, old.n);
        added = got.uids.length;
        got.threads.forEach((t) => touched.add(t));
        if (f.gmail && folder.role === "all") (await sortIntoTabs(client, account.id, folder.path, got.uids)).forEach((t) => touched.add(t));
      }
      const known = copiesIn(account.id, folder.path).filter((c) => c.uid < old.n);
      if (!known.length) return;
      if (old.m && state.m) {
        if (old.m !== state.m) {
          const changed = await client.fetchAll("1:*", { uid: true, flags: true, labels: f.gmail }, { uid: true, changedSince: BigInt(old.m) });
          for (const m of changed) {
            const t = setCopyFlags(account.id, folder.path, m.uid, flagsOf(m), f.gmail ? labelsOf(m, true) : undefined);
            if (t) touched.add(t);
          }
        }
      } else if (old.u !== state.u || old.c !== state.c || old.n !== state.n) {
        // No CONDSTORE: read the flags of the copies Kite has again.
        const flags = await client.fetchAll(`${known[0].uid}:*`, { uid: true, flags: true, labels: f.gmail }, { uid: true });
        for (const m of flags) {
          const t = setCopyFlags(account.id, folder.path, m.uid, flagsOf(m), f.gmail ? labelsOf(m, true) : undefined);
          if (t) touched.add(t);
        }
      }
      // More messages gone than came: find which of Kite's copies are no longer there.
      if (old.c + added !== state.c) {
        const present = new Set(((await client.search({ uid: `${known[0].uid}:*` }, { uid: true })) || []) as number[]);
        dropCopies(account.id, folder.path, known.filter((c) => !present.has(c.uid)).map((c) => c.uid)).forEach((t) => touched.add(t));
      }
    });
    next.f[folder.path] = state;
  }
  // Gmail: the whole Inbox into tabs now and then (mail moved between tabs in Gmail, mail read before the first check).
  const all = f.gmail ? f.role.all : undefined;
  if (all && Date.now() - (cursor.tabs ?? 0) >= TABS_EVERY_MS) {
    (await inFolder(account, all.path, (client) => sortIntoTabs(client, account.id, all.path))).forEach((t) => touched.add(t));
    next.tabs = Date.now();
  }
  // Folders deleted on the server (or no longer read) take their copies with them.
  for (const path of Object.keys(cursor.f)) {
    if (!f.scan.some((folder) => folder.path === path)) dropFolder(account.id, path).forEach((t) => touched.add(t));
  }
  return { changed: [...touched], cursor: JSON.stringify(next) };
}

type Bodies = { text?: string; html?: string };

async function readStream(stream: NodeJS.ReadableStream) {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  return Buffer.concat(chunks);
}

/**
 * Downloads the text and HTML bodies of these messages (decoded to UTF-8 by imapflow), one folder
 * at a time. A copy outside Trash and Junk is read when there is one.
 */
export async function loadBodies(account: AccountRow, items: { row: { id: string; parsed: Meta }; copies: Copy[] }[]): Promise<Map<string, Bodies>> {
  const f = await folders(account);
  const out = new Map<string, Bodies>();
  const byFolder = new Map<string, { id: string; uid: number; meta: Meta }[]>();
  for (const { row, copies } of items) {
    const copy = copies.find((c) => !outOfSight(f.byPath.get(c.folder))) ?? copies[0];
    if (!copy || (!row.parsed.text && !row.parsed.html)) continue;
    byFolder.set(copy.folder, [...(byFolder.get(copy.folder) ?? []), { id: row.id, uid: copy.uid, meta: row.parsed }]);
  }
  for (const [path, list] of byFolder) {
    await inFolder(account, path, async (client) => {
      for (const item of list) {
        const bodies: Bodies = {};
        for (const kind of ["text", "html"] as const) {
          const part = item.meta[kind];
          if (!part) continue;
          const got = await client.download(String(item.uid), part, { uid: true });
          if (got.content) bodies[kind] = (await readStream(got.content)).toString("utf8");
        }
        out.set(item.id, bodies);
      }
    });
  }
  return out;
}

/** One file's bytes, from any copy of the message. Null when the message or part is gone. */
export async function downloadPart(account: AccountRow, copies: Copy[], part: string): Promise<Buffer | null> {
  for (const copy of copies) {
    const data = await inFolder(account, copy.folder, async (client) => {
      const got = await client.download(String(copy.uid), part, { uid: true });
      return got.content ? readStream(got.content) : null;
    });
    if (data) return data;
  }
  return null;
}
