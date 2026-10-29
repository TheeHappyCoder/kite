"use client";

import { useCallback, useState } from "react";
import { format } from "date-fns";
import { compileText } from "@/lib/design/compile";
import { escapeMarkup } from "@/lib/mail/body";
import { draftFromPayload, replyDraft, type AttachmentRef, type ComposeDraft, type Recipient, type ReplyMode } from "@/lib/mail/compose";
import { splitMessage } from "@/lib/mail/quotes";
import type { MailAction } from "@/lib/mail/store";
import { threadKey } from "@/lib/mail/threads";
import type { Account, Thread } from "@/lib/mail/types";
import type { PreparedReply } from "@/lib/rules/prepared";
import type { Preferences } from "@/lib/settings";
import type { AttachContext } from "../../files/attach-picker";
import type { CloseResult } from "../compose";
import type { SendOptions } from "../send-menu";
import { demoBody, postJson, type Reload, type SetToast } from "./util";

/** Who a message goes to, for the toast: "Sam", "Sam and Alex", "Sam and 2 others". */
function whoTo(draft: Partial<ComposeDraft>) {
  const names = [...(draft.to ?? []), ...(draft.cc ?? []), ...(draft.bcc ?? [])].map((r) => r.name?.split(/\s+/)[0] || r.email);
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]} and ${names.length - 1} others`;
}

type OpenCompose = (initial?: Partial<ComposeDraft>, context?: AttachContext, options?: { key?: string; force?: boolean }) => void;

/**
 * Writing and sending: quick replies, compose windows (reply / reply all / forward, drafts,
 * scheduled messages), Undo send, replies rules prepared, and address suggestions. Demo mode keeps
 * what you send on the page.
 */
export function useSending({
  live,
  accounts,
  threads,
  selected,
  preferences,
  dispatch,
  setToast,
  reload,
  openCompose,
  closeComposer,
  composeFull,
  moveThread,
  archiveQuietly,
  serviceOf,
}: {
  live: boolean;
  accounts: Account[];
  threads: Thread[];
  selected: Thread | null;
  preferences: Preferences;
  dispatch: React.Dispatch<MailAction>;
  setToast: SetToast;
  reload: Reload;
  openCompose: OpenCompose;
  closeComposer: (id: number) => void;
  composeFull: () => boolean;
  moveThread: (id: string | undefined, patch: Partial<Thread>, message: string) => void;
  /** Send and archive: archives the answered conversation, returning what puts it back. */
  archiveQuietly: (id: string) => (() => void) | null;
  serviceOf: (accountIds: string[]) => string;
}) {
  /** Replies rules prepared, by Kite thread id (null: none), loaded with the conversation. */
  const [prepared, setPrepared] = useState<Record<string, PreparedReply | null>>({});

  const cancelScheduled = async (scheduledId: string) => {
    const res = await postJson<{ accountId: string; draft: ComposeDraft }>(`/api/mail/send?scheduled=${scheduledId}`, null, "DELETE");
    reload();
    return res;
  };

  /** Undo send: cancels the held message and reopens it in compose, unchanged. */
  const undoSend = async (heldId: string, draft: Partial<ComposeDraft>) => {
    try {
      await postJson(`/api/mail/send?scheduled=${heldId}`, null, "DELETE");
    } catch {
      setToast({ message: "Too late, it's already sent" });
      return;
    }
    openCompose(draft, undefined, { force: true });
  };

  /**
   * Sends now (held for Undo when that's on) or schedules, then reports what happened. With
   * `archive` (Send and archive), the answered conversation (`threadId`, a Kite id) leaves the Inbox
   * once the message is accepted; the same Undo puts it back.
   */
  const send = async (payload: Partial<ComposeDraft>, { archive, ...options }: SendOptions, threadId?: string) => {
    // Scheduled sends aren't held: they can be cancelled from Scheduled.
    const hold = options.sendAt ? 0 : preferences.compose.undoSend;
    const who = whoTo(payload);
    const sending = `Sending${who ? ` to ${who}` : ""}…`;
    setToast({ message: options.sendAt ? "Scheduling…" : sending, busy: true });
    const res = await postJson<{ scheduled?: string; held?: string }>("/api/mail/send", { ...payload, ...options, hold });
    const unarchive = archive && threadId ? archiveQuietly(threadId) : null;
    const and = unarchive ? " and archived" : "";
    const sentTo = `Sent${who ? ` to ${who}` : ""}${and}`;
    const sent = options.remindDays ? `${sentTo}. Kite will nudge you in ${options.remindDays}d if no one replies` : sentTo;
    if (res.held) {
      const heldId = res.held;
      setToast({
        message: sending,
        held: { id: heldId, seconds: hold, sent },
        onUndo: () => {
          unarchive?.();
          void undoSend(heldId, payload);
        },
      });
    } else if (res.scheduled) {
      const scheduledId = res.scheduled;
      setToast({
        message: `Scheduled for ${format(new Date(options.sendAt!), "EEE d MMM, HH:mm")}${and}`,
        onUndo: () => {
          unarchive?.();
          void cancelScheduled(scheduledId).catch(() => {});
        },
      });
    } else {
      setToast({ message: sent, onUndo: unarchive ?? undefined });
    }
    reload();
  };

  /** Discard, or the prepared reply went out (sent, or moved into a compose window). Nothing is sent here. */
  const dropPrepared = (thread: Thread) => {
    const reply = prepared[thread.id];
    if (!reply) return;
    setPrepared((current) => ({ ...current, [thread.id]: null }));
    fetch(`/api/mail/threads/${threadKey(thread)}/prepared?account=${thread.accountId}&reply=${reply.id}`, { method: "DELETE" }).catch(() => {});
  };

  const sendReply = (text: string, options: SendOptions, withSignature: boolean) => {
    if (!selected) return;
    const account = accounts.find((a) => a.id === selected.accountId)!;
    const sent = selected.messages.filter((m) => !m.draft);
    const last = sent[sent.length - 1] ?? selected.messages[selected.messages.length - 1];
    const draft = { ...replyDraft({ mode: "reply", message: last, subject: selected.subject, accountId: account.id, me: account.email, threadId: selected.remoteId }), body: text, signature: withSignature };
    if (!live) {
      if (!options.sendAt) {
        dispatch({
          type: "patch",
          id: selected.id,
          patch: {
            messages: [
              ...selected.messages,
              {
                id: crypto.randomUUID(),
                from: { name: "You", email: account.email },
                to: draft.to.map((r) => ({ name: r.name ?? r.email, email: r.email })),
                date: new Date().toISOString(),
                body: demoBody(text, withSignature ? preferences.signatures[account.id] : undefined).split(/\n{2,}/),
              },
            ],
          },
        });
      }
      const unarchive = options.archive ? archiveQuietly(selected.id) : null;
      setToast({
        message: options.sendAt ? "Scheduled (demo mode, nothing will send)" : `Reply sent${unarchive ? " and archived" : ""} (demo mode, nothing left your device)`,
        onUndo: unarchive ?? undefined,
      });
      return;
    }
    if (!draft.to.length) {
      setToast({ message: "There's no one to reply to in this conversation." });
      return;
    }
    dropPrepared(selected);
    // The quick reply is already cleared: if it doesn't go, it opens in compose so nothing is lost.
    send(draft, options, selected.id).catch((error) => {
      const reason = error instanceof Error && error.message !== "Request failed" ? `${error.message}. ` : "";
      setToast({ message: `Reply couldn't be sent. ${reason}It's open in compose to try again.` });
      openCompose(draft, { threadId: selected.id }, { key: `reply:${selected.id}`, force: true });
    });
  };

  /**
   * Opens the compose window to reply, reply to all or forward the selected conversation, or another
   * one by id (Fill & sign's "Reply with signed copy", which also passes the file to attach).
   */
  const startCompose = async (mode: ReplyMode, body = "", target?: { threadId: string; attachments?: AttachmentRef[] }) => {
    const thread = target ? threads.find((t) => t.id === target.threadId) : selected;
    const threadId = target?.threadId ?? thread?.id;
    if (!threadId || thread?.scheduled) return;
    const accountId = thread?.accountId ?? accounts.find((a) => threadId.startsWith(`${a.id}:`))?.id;
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;
    try {
      let draft: ComposeDraft;
      if (live && (!thread || thread.remoteId)) {
        const key = thread ? threadKey(thread) : threadId.slice(account.id.length + 1);
        const res = await fetch(`/api/mail/compose?account=${account.id}&thread=${key}&mode=${mode}`);
        const data = (await res.json()) as { draft?: ComposeDraft; error?: string };
        if (!res.ok || !data.draft) throw new Error(data.error);
        draft = data.draft;
      } else if (thread) {
        const sent = thread.messages.filter((m) => !m.draft);
        const last = sent[sent.length - 1] ?? thread.messages[thread.messages.length - 1];
        draft = replyDraft({ mode, message: last, subject: thread.subject, accountId: account.id, me: account.email });
      } else return;
      // The answered message's new text orders the file picker ("asked for"); it stays in the browser.
      const answered = mode === "forward" ? undefined : thread?.messages.find((m) => m.id === draft.quote?.messageId);
      const ask = answered ? splitMessage(answered).text.fresh || answered.snippet || "" : "";
      const attachments = [...(draft.attachments ?? []), ...(target?.attachments ?? [])];
      // A second reply to the same conversation brings the open one forward (unless it carries a file).
      const key = target?.attachments?.length ? undefined : `${mode === "forward" ? "forward" : "reply"}:${threadId}`;
      openCompose({ ...draft, body, attachments }, { threadId, ask }, { key });
    } catch {
      setToast({ message: "Couldn't open that conversation to reply. Try again." });
    }
  };

  /**
   * Address suggestions: the local store for live accounts, the people on screen in demo mode.
   * `role` is a search's `from:` / `to:` (people who wrote to you, or you wrote to).
   */
  const searchContacts = useCallback(
    async (query: string, role?: "from" | "to"): Promise<Recipient[]> => {
      if (live) {
        const res = await fetch(`/api/contacts?q=${encodeURIComponent(query)}${role ? `&role=${role}` : ""}`);
        return ((await res.json()) as { contacts: Recipient[] }).contacts ?? [];
      }
      const q = query.toLowerCase();
      const own = new Set(accounts.map((a) => a.email.toLowerCase()));
      const seen = new Map<string, Recipient>();
      for (const m of threads.flatMap((t) => t.messages)) {
        for (const c of role === "from" ? [m.from] : role === "to" ? m.to : [m.from, ...m.to]) {
          const email = c.email.toLowerCase();
          if (!own.has(email) && c.name !== "You" && !seen.has(email) && (email.includes(q) || c.name.toLowerCase().includes(q))) {
            seen.set(email, { name: c.name, email: c.email });
          }
        }
      }
      return [...seen.values()].slice(0, 8);
    },
    [live, accounts, threads],
  );

  /**
   * A compose window's Send; `threadId` is the conversation it answers (Kite id), for Send and archive.
   * The window steps aside at once (the toast says it's sending) and comes back if it fails.
   */
  const sendDraft = async (id: number, draft: ComposeDraft, options: SendOptions, draftId: Promise<string | undefined>, threadId?: string) => {
    const account = accounts.find((a) => a.id === draft.accountId)!;
    if (live) {
      try {
        const who = whoTo(draft);
        setToast({ message: options.sendAt ? "Scheduling…" : `Sending${who ? ` to ${who}` : ""}…`, busy: true });
        await send({ ...draft, draftId: await draftId }, options, threadId);
      } catch (error) {
        setToast({ message: "Message couldn't be sent" });
        throw new Error(error instanceof Error && error.message !== "Request failed" ? error.message : "Message couldn't be sent. Check the addresses and try again.");
      }
      closeComposer(id);
      return;
    }
    const thread: Thread = {
      id: crypto.randomUUID(),
      accountId: draft.accountId,
      subject: draft.subject || "(no subject)",
      mailbox: "sent",
      category: "important",
      unread: false,
      starred: false,
      messages: [
        {
          id: crypto.randomUUID(),
          from: { name: "You", email: account.email },
          to: draft.to.map((r) => ({ name: r.name ?? r.email, email: r.email })),
          cc: draft.cc.length ? draft.cc.map((r) => ({ name: r.name ?? r.email, email: r.email })) : undefined,
          date: new Date().toISOString(),
          body: demoBody(draft.design ? escapeMarkup(compileText(draft.design)) : draft.body, draft.signature ? preferences.signatures[account.id] : undefined).split(/\n{2,}/),
        },
      ],
    };
    dispatch({ type: "replace", threads: [thread, ...threads] });
    closeComposer(id);
    const unarchive = options.archive && threadId ? archiveQuietly(threadId) : null;
    setToast({ message: `Message sent${unarchive ? " and archived" : ""} (demo mode, nothing left your device)`, onUndo: unarchive ?? undefined });
  };

  const saveDraft = useCallback((draft: ComposeDraft) => postJson<{ draftId: string }>("/api/mail/drafts", draft), []);
  const discardDraft = useCallback(async (ref: { accountId: string; draftId: string }) => {
    await postJson(`/api/mail/drafts?account=${ref.accountId}&id=${encodeURIComponent(ref.draftId)}`, null, "DELETE");
  }, []);

  const closeCompose = (id: number, pending: Promise<CloseResult>) => {
    closeComposer(id);
    pending
      .then((result) => {
        if (result.failed) setToast({ message: `The draft couldn't be saved to ${serviceOf([])}.` });
        else if (result.saved) setToast({ message: "Draft saved" });
      })
      .catch(() => {});
  };

  /** The reader's draft banner: reopen the draft in compose, or discard it. */
  const onDraft = async (action: "edit" | "discard") => {
    if (!selected) return;
    const draftMessage = [...selected.messages].reverse().find((m) => m.draft) ?? selected.messages[selected.messages.length - 1];
    if (!live || !selected.remoteId) {
      if (action === "discard") moveThread(selected.id, { mailbox: "archive" }, "Draft discarded");
      else openCompose({ accountId: selected.accountId, subject: selected.subject, body: draftMessage.body.join("\n\n"), to: draftMessage.to.map((c) => ({ email: c.email })) }, undefined, { key: `reply:${selected.id}` });
      return;
    }
    const query = `account=${selected.accountId}&message=${draftMessage.id}&thread=${selected.remoteId}`;
    try {
      if (action === "edit") {
        const res = await fetch(`/api/mail/drafts?${query}`);
        const data = (await res.json()) as { draft?: ComposeDraft; error?: string };
        if (!res.ok || !data.draft) throw new Error(data.error ?? "That draft couldn't be opened.");
        openCompose(data.draft, undefined, { key: `reply:${selected.id}` });
      } else {
        // Gone from the reader at once (and the banner with it), as "Delete this message" does.
        const thread = selected;
        dispatch({ type: "patch", id: thread.id, patch: { messages: thread.messages.filter((m) => !m.draft) } });
        const { ok } = await postJson<{ ok: boolean }>(`/api/mail/drafts?${query}`, null, "DELETE");
        setToast({ message: ok ? "Draft discarded" : "That draft was already sent or deleted." });
        reload();
      }
    } catch (error) {
      setToast({ message: error instanceof Error && error.message !== "Request failed" ? error.message : "That draft couldn't be changed. Try again." });
      reload();
    }
  };

  const onScheduled = async (action: "send-now" | "edit") => {
    if (!selected?.scheduled) return;
    // Check for room first: cancelling takes it out of Scheduled.
    if (action === "edit" && composeFull()) return;
    try {
      const { accountId, draft } = await cancelScheduled(selected.scheduled.id);
      const editable = draft ?? draftFromPayload(accountId, {});
      if (action === "edit") openCompose(editable);
      else await send(editable, { remindDays: selected.scheduled.remindDays ?? undefined });
    } catch {
      setToast({ message: "It already went out." });
      reload();
    }
  };

  return {
    prepared,
    setPrepared,
    dropPrepared,
    send,
    sendReply,
    startCompose,
    searchContacts,
    sendDraft,
    saveDraft,
    discardDraft,
    closeCompose,
    onDraft,
    onScheduled,
  };
}
