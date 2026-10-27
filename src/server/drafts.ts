import "server-only";

import { ComposeDraft, emptyDraft, type Recipient } from "@/lib/mail/compose";
import { escapeMarkup } from "@/lib/mail/body";
import type { Contact } from "@/lib/mail/types";
import { getAttachment } from "./attachments";
import { getDb, type AccountRow } from "./db";
import { ProviderError } from "./mail/errors";
import type { OutgoingMessage } from "./mail/types";
import { mailOf } from "./providers/registry";
import { htmlToText, OutgoingError, renderOutgoing } from "./outgoing";
import { getPreferences } from "./settings";
import { queryThreads } from "./store";
import { syncThread } from "./sync";
import { removeUploads, saveUpload } from "./uploads";

// Drafts live at the provider (so they show up everywhere), with Kite's own copy of what was
// written (markup, recipients, attachment references) kept locally so reopening a draft
// is lossless. A draft changed in another app is read back from the provider instead.

type DraftRow = { draft_id: string; account_id: string; message_id: string; thread_id: string; payload: string };

export function outgoingFromDraft(account: AccountRow, draft: ComposeDraft): OutgoingMessage {
  return {
    to: draft.to,
    cc: draft.cc,
    bcc: draft.bcc,
    subject: draft.subject,
    body: draft.body,
    design: draft.design,
    threadId: draft.threadId,
    inReplyTo: draft.inReplyTo,
    references: draft.references,
    signature: draft.signature ? getPreferences().signatures[account.id] : undefined,
    attachments: draft.attachments,
    quote: draft.quote,
  };
}

function row(draftId: string) {
  return getDb().prepare("SELECT * FROM drafts WHERE draft_id = ?").get(draftId) as DraftRow | undefined;
}

/** Creates or updates the provider's draft. Returns the (possibly new) draft id. */
export async function saveDraft(account: AccountRow, draft: ComposeDraft) {
  const known = draft.draftId ? row(draft.draftId) : undefined;
  // Updates stay in the draft's own thread; without it a provider may file each save as a new thread.
  const message = { ...outgoingFromDraft(account, draft), threadId: draft.threadId ?? (known?.account_id === account.id ? known.thread_id : undefined) };
  const rendered = await renderOutgoing(account, message);
  const mail = mailOf(account);
  let saved;
  try {
    saved = await mail.saveDraft(account, message, rendered, known?.account_id === account.id ? draft.draftId : undefined);
  } catch (error) {
    // Sent or deleted elsewhere since the last save: start a new draft.
    if (!(error instanceof ProviderError) || ![400, 404].includes(error.status) || !draft.draftId) throw error;
    saved = await mail.saveDraft(account, message, rendered);
  }
  if (draft.draftId && draft.draftId !== saved.id) getDb().prepare("DELETE FROM drafts WHERE draft_id = ?").run(draft.draftId);
  getDb()
    .prepare(
      `INSERT INTO drafts (draft_id, account_id, message_id, thread_id, payload, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(draft_id) DO UPDATE SET message_id = excluded.message_id, thread_id = excluded.thread_id,
         payload = excluded.payload, updated_at = excluded.updated_at`,
    )
    .run(saved.id, account.id, saved.messageId, saved.threadId, JSON.stringify({ ...draft, draftId: saved.id }), new Date().toISOString());
  void syncThread(account, saved.threadId).catch(() => {});
  // A provider can file the new version in a new conversation (Gmail over IMAP does): the old one empties.
  if (known?.account_id === account.id && known.thread_id !== saved.threadId) void syncThread(account, known.thread_id).catch(() => {});
  return { draftId: saved.id, messageId: saved.messageId, threadId: saved.threadId };
}

/** The provider draft holding a message (by message id, else the newest draft in the thread). */
async function findDraft(account: AccountRow, { messageId, threadId }: { messageId?: string; threadId?: string }) {
  const local = messageId
    ? (getDb().prepare("SELECT * FROM drafts WHERE message_id = ? AND account_id = ?").get(messageId, account.id) as DraftRow | undefined)
    : undefined;
  if (local) return { id: local.draft_id, local };
  const drafts = await mailOf(account).listDrafts(account);
  const found = drafts.find((d) => d.messageId === messageId) ?? (threadId ? drafts.find((d) => d.threadId === threadId) : undefined);
  return found ? { id: found.id, local: undefined } : null;
}

