import "server-only";

import { INBOX, SPAM, STARRED, SYSTEM_LABELS, TRASH, UNREAD } from "@/lib/mail/mailboxes";
import { inferMimeType } from "@/lib/mail/attachments";
import type { AccountRow } from "../../db";
import { folderTest, listStoredLabels } from "../../labels";
import { mapLimit } from "../../mail/parse";
import type { MailAdapter, MailProvider } from "../../mail/provider";
import type { LabelChange, ThreadList } from "../../mail/types";
import { listCategories } from "./categories";
import * as compose from "./compose";
import { ATTACHMENT_EXPAND, contacts, FULL_FIELDS, META_FIELDS, toMessage, toRecord, type GraphAddress, type GraphMessage } from "./convert";
import { folders, listUserFolders, type Folders } from "./folders";
import { graph, GraphError, odata, pages } from "./graph";
import { outlookCalendar } from "./calendar";
import { manageLabels } from "./manage";
import { canEditCategories, canReadCategories, microsoftAuth } from "./oauth";
import { matchesRest, toKql } from "./search";

// Outlook / Microsoft 365 as a Kite mail provider (Microsoft Graph). A Kite thread is an Outlook
// conversation (conversationId); its messages are read from every folder at once.
//
// New mail: one query for messages changed since the last check (lastModifiedDateTime), across
// all folders, instead of a delta link per folder: one request per check rather than one per
// folder, and moves, reads and flags show up too. Mail deleted for good isn't reported; it goes
// from Kite the next time its conversation is read.

const CONCURRENCY = 4;
const notFound = (error: unknown) => error instanceof GraphError && error.status === 404;

/** Folders whose mail Kite leaves out of lists unless asked (like Gmail's spam and trash). */
const outOfSight = (f: Folders, m: GraphMessage) => m.parentFolderId === f.ids.junkemail || m.parentFolderId === f.ids.deleteditems;

const FOLDER_OF = { inbox: "inbox", sent: "sentitems", drafts: "drafts", trash: "deleteditems" } as const;

type Listing = { path: string; keep?: (m: GraphMessage) => boolean };

/** A Kite list as a Graph query over messages (each list is read newest first where Graph allows). */
async function listing(account: AccountRow, list: ThreadList): Promise<Listing> {
  const f = await folders(account);
  const select = "id,conversationId,parentFolderId,isRead,flag,categories";
  const newest = "$orderby=receivedDateTime desc";
  switch (list.kind) {
    case "mailbox":
      if (list.mailbox === "starred") return { path: `/me/messages?$filter=flag/flagStatus eq 'flagged'&$select=${select}&$top=100` };
      return { path: `/me/mailFolders/${FOLDER_OF[list.mailbox]}/messages?${newest}&$select=${select}&$top=100` };
    case "recent": {
      const since = new Date(Date.now() - list.days * 86_400_000).toISOString();
      return { path: `/me/messages?$filter=receivedDateTime ge ${since}&${newest}&$select=${select}&$top=100`, keep: (m) => !outOfSight(f, m) };
    }
    case "attachments":
      // Graph wants the $orderby property first in $filter.
      return {
        path: `/me/messages?$filter=receivedDateTime ge 1900-01-01T00:00:00Z and hasAttachments eq true&${newest}&$select=${select}&$top=100`,
        keep: (m) => !outOfSight(f, m),
      };
    case "label":
      // A category is a tag on the message (Graph can't sort this filter); a folder is where it is.
      if (!folderTest(account.id)(list.id)) {
        return { path: `/me/messages?$filter=categories/any(c:c eq ${encodeURIComponent(odata(list.id))})&$select=${select}&$top=100`, keep: (m) => !outOfSight(f, m) };
      }
      return { path: `/me/mailFolders/${encodeURIComponent(list.id)}/messages?${newest}&$select=${select}&$top=100` };
    case "search": {
      const labels = listStoredLabels(account.id);
      const keep = (m: GraphMessage) => matchesRest(list.terms, m, f, labels);
      const kql = toKql(list.terms, labels);
      // $search can't be sorted; results come back by relevance and date.
      return { path: kql ? `/me/messages?$search=${encodeURIComponent(kql)}&$select=${select}&$top=50` : `/me/messages?${newest}&$select=${select}&$top=100`, keep };
    }
    case "inboxFrom":
      return { path: `/me/mailFolders/inbox/messages?$filter=from/emailAddress/address eq ${encodeURIComponent(odata(list.email))}&$select=${select}&$top=100` };
    case "sender":
      return { path: `/me/messages?$filter=from/emailAddress/address eq ${encodeURIComponent(odata(list.email))}&$select=${select}&$top=100`, keep: (m) => !outOfSight(f, m) };
  }
}

