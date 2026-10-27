import "server-only";

import type { AccountRow } from "../../db";
import type { RenderedMessage } from "../../outgoing";
import type { Recipient } from "@/lib/mail/compose";
import type { OutgoingMessage, SavedDraft } from "../../mail/types";
import { graph, GraphError, odata } from "./graph";

// Outgoing mail on Outlook, built as Graph messages rather than raw MIME: a reply starts from
// Outlook's own createReply, so it always lands in the right conversation, and a draft is updated
// in place (same id) instead of replaced on every autosave. Inline images and files are file
// attachments; anything over 3 MB goes up in chunks through an upload session (Graph's limit for
// one request).

const SMALL = 3 * 1024 * 1024;
/** Upload session chunks must be multiples of 320 KiB. */
const CHUNK = 320 * 1024 * 10;

type Draft = { id: string; conversationId: string };
type File = { name: string; contentType: string; data: Buffer; cid?: string };

function recipients(list: Recipient[] | undefined) {
  return (list ?? []).map((a) => ({ emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) } }));
}

function fields(input: OutgoingMessage, rendered: RenderedMessage) {
  return {
    subject: input.subject,
    body: rendered.html ? { contentType: "html", content: rendered.html } : { contentType: "text", content: rendered.text },
    toRecipients: recipients(input.to),
    ccRecipients: recipients(input.cc),
    bccRecipients: recipients(input.bcc),
  };
}

function files(rendered: RenderedMessage): File[] {
  return [
    ...rendered.inline.map((i) => ({ name: i.name, contentType: i.contentType, data: i.data, cid: i.cid })),
    ...rendered.attachments.map((a) => ({ name: a.name, contentType: a.contentType, data: a.data })),
  ];
}

/** The Graph message a reply answers, found by its Message-ID header. */
async function parentOf(account: AccountRow, input: OutgoingMessage) {
  if (!input.inReplyTo) return null;
  const found = await graph<{ value?: { id: string }[] }>(
    account.id,
    `/me/messages?$filter=internetMessageId eq ${encodeURIComponent(odata(input.inReplyTo))}&$select=id&$top=1`,
  );
  return found.value?.[0]?.id ?? null;
}

async function upload(account: AccountRow, messageId: string, file: File) {
  const inline = file.cid ? { isInline: true, contentId: file.cid } : { isInline: false };
  if (file.data.length <= SMALL) {
    await graph(account.id, `/me/messages/${messageId}/attachments`, {
      method: "POST",
      body: { "@odata.type": "#microsoft.graph.fileAttachment", name: file.name, contentType: file.contentType, contentBytes: file.data.toString("base64"), ...inline },
    });
    return;
  }
  const session = await graph<{ uploadUrl: string }>(account.id, `/me/messages/${messageId}/attachments/createUploadSession`, {
    method: "POST",
    body: { AttachmentItem: { attachmentType: "file", name: file.name, size: file.data.length, contentType: file.contentType, ...inline } },
  });
  // The upload URL carries its own authorisation: no token is sent with the chunks.
  const size = file.data.length;
  for (let start = 0; start < size; start += CHUNK) {
    const end = Math.min(start + CHUNK, size);
    const res = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: { "content-range": `bytes ${start}-${end - 1}/${size}`, "content-length": String(end - start) },
      body: new Uint8Array(file.data.subarray(start, end)),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new GraphError(`Upload of ${file.name} failed (${res.status})`, res.status);
  }
}

/** Makes a draft's attachments match the message: files are kept by name, others removed, new ones uploaded. */
async function syncAttachments(account: AccountRow, messageId: string, wanted: File[], fresh: boolean) {
  const key = (name: string, inline: boolean) => `${inline ? "i" : "f"}:${name}`;
  const current = fresh
    ? []
    : ((await graph<{ value?: { id: string; name: string; isInline?: boolean }[] }>(account.id, `/me/messages/${messageId}/attachments?$select=id,name,isInline`))
        .value ?? []);
  const want = new Set(wanted.map((f) => key(f.name, !!f.cid)));
  const have = new Set(current.map((a) => key(a.name, !!a.isInline)));
  for (const a of current) if (!want.has(key(a.name, !!a.isInline))) await graph(account.id, `/me/messages/${messageId}/attachments/${a.id}`, { method: "DELETE" });
  for (const f of wanted) if (!have.has(key(f.name, !!f.cid))) await upload(account, messageId, f);
}

/** A new draft: a reply made with Outlook's createReply (so it joins the conversation), else a new message. */
async function create(account: AccountRow, input: OutgoingMessage, rendered: RenderedMessage): Promise<Draft> {
  const parent = await parentOf(account, input).catch(() => null);
  let draft: Draft;
  if (parent) {
    const reply = await graph<Draft>(account.id, `/me/messages/${parent}/createReply`, { method: "POST", body: {} });
    draft = await graph<Draft>(account.id, `/me/messages/${reply.id}`, { method: "PATCH", body: fields(input, rendered) });
  } else {
    draft = await graph<Draft>(account.id, "/me/messages", { method: "POST", body: fields(input, rendered) });
  }
  await syncAttachments(account, draft.id, files(rendered), !parent);
  return draft;
}

export async function saveDraft(account: AccountRow, input: OutgoingMessage, rendered: RenderedMessage, draftId?: string): Promise<SavedDraft> {
  if (!draftId) {
    const draft = await create(account, input, rendered);
    return { id: draft.id, messageId: draft.id, threadId: draft.conversationId };
  }
  // Gone (sent or deleted elsewhere): the 404 tells drafts.ts to start a new one.
  const draft = await graph<Draft>(account.id, `/me/messages/${draftId}`, { method: "PATCH", body: fields(input, rendered) });
  await syncAttachments(account, draft.id, files(rendered), false);
  return { id: draft.id, messageId: draft.id, threadId: draft.conversationId };
}

/** Sends a message: built as a draft, then sent. The sent copy lands in Sent Items in the same conversation. */
export async function send(account: AccountRow, input: OutgoingMessage, rendered: RenderedMessage) {
  const draft = await create(account, input, rendered);
  await graph(account.id, `/me/messages/${draft.id}/send`, { method: "POST" });
  return { id: draft.id, threadId: draft.conversationId };
}
