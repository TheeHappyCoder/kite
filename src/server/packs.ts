import "server-only";

import { ATTACHMENT_LIMIT_BYTES, emptyDraft, type AttachmentRef, type ComposeDraft } from "@/lib/mail/compose";
import { escapeInline } from "@/lib/mail/body";
import type { CollectionRow } from "@/lib/automations/collections";
import type { Thread } from "@/lib/mail/types";
import { formatAmount } from "@/lib/automations/values";
import { collectionName, rowsBetween } from "./collections";
import { listAccounts } from "./db";
import { getThreadRow } from "./store";

// The month-end pack: a collection's rows from one period as one email to your accountant. Every
// file those emails carried is attached (as references to the stored mail, read again at send
// time, up to the attachment limit); emails that only had a link (a supplier's portal) are listed
// to download yourself, with the link the automation read. Built on demand from the collection
// view, or by a schedule's `pack` verb (server/schedules.ts). Nothing is sent from here.

export type PackSummary = {
  rows: number;
  files: number;
  /** Rows whose email had no file but a link to one. */
  links: number;
  /** Rows with neither. */
  missing: number;
  /** Files left out to stay under the attachment limit. */
  tooBig: number;
};

/** The files an email carried (not pictures shown inside it). */
function filesOf(row: CollectionRow) {
  const stored = getThreadRow(row.threadId);
  if (!stored) return [];
  const thread = JSON.parse(stored.data) as Thread;
  const message = thread.messages.find((m) => m.id === row.messageId);
  return (message?.attachments ?? []).filter((a) => !a.inline && a.partId);
}

const linkOf = (row: CollectionRow) => row.columns.flatMap((c) => (c.type === "link" && row.values[c.key]?.text ? [row.values[c.key]!.text] : []))[0] ?? null;

/** "R 349.00" when the row has an amount. */
function amountOf(row: CollectionRow) {
  const column = row.columns.find((c) => c.type === "money");
  const v = column ? row.values[column.key] : null;
  return v?.number != null ? formatAmount(v.number, v.currency ?? "") : null;
}

/** "**Takealot**: Your invoice INV-2231 (R 349.00)" */
function line(row: CollectionRow) {
  const amount = amountOf(row);
  return `**${escapeInline(row.sender || "Unknown")}**: ${escapeInline(row.subject || "(no subject)")}${amount ? ` (${escapeInline(amount)})` : ""}`;
}

/**
 * The pack for `[start, end)`: a ready-to-send draft and what's in it. `accountId` sends it (else
 * the account most of the rows came to).
 */
export function buildPack(input: { collectionId: string; start: Date; end: Date; periodName: string; to: string; subject: string; accountId?: string }): { draft: ComposeDraft; summary: PackSummary } {
  const rows = rowsBetween(input.collectionId, input.start.toISOString(), input.end.toISOString());
  const accounts = listAccounts();
  const counts = new Map<string, number>();
  rows.forEach((r) => counts.set(r.accountId, (counts.get(r.accountId) ?? 0) + 1));
  const accountId = input.accountId && accounts.some((a) => a.id === input.accountId) ? input.accountId : ([...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? accounts[0]?.id ?? "");

  const attachments: AttachmentRef[] = [];
  const linked: CollectionRow[] = [];
  const missing: CollectionRow[] = [];
  const tooBig: string[] = [];
  let bytes = 0;
  for (const row of rows) {
    const files = filesOf(row);
    if (!files.length) {
      (linkOf(row) ? linked : missing).push(row);
      continue;
    }
    for (const file of files) {
      const size = file.bytes ?? 0;
      if (bytes + size > ATTACHMENT_LIMIT_BYTES || attachments.length >= 50) {
        tooBig.push(`${line(row)}: ${escapeInline(file.name)}`);
        continue;
      }
      bytes += size;
      attachments.push({
        type: "message",
        accountId: row.accountId === accountId ? undefined : row.accountId,
        messageId: row.messageId,
        partId: file.partId!,
        name: file.name,
        mimeType: file.mimeType ?? "application/octet-stream",
        bytes: size,
      });
    }
  }

  const name = collectionName(input.collectionId) ?? "Collection";
  const subject = input.subject.replace(/\{period\}/g, input.periodName).replace(/\{collection\}/g, name).trim() || `${name}: ${input.periodName}`;
  const body: string[] = ["Hi,", ""];
  if (!rows.length) body.push(`There was nothing in ${escapeInline(name)} for ${escapeInline(input.periodName)}.`);
  else {
    body.push(
      attachments.length
        ? `Here's everything for ${escapeInline(input.periodName)}: ${attachments.length} file${attachments.length === 1 ? "" : "s"} attached.`
        : `Here's what came in for ${escapeInline(input.periodName)}.`,
    );
    if (linked.length) {
      body.push("", "These only came as a link, so I'll download them and send them on:");
      for (const row of linked) body.push(`- ${line(row)}: [download](${linkOf(row)})`);
    }
    if (missing.length) {
      body.push("", "No file came with these:");
      for (const row of missing) body.push(`- ${line(row)}`);
    }
    if (tooBig.length) {
      body.push("", "Too big to fit in this email, coming separately:");
      for (const l of tooBig) body.push(`- ${l}`);
    }
  }
  body.push("", "Thanks");

  return {
    draft: { ...emptyDraft(accountId), to: [{ email: input.to }], subject, body: body.join("\n"), attachments },
    summary: { rows: rows.length, files: attachments.length, links: linked.length, missing: missing.length, tooBig: tooBig.length },
  };
}

/** A calendar month ("2026-10") as the pack's period. */
export function monthPeriod(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(y, m - 1, 1);
  return { start, end: new Date(y, m, 1), name: start.toLocaleString("en-GB", { month: "long", year: "numeric" }) };
}