/**
 * Deletes a draft at the provider and here. Uploaded files go too, unless `keepFiles` (the
 * message was sent or queued and still needs them).
 */
export async function discardDraft(account: AccountRow, ref: { draftId?: string; messageId?: string; threadId?: string }, keepFiles = false) {
  const draftId = ref.draftId ?? (await findDraft(account, ref))?.id;
  if (!draftId) return false;
  const local = row(draftId);
  await mailOf(account).deleteDraft(account, draftId);
  if (local) {
    getDb().prepare("DELETE FROM drafts WHERE draft_id = ?").run(draftId);
    if (!keepFiles) {
      const payload = ComposeDraft.safeParse(JSON.parse(local.payload));
      if (payload.success) await removeUploads(payload.data.attachments.flatMap((a) => (a.type === "upload" ? [a.id] : [])));
    }
  }
  const threadId = local?.thread_id ?? ref.threadId;
  if (threadId) void syncThread(account, threadId).catch(() => {});
  return true;
}

const recipient = (c: Contact): Recipient => (c.name && c.name !== c.email && c.name !== c.email.split("@")[0] ? { name: c.name, email: c.email } : { email: c.email });

/** A draft ready to edit: Kite's own copy when it's current, otherwise read from the provider. */
export async function openDraft(account: AccountRow, ref: { messageId?: string; threadId?: string }): Promise<ComposeDraft> {
  const found = await findDraft(account, ref);
  if (!found) throw new OutgoingError("This draft was sent or deleted.", 404);
  if (found.local) {
    const parsed = ComposeDraft.safeParse(JSON.parse(found.local.payload));
    if (parsed.success) return { ...parsed.data, draftId: found.id };
  }

  const content = await mailOf(account).getDraft(account, found.id);
  const text = content.text ?? (content.html ? htmlToText(content.html) : "");
  const inReplyTo = content.inReplyTo;
  const references = (content.references ?? "").replace(inReplyTo ?? "\u0000", "").trim() || undefined;
  // Files in a draft are copied into Kite's uploads: the draft's message (and its part ids) may change on every save.
  const attachments = await Promise.all(
    content.files.map(async (a) => {
      const file = await getAttachment(account, content.messageId, a.partId!, a.name);
      const upload = await saveUpload(file.name, file.mimeType, file.data);
      return { type: "upload" as const, id: upload.id, name: upload.name, mimeType: upload.mimeType, bytes: upload.bytes };
    }),
  );
  return {
    ...emptyDraft(account.id),
    to: content.to.map(recipient),
    cc: content.cc.map(recipient),
    bcc: content.bcc.map(recipient),
    subject: content.subject,
    body: escapeMarkup(text.replace(/\r\n/g, "\n").trimEnd()),
    // Whatever signature the other app added is already part of the text.
    signature: false,
    attachments,
    threadId: inReplyTo ? content.threadId : undefined,
    inReplyTo,
    references,
    draftId: found.id,
  };
}

const draftRefresh = globalThis as typeof globalThis & { kiteDraftRefresh?: Map<string, { at: number; work: Promise<void> }> };
export function refreshDraftList(account: AccountRow) {
  const jobs = draftRefresh.kiteDraftRefresh ??= new Map();
  const previous = jobs.get(account.id);
  if (previous && Date.now() - previous.at < 30_000) return previous.work;
  const work = (async () => {
    const drafts = await mailOf(account).listDrafts(account);
    const ids = new Set(drafts.map((d) => d.threadId));
    const stored = getDb().prepare("SELECT DISTINCT thread_id FROM drafts WHERE account_id = ?").all(account.id) as { thread_id: string }[];
    for (const r of stored) ids.add(r.thread_id);
    for (const thread of queryThreads("drafts", account.id)) {
      if (thread.remoteId) ids.add(thread.remoteId);
    }
    for (const id of ids) await syncThread(account, id);
  })();
  jobs.set(account.id, { at: Date.now(), work });
  return work;
}