/** The messages behind a list (filtered), until `enough` says stop or `cap` messages were read. */
async function scan(account: AccountRow, list: ThreadList, cap: number, onMessages: (found: GraphMessage[]) => boolean) {
  const { path, keep } = await listing(account, list);
  await pages<GraphMessage>(account.id, path, cap, (page) => onMessages(keep ? page.filter(keep) : page));
}

/** Every message of a conversation, from all folders (Outbox and the like left out). */
async function conversation(account: AccountRow, conversationId: string, select: string, expand = "") {
  const f = await folders(account);
  const found = await pages<GraphMessage>(
    account.id,
    `/me/messages?$filter=conversationId eq ${encodeURIComponent(odata(conversationId))}&$select=${select}${expand ? `&$expand=${expand}` : ""}&$top=100`,
    1000,
  );
  return found.filter((m) => !f.hidden.has(m.parentFolderId ?? ""));
}

/**
 * Where a label change moves one message, or null when it stays. Taking a message out of its
 * folder archives it (lib/mail/providers.ts applyLabelChange). Your own sent mail and drafts
 * aren't filed with the rest.
 */
function destination(account: AccountRow, m: GraphMessage, change: LabelChange, f: Folders, isFolder: (id: string) => boolean): string | null {
  const at = m.parentFolderId;
  const me = account.email.toLowerCase();
  const isMe = (a?: GraphAddress | null) => (a?.emailAddress?.address ?? "").toLowerCase() === me;
  // Sent by you to others; a note to yourself was also received, so it belongs with received mail.
  const mine = isMe(m.from) && ![...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].some(isMe);
  const filedApart = at === f.ids.sentitems || at === f.ids.drafts || !!m.isDraft;
  // Where restored mail goes (out of Trash or Junk): mail you sent back to Sent Items.
  const home = mine ? f.ids.sentitems : f.ids.inbox;
  const archive = () => {
    if (!f.ids.archive) throw new GraphError("This mailbox has no Archive folder", 400);
    return f.ids.archive;
  };
  if (change.add.includes(TRASH)) return f.ids.deleteditems;
  if (change.add.includes(SPAM)) return filedApart ? null : f.ids.junkemail;
  const into = change.add.find(isFolder);
  if (into) return filedApart ? null : into;
  // Inbox means Inbox, even for mail from yourself (a note to self lives there, not in Sent Items).
  if (change.add.includes(INBOX)) return filedApart || at === f.ids.inbox ? null : f.ids.inbox;
  if (change.remove.includes(INBOX) && at === f.ids.inbox) return archive();
  if (change.remove.includes(TRASH) && at === f.ids.deleteditems) return change.remove.includes(INBOX) ? archive() : home;
  if (change.remove.includes(SPAM) && at === f.ids.junkemail) return home;
  const out = change.remove.find(isFolder);
  if (out && at === out) return archive();
  return null;
}

const STATE_FIELDS = "id,parentFolderId,isRead,isDraft,flag,categories,from,toRecipients,ccRecipients";

/** Categories (tags) a change adds and removes: anything not a mailbox or folder. */
const tagsIn = (labels: string[], isFolder: (id: string) => boolean) => labels.filter((l) => !SYSTEM_LABELS.has(l) && !isFolder(l));

