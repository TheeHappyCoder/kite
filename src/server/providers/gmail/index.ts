import "server-only";

import { INBOX, TRASH } from "@/lib/mail/mailboxes";
import { providerSpec } from "@/lib/mail/providers";
import { toGmailQuery } from "@/lib/mail/search";
import { inferMimeType } from "@/lib/mail/attachments";
import { CursorExpired, LabelError } from "../../mail/errors";
import { buildMime } from "../../mail/mime";
import { parseAddressList } from "../../mail/parse";
import type { MailAdapter, MailProvider } from "../../mail/provider";
import type { LabelChange, ThreadList } from "../../mail/types";
import { listAccounts, type AccountRow } from "../../db";
import { googleCalendar } from "../../mail/google/calendar";
import { profilePhoto } from "../../mail/google/oauth";
import { googleContactPhotos } from "../../mail/google/people";
import * as api from "./api";
import { collectAttachments, findBody, findPart, header, toMessage, toRecord } from "./convert";
import { gmailFilters } from "./filters";
import { getAccessToken, gmailAccess, googleAuth } from "./oauth";

// Gmail as a Kite mail provider. Gmail's labels are Kite's model already, so most of this is
// translation of lists into Gmail queries and the trash endpoints.

const notSpamOrTrash = "-in:spam -in:trash";
const MAILBOX_LABEL = { inbox: "INBOX", sent: "SENT", starred: "STARRED", drafts: "DRAFT" } as const;

/** A Kite list as Gmail list parameters. */
function listParams(list: ThreadList) {
  const q = (query: string) => `q=${encodeURIComponent(query)}`;
  switch (list.kind) {
    case "mailbox":
      return `labelIds=${MAILBOX_LABEL[list.mailbox]}`;
    case "recent":
      return q(`newer_than:${list.days}d ${notSpamOrTrash}`);
    case "attachments":
      return q(`has:attachment ${notSpamOrTrash}`);
    case "label":
      return `labelIds=${encodeURIComponent(list.id)}`;
    case "search":
      return q(toGmailQuery(list.terms));
    case "inboxFrom":
      return q(`from:(${list.email}) in:inbox`);
  }
}

/**
 * A label change on threads or messages. Adding or removing TRASH goes through Gmail's trash
 * endpoints (trash already takes mail out of the inbox); everything else is one modify.
 */
async function modify(account: AccountRow, kind: "threads" | "messages", ids: string[], change: LabelChange) {
  if (!ids.length) return;
  const trashing = change.add.includes(TRASH);
  const untrashing = change.remove.includes(TRASH);
  if (trashing || untrashing) await api.trash(account.id, kind, ids, !trashing);
  const add = change.add.filter((l) => l !== TRASH);
  const remove = change.remove.filter((l) => l !== TRASH && !(trashing && l === INBOX));
  if (!add.length && !remove.length) return;
  if (kind === "messages") await api.batchModify(account.id, ids, add, remove);
  else for (const id of ids) await api.modifyThread(account.id, id, add, remove);
}

const notFound = (error: unknown) => error instanceof api.GmailError && error.status === 404;

