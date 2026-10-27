import "server-only";

import { boundary } from "../../mail/mime";
import { ProviderError } from "../../mail/errors";
import { mapLimit } from "../../mail/parse";
import type { GmailMessage, GmailThread } from "./convert";
import { getAccessToken } from "./oauth";

// Gmail REST calls, one function per endpoint. Only this folder uses them; the rest of Kite goes
// through the provider in index.ts.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
/** Media upload endpoint: takes the raw message as bytes, up to 35 MB (the JSON API caps out far sooner). */
const UPLOAD_API = "https://gmail.googleapis.com/upload/gmail/v1/users/me";

export class GmailError extends ProviderError {
  constructor(message: string, status: number) {
    super(message, status, "Gmail");
  }
}

async function gmail<T>(accountId: string, path: string, init: RequestInit = {}, base = API): Promise<T> {
  const token = await getAccessToken(accountId);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
    });
    if (res.ok) return (res.status === 204 ? null : await res.json()) as T;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= 2) {
      const detail = await res.text();
      throw new GmailError(`Gmail ${init.method ?? "GET"} ${path.split("?")[0]} failed (${res.status}): ${detail.slice(0, 200)}`, res.status);
    }
    await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
}

const METADATA = ["From", "To", "Cc", "Reply-To", "Subject", "Date", "Message-ID", "References", "List-Unsubscribe", "List-Unsubscribe-Post"]
  .map((h) => `metadataHeaders=${h}`)
  .join("&");

export function getThread(accountId: string, threadId: string, full: boolean) {
  return gmail<GmailThread>(accountId, `/threads/${threadId}?${full ? "format=full" : `format=metadata&${METADATA}`}`);
}

/** A message in full, or just the headers (From, To, Cc, Reply-To, ids). */
export function getMessage(accountId: string, messageId: string, full: boolean) {
  return gmail<GmailMessage>(accountId, `/messages/${messageId}?${full ? "format=full" : `format=metadata&${METADATA}`}`);
}

/** Bytes of one attachment (base64url from Gmail). */
export async function getAttachmentData(accountId: string, messageId: string, attachmentId: string) {
  const res = await gmail<{ data: string }>(accountId, `/messages/${messageId}/attachments/${attachmentId}`);
  return Buffer.from(res.data, "base64url");
}

/** Thread ids for a list query, up to `max` (500 a page, Gmail's most); `onPage` sees each page as it arrives. */
export async function listThreadIds(accountId: string, params: string, max: number, onPage?: (ids: string[]) => void) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail<{ threads?: { id: string }[]; nextPageToken?: string }>(
      accountId,
      `/threads?maxResults=${Math.min(500, max - ids.length)}&${params}${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    const found = (page.threads ?? []).map((t) => t.id);
    ids.push(...found);
    onPage?.(found);
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

export async function listMessageIds(accountId: string, params: string, max: number) {
  const ids: string[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(
      accountId,
      `/messages?maxResults=500&${params}${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    ids.push(...(page.messages ?? []).map((m) => m.id));
    pageToken = page.nextPageToken;
  } while (pageToken && ids.length < max);
  return ids;
}

export async function batchModify(accountId: string, ids: string[], add: string[], remove: string[]) {
  for (let i = 0; i < ids.length; i += 1000) {
    await gmail(accountId, "/messages/batchModify", {
      method: "POST",
      body: JSON.stringify({ ids: ids.slice(i, i + 1000), addLabelIds: add, removeLabelIds: remove }),
    });
  }
}

export async function modifyThread(accountId: string, threadId: string, add: string[], remove: string[]) {
  await gmail(accountId, `/threads/${threadId}/modify`, {
    method: "POST",
    body: JSON.stringify({ addLabelIds: add, removeLabelIds: remove }),
  });
}

/** Gmail's trash and untrash endpoints, for threads or messages. */
export async function trash(accountId: string, kind: "threads" | "messages", ids: string[], undo: boolean) {
  await mapLimit(ids, 5, (id) => gmail(accountId, `/${kind}/${id}/${undo ? "untrash" : "trash"}`, { method: "POST" }));
}

export function profile(accountId: string) {
  return gmail<{ emailAddress: string; historyId: string }>(accountId, "/profile");
}

type HistoryPage = {
  history?: {
    messagesAdded?: { message: { threadId: string } }[];
    messagesDeleted?: { message: { threadId: string } }[];
    labelsAdded?: { message: { threadId: string } }[];
    labelsRemoved?: { message: { threadId: string } }[];
  }[];
  historyId: string;
  nextPageToken?: string;
};