async function apply(account: AccountRow, m: GraphMessage, change: LabelChange, f: Folders, isFolder: (id: string) => boolean) {
  const patch: Record<string, unknown> = {};
  const add = tagsIn(change.add, isFolder);
  const remove = tagsIn(change.remove, isFolder);
  if (add.length || remove.length) {
    const before = m.categories ?? [];
    const after = [...new Set([...before.filter((c) => !remove.includes(c)), ...add])];
    if (after.length !== before.length || after.some((c, i) => c !== before[i])) patch.categories = after;
  }
  if (change.add.includes(UNREAD) && m.isRead !== false) patch.isRead = false;
  if (change.remove.includes(UNREAD) && m.isRead === false) patch.isRead = true;
  const flagged = m.flag?.flagStatus === "flagged";
  if (change.add.includes(STARRED) && !flagged) patch.flag = { flagStatus: "flagged" };
  if (change.remove.includes(STARRED) && flagged) patch.flag = { flagStatus: "notFlagged" };
  if (Object.keys(patch).length) await graph(account.id, `/me/messages/${m.id}`, { method: "PATCH", body: patch });
  const to = destination(account, m, change, f, isFolder);
  if (to && to !== m.parentFolderId) await graph(account.id, `/me/messages/${m.id}/move`, { method: "POST", body: { destinationId: to } });
}

type Cursor = { at: string; ids: string[] };

