import { NextResponse } from "next/server";
import * as z from "zod";
import { ComposeDraft, draftFromPayload } from "@/lib/mail/compose";
import { fillBlanks, messageBlanks } from "@/lib/rules/prepared";
import { getAccount } from "@/server/db";
import { discardDraft, outgoingFromDraft } from "@/server/drafts";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { cancelScheduled, getScheduledPayload, scheduleMessage } from "@/server/scheduled";
import { deliver, holdMessage, notifyChanged } from "@/server/sync";

export const runtime = "nodejs";

const SendRequest = ComposeDraft.extend({
  sendAt: z.string().optional(),
  remindDays: z.number().optional(),
  /** Undo send: seconds to hold the message before it goes (0 sends at once). */
  hold: z.number().int().min(0).max(30).optional(),
});

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = SendRequest.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    const error = ["to", "cc", "bcc"].includes(field) ? "Invalid recipient" : field === "subject" ? "Invalid header" : (issue?.message ?? "Invalid message");
    return NextResponse.json({ error }, { status: 400 });
  }
  const draft = parsed.data;
  const account = getAccount(draft.accountId);
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  if (!draft.to.length && !draft.cc.length && !draft.bcc.length) return NextResponse.json({ error: "Invalid recipient" }, { status: 400 });
  if (!draft.body.trim() && !draft.design && !draft.attachments.length && draft.quote?.mode !== "forward") {
    return NextResponse.json({ error: "Empty message" }, { status: 400 });
  }
  const remindDays = draft.remindDays && draft.remindDays > 0 && draft.remindDays <= 60 ? Math.round(draft.remindDays) : null;
  const message = outgoingFromDraft(account, draft);
  // Once it's sent or queued, the draft has done its job. Its files stay for the message.
  const dropDraft = () => (draft.draftId ? discardDraft(account, { draftId: draft.draftId }, true).catch(() => {}) : undefined);

  if (draft.separately && draft.to.length > 1) {
    // One copy per person, their own blanks filled; each held, scheduled or sent like a single message.
    const copies = draft.to.map((person) =>
      outgoingFromDraft(account, { ...draft, to: [person], cc: [], bcc: [], body: fillBlanks(draft.body, messageBlanks({ name: person.name ?? "", email: person.email }, draft.subject)).body }),
    );
    const at = draft.sendAt ? new Date(draft.sendAt) : null;
    if (at && !Number.isNaN(at.getTime()) && at.getTime() > Date.now() + 30_000) {
      const ids = copies.map((copy) => scheduleMessage(account.id, copy, at.toISOString(), remindDays));
      await dropDraft();
      notifyChanged(account.id);
      return NextResponse.json({ ok: true, scheduled: ids.join(",") });
    }
    if (draft.hold) {
      const held = copies.map((copy, i) => holdMessage(account, copy, draft.hold!, remindDays, i === 0 ? draft.draftId : undefined));
      return NextResponse.json({ ok: true, held: held.map((h) => h.id).join(","), sendAt: held[0].sendAt });
    }
    try {
      for (const copy of copies) await deliver(account, copy, remindDays);
      await dropDraft();
      return NextResponse.json({ ok: true, sent: copies.length });
    } catch (error) {
      return errorResponse(error);
    }
  }

  const sendAt = draft.sendAt ? new Date(draft.sendAt) : null;
  if (sendAt && !Number.isNaN(sendAt.getTime()) && sendAt.getTime() > Date.now() + 30_000) {
    const id = scheduleMessage(account.id, message, sendAt.toISOString(), remindDays);
    await dropDraft();
    notifyChanged(account.id);
    return NextResponse.json({ ok: true, scheduled: id });
  }

  if (draft.hold) {
    // The Gmail draft stays until the message goes, so Undo can reopen it.
    const held = holdMessage(account, message, draft.hold, remindDays, draft.draftId);
    return NextResponse.json({ ok: true, held: held.id, sendAt: held.sendAt });
  }

  try {
    const sent = await deliver(account, message, remindDays);
    await dropDraft();
    return NextResponse.json({ ok: true, id: sent.id, threadId: sent.threadId });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Cancels a scheduled message and returns it as a draft so it can be edited. */
export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  // Several ids (comma-separated): the copies of one message sent separately, cancelled together.
  const ids = (new URL(request.url).searchParams.get("scheduled") ?? "").split(",").filter(Boolean);
  if (!ids.length) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const payloads = ids.map((id) => ({ id, payload: getScheduledPayload(id) }));
  const cancelled = payloads.filter(({ id, payload }) => payload && cancelScheduled(id));
  if (!cancelled.length) return NextResponse.json({ error: "Already sent or cancelled" }, { status: 409 });
  const first = cancelled[0].payload!;
  notifyChanged(first.accountId);
  const draft = draftFromPayload(first.accountId, first.message as unknown as Record<string, unknown>);
  return NextResponse.json({ ok: true, accountId: first.accountId, draft });
}