/** Thread ids changed since `startHistoryId`, and the new history id. Throws GmailError 404 when too old. */
export async function changedThreads(accountId: string, startHistoryId: string) {
  const changed = new Set<string>();
  let pageToken: string | undefined;
  let historyId = startHistoryId;
  do {
    const page = await gmail<HistoryPage>(
      accountId,
      `/history?startHistoryId=${startHistoryId}&maxResults=500${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    for (const entry of page.history ?? []) {
      for (const list of [entry.messagesAdded, entry.messagesDeleted, entry.labelsAdded, entry.labelsRemoved]) {
        for (const item of list ?? []) changed.add(item.message.threadId);
      }
    }
    historyId = page.historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { changed: [...changed], historyId };
}

type GmailLabel = {
  id: string;
  name: string;
  type: "system" | "user";
  labelListVisibility?: "labelShow" | "labelShowIfUnread" | "labelHide";
  color?: { backgroundColor?: string; textColor?: string };
};

/** Every label in the mailbox, system and user. */
export async function listLabels(accountId: string) {
  return (await gmail<{ labels?: GmailLabel[] }>(accountId, "/labels")).labels ?? [];
}

/** A new user label, shown in the label list and on messages (gmail.modify covers labels). */
export function createLabel(accountId: string, name: string) {
  return gmail<GmailLabel>(accountId, "/labels", {
    method: "POST",
    body: JSON.stringify({ name, labelListVisibility: "labelShow", messageListVisibility: "show" }),
  });
}

export function renameLabel(accountId: string, id: string, name: string) {
  return gmail<GmailLabel>(accountId, `/labels/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

/** Removes the label from Gmail and from every message carrying it (the messages stay). */
export async function deleteLabel(accountId: string, id: string) {
  await gmail<null>(accountId, `/labels/${encodeURIComponent(id)}`, { method: "DELETE" });
}

// Gmail filters (users.settings.filters, needs gmail.settings.basic). Filters can't be edited:
// a change deletes and recreates. Only filters.ts calls these, on Kite's own filters.

export type GmailFilter = {
  id: string;
  criteria?: Record<string, unknown>;
  action?: { addLabelIds?: string[]; removeLabelIds?: string[]; forward?: string };
};

export async function listFilters(accountId: string) {
  return (await gmail<{ filter?: GmailFilter[] }>(accountId, "/settings/filters")).filter ?? [];
}

export function createFilter(accountId: string, filter: Omit<GmailFilter, "id">) {
  return gmail<GmailFilter>(accountId, "/settings/filters", { method: "POST", body: JSON.stringify(filter) });
}

/** Deletes one filter; one already gone counts as done. */
export async function deleteFilter(accountId: string, id: string) {
  try {
    await gmail(accountId, `/settings/filters/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (error) {
    if (!(error instanceof GmailError && error.status === 404)) throw error;
  }
}

/** Posts a raw message to the media upload endpoint, with JSON metadata alongside. */
export function uploadMime<T>(accountId: string, path: string, method: "POST" | "PUT", metadata: unknown, mime: string) {
  const b = boundary();
  const body = [`--${b}`, "Content-Type: application/json; charset=UTF-8", "", JSON.stringify(metadata), `--${b}`, "Content-Type: message/rfc822", "", mime, `--${b}--`, ""].join(
    "\r\n",
  );
  return gmail<T>(
    accountId,
    `${path}${path.includes("?") ? "&" : "?"}uploadType=multipart`,
    { method, body, headers: { "content-type": `multipart/related; boundary=${b}` } },
    UPLOAD_API,
  );
}

export type GmailDraft = { id: string; message: GmailMessage };

export function deleteDraft(accountId: string, draftId: string) {
  return gmail<null>(accountId, `/drafts/${draftId}`, { method: "DELETE" });
}

export function getDraft(accountId: string, draftId: string) {
  return gmail<GmailDraft>(accountId, `/drafts/${draftId}?format=full`);
}

/** Every draft's id with its current message id. */
export async function listDrafts(accountId: string, max = 500) {
  const drafts: { id: string; message: { id: string; threadId: string } }[] = [];
  let pageToken: string | undefined;
  do {
    const page = await gmail<{ drafts?: typeof drafts; nextPageToken?: string }>(
      accountId,
      `/drafts?maxResults=100${pageToken ? `&pageToken=${pageToken}` : ""}`,
    );
    drafts.push(...(page.drafts ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken && drafts.length < max);
  return drafts;
}