const mail: MailAdapter = {
  concurrency: CONCURRENCY,
  async startCursor(account) {
    const newest = await graph<{ value?: GraphMessage[] }>(account.id, "/me/messages?$orderby=lastModifiedDateTime desc&$select=id,lastModifiedDateTime&$top=1");
    const m = newest.value?.[0];
    return JSON.stringify({ at: m?.lastModifiedDateTime ?? new Date().toISOString(), ids: m ? [m.id] : [] } satisfies Cursor);
  },
  async changes(account, raw) {
    const cursor = JSON.parse(raw) as Cursor;
    const seen = new Set(cursor.ids);
    const found = await pages<GraphMessage>(
      account.id,
      `/me/messages?$filter=lastModifiedDateTime ge ${cursor.at}&$orderby=lastModifiedDateTime asc&$select=id,conversationId,lastModifiedDateTime&$top=200`,
      2000,
    );
    // `ge` includes the last check's newest messages again: those were already seen.
    const fresh = found.filter((m) => !(m.lastModifiedDateTime === cursor.at && seen.has(m.id)));
    const last = found.at(-1)?.lastModifiedDateTime ?? cursor.at;
    const ids = found.filter((m) => m.lastModifiedDateTime === last).map((m) => m.id);
    const next: Cursor = { at: last, ids: last === cursor.at ? [...new Set([...cursor.ids, ...ids])] : ids };
    return { changed: [...new Set(fresh.map((m) => m.conversationId))], cursor: JSON.stringify(next) };
  },
  async listThreads(account, list, max, onPage) {
    const ids: string[] = [];
    const seen = new Set<string>();
    await scan(account, list, max * 5, (page) => {
      const fresh: string[] = [];
      for (const m of page) {
        if (seen.has(m.conversationId) || ids.length + fresh.length >= max) continue;
        seen.add(m.conversationId);
        fresh.push(m.conversationId);
      }
      ids.push(...fresh);
      if (fresh.length) onPage?.(fresh);
      return ids.length < max;
    });
    return ids;
  },
  async listMessages(account, list, max) {
    const ids: string[] = [];
    await scan(account, list, max, (page) => {
      ids.push(...page.map((m) => m.id));
      return ids.length < max;
    });
    return ids.slice(0, max);
  },
  async fetchThread(account, conversationId, full) {
    const found = await conversation(account, conversationId, full ? FULL_FIELDS : META_FIELDS, full ? ATTACHMENT_EXPAND : "");
    if (!found.length) return null;
    return toRecord(account, conversationId, found, await folders(account), full);
  },
  async fetchMessage(account, messageId, full) {
    const m = await graph<GraphMessage>(account.id, `/me/messages/${messageId}?$select=${full ? FULL_FIELDS : META_FIELDS}${full ? `&$expand=${ATTACHMENT_EXPAND}` : ""}`);
    return toMessage(m, await folders(account), full);
  },
  async attachment(account, messageId, partId, name) {
    try {
      const a = await graph<{ name?: string; contentType?: string; contentBytes?: string }>(account.id, `/me/messages/${messageId}/attachments/${partId}`);
      const fileName = a.name || name || "attachment";
      // An attached email or calendar item has no bytes of its own: its raw content is the file.
      const data = a.contentBytes
        ? Buffer.from(a.contentBytes, "base64")
        : await graph<Buffer>(account.id, `/me/messages/${messageId}/attachments/${partId}/$value`, { bytes: true });
      return { name: fileName, mimeType: inferMimeType(fileName, a.contentType), data };
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  },
  async modifyThreads(account, conversationIds, change) {
    const f = await folders(account);
    const isFolder = folderTest(account.id);
    for (const id of conversationIds) {
      const messages = await conversation(account, id, STATE_FIELDS);
      await mapLimit(messages, CONCURRENCY, (m) => apply(account, m, change, f, isFolder));
    }
  },
  async modifyMessages(account, messageIds, change) {
    const f = await folders(account);
    const isFolder = folderTest(account.id);
    await mapLimit(messageIds, CONCURRENCY, async (id) => {
      try {
        await apply(account, await graph<GraphMessage>(account.id, `/me/messages/${id}?$select=${STATE_FIELDS}`), change, f, isFolder);
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    });
  },
  send: compose.send,
  canDeletePermanently: async () => true,
  async deletePermanently(account, ids) {
    const f = await folders(account);
    for (const id of ids) {
      try {
        const m = await graph<GraphMessage>(account.id, `/me/messages/${id}?$select=id,parentFolderId`);
        if (m.parentFolderId !== f.ids.deleteditems) throw new Error("A message is no longer in Trash. Refresh and try again.");
        await graph(account.id, `/me/messages/${id}/permanentDelete`, { method: "POST" });
      } catch (error) {
        if (!notFound(error)) throw error;
      }
    }
  },
  saveDraft: compose.saveDraft,
  async deleteDraft(account, draftId) {
    try {
      await graph(account.id, `/me/messages/${draftId}`, { method: "DELETE" });
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  },
  async getDraft(account, draftId) {
    const m = await graph<GraphMessage>(account.id, `/me/messages/${draftId}?$select=${FULL_FIELDS}&$expand=${ATTACHMENT_EXPAND}`);
    const message = toMessage(m, await folders(account), true);
    return {
      messageId: m.id,
      threadId: m.conversationId,
      to: message.to,
      cc: message.cc ?? [],
      bcc: contacts(m.bccRecipients),
      subject: m.subject ?? "",
      html: message.html ?? null,
      text: message.html ? null : message.body.join("\n\n"),
      inReplyTo: message.inReplyTo,
      references: message.references,
      files: (message.attachments ?? []).filter((a) => !a.inline),
    };
  },
  async listDrafts(account) {
    const found = await pages<GraphMessage>(account.id, "/me/mailFolders/drafts/messages?$select=id,conversationId&$top=100", 500);
    return found.map((m) => ({ id: m.id, messageId: m.id, threadId: m.conversationId }));
  },
};

export const outlookProvider: MailProvider = {
  id: "outlook",
  auth: microsoftAuth,
  mail,
  labels: {
    // Folders, then categories (tags by name). A folder id still on stored mail after the folder
    // was deleted is known from the stored list, so it never comes back as a category.
    async list(account) {
      const found = await listUserFolders(account);
      const ids = new Set(found.map((l) => l.id));
      const stored = folderTest(account.id);
      return [...found, ...(await listCategories(account, (id) => ids.has(id) || stored(id)))];
    },
    reconnectFor: (accountId) =>
      canEditCategories(accountId)
        ? null
        : canReadCategories(accountId)
          ? "Reconnect so Kite can make and delete categories."
          : "Reconnect so Kite can see your category colours, the categories not used on any mail yet, and make new ones.",
    ...manageLabels((account, ids, change) => mail.modifyMessages(account, ids, change)),
  },
  calendar: outlookCalendar,
  async picture(account) {
    // A fixed size where the mailbox keeps them (Microsoft 365); otherwise the one photo there is
    // (personal accounts). 404 from both: no photo, initials.
    for (const path of ["/me/photos/240x240/$value", "/me/photo/$value"]) {
      try {
        return await graph<Buffer>(account.id, path, { bytes: true });
      } catch (error) {
        if (!(error instanceof GraphError && error.status === 404)) throw error;
      }
    }
    return null;
  },
};