const mail: MailAdapter = {
  // About 20 thread reads a second at eight at once, under Gmail's per-user rate (429s are retried).
  concurrency: 8,
  startCursor: async (account) => (await api.profile(account.id)).historyId,
  async changes(account, cursor) {
    try {
      const result = await api.changedThreads(account.id, cursor);
      return { changed: result.changed, cursor: result.historyId };
    } catch (error) {
      // History expires after about a week offline.
      if (notFound(error)) throw new CursorExpired();
      throw error;
    }
  },
  listThreads: (account, list, max, onPage) => api.listThreadIds(account.id, listParams(list), max, onPage),
  listMessages: (account, list, max) => api.listMessageIds(account.id, listParams(list), max),
  async fetchThread(account, remoteId, full) {
    try {
      return toRecord(account, await api.getThread(account.id, remoteId, full), full);
    } catch (error) {
      if (notFound(error)) return null;
      throw error;
    }
  },
  fetchMessage: async (account, messageId, full) => toMessage(await api.getMessage(account.id, messageId, full), full),
  async attachment(account, messageId, partId, name) {
    // Gmail's attachment ids change between fetches, so the part is found again by its stable part id.
    const message = await api.getMessage(account.id, messageId, true);
    const part = findPart(message.payload, (p) => p.partId === partId && !!(p.body?.attachmentId || p.body?.data) && (!name || p.filename === name));
    if (!part) return null;
    const data = part.body?.attachmentId
      ? await api.getAttachmentData(account.id, messageId, part.body.attachmentId)
      : Buffer.from(part.body?.data ?? "", "base64url");
    return { name: part.filename || name || "attachment", mimeType: inferMimeType(part.filename || name || "", part.mimeType), data };
  },
  modifyThreads: (account, ids, change) => modify(account, "threads", ids, change),
  modifyMessages: (account, ids, change) => modify(account, "messages", ids, change),
  send: (account, message, rendered) =>
    api.uploadMime<{ id: string; threadId: string }>(account.id, "/messages/send", "POST", { threadId: message.threadId }, buildMime(account, message, rendered)),
  async saveDraft(account, message, rendered, draftId) {
    const mime = buildMime(account, message, rendered);
    const meta = message.threadId ? { threadId: message.threadId } : {};
    const saved = draftId
      ? await api.uploadMime<api.GmailDraft>(account.id, `/drafts/${draftId}`, "PUT", { id: draftId, message: meta }, mime)
      : await api.uploadMime<api.GmailDraft>(account.id, "/drafts", "POST", { message: meta }, mime);
    return { id: saved.id, messageId: saved.message.id, threadId: saved.message.threadId };
  },
  async deleteDraft(account, draftId) {
    try {
      await api.deleteDraft(account.id, draftId);
    } catch (error) {
      if (!notFound(error)) throw error;
    }
  },
  async getDraft(account, draftId) {
    const { message } = await api.getDraft(account.id, draftId);
    const html = findBody(message.payload, "text/html");
    return {
      messageId: message.id,
      threadId: message.threadId,
      to: parseAddressList(header(message, "To")),
      cc: parseAddressList(header(message, "Cc")),
      bcc: parseAddressList(header(message, "Bcc")),
      subject: header(message, "Subject"),
      html,
      text: findBody(message.payload, "text/plain"),
      inReplyTo: header(message, "In-Reply-To") || undefined,
      references: header(message, "References") || undefined,
      files: collectAttachments(message.payload).filter((a) => a.partId && !(html && a.contentId && html.includes(`cid:${a.contentId}`))),
    };
  },
  listDrafts: async (account) => (await api.listDrafts(account.id)).map((d) => ({ id: d.id, messageId: d.message.id, threadId: d.message.threadId })),
};

const asLabel = (l: Awaited<ReturnType<typeof api.listLabels>>[number]) => ({
  id: l.id,
  name: l.name,
  kind: "tag" as const,
  color: l.color?.backgroundColor ?? null,
  hidden: l.labelListVisibility === "labelHide",
});

/** Gmail's 409 for a name that's taken (or clashes with a system label), said plainly. */
async function clash<T>(request: Promise<T>, name: string) {
  try {
    return await request;
  } catch (error) {
    if (error instanceof api.GmailError && error.status === 409) throw new LabelError(`Gmail already has a label called “${name}”.`);
    throw error;
  }
}

export const gmailProvider: MailProvider = {
  id: "gmail",
  auth: googleAuth,
  mail,
  labels: {
    list: async (account) => (await api.listLabels(account.id)).filter((l) => l.type === "user" && !providerSpec("gmail").system.has(l.id)).map(asLabel),
    create: async (account, { name }) => asLabel(await clash(api.createLabel(account.id, name), name)),
    // Gmail nests by name ("Work/Clients"), so the labels under it are renamed one by one too.
    async rename(account, label, name) {
      const renamed = asLabel(await clash(api.renameLabel(account.id, label.id, name), name));
      for (const child of await api.listLabels(account.id)) {
        if (child.type === "user" && child.name.startsWith(`${label.name}/`)) await api.renameLabel(account.id, child.id, name + child.name.slice(label.name.length));
      }
      return renamed;
    },
    // The label leaves every message; the messages stay where they are.
    async remove(account, label) {
      await api.deleteLabel(account.id, label.id);
      return null;
    },
  },
  picture: async (account) => profilePhoto(await getAccessToken(account.id)),
  filters: gmailFilters,
  contactPhotos: googleContactPhotos(gmailAccess, () => listAccounts().filter((a) => a.provider === "gmail")),
  calendar: googleCalendar(gmailAccess),
};
