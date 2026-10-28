"use client";

import { useState } from "react";
import type { MailBatchRequest, MailBatchPreview, MailBatchResult } from "@/lib/mail/batch";
import { mailChanges } from "@/lib/mail/pending-changes";
import { Dialog } from "../ui/dialog";
import { Select } from "../ui/select";
import { postJson } from "./app/util";

type Toast = { message: string; onUndo?: () => void };

/** Server previews pin the exact message IDs and account counts before a bulk change. */
export function useMailBatch(onToast: (toast: Toast) => void, onChanged: () => void) {
  const [request, setRequest] = useState<MailBatchRequest | null>(null);
  const [preview, setPreview] = useState<MailBatchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [inboxOnly, setInboxOnly] = useState(true);
  const [result, setResult] = useState<MailBatchResult | null>(null);
  const open = (input: MailBatchRequest) => {
    setRequest(input);
    setInboxOnly(input.inboxOnly ?? true);
    setPreview(null);
    setError("");
    setResult(null);
  };
  const review = async () => {
    if (!request) return;
    setBusy(true);
    setError("");
    try {
      setPreview(await postJson<MailBatchPreview>("/api/mail/batch", { kind: "preview", ...request, inboxOnly: request.senders ? inboxOnly : false }));
    } catch (e) { setError(e instanceof Error ? e.message : "Couldn't review that mail."); }
    finally { setBusy(false); }
  };
  const undo = async (token: string) => {
    const finish = mailChanges.begin();
    try {
      const result = await postJson<{ failed: number; undo?: string }>("/api/mail/batch", { kind: "undo", token });
      onToast({ message: result.failed ? `${result.failed} emails couldn't be restored. Try Undo again.` : "Mail restored", onUndo: result.undo ? () => void undo(result.undo!) : undefined });
    } catch (e) { onToast({ message: e instanceof Error ? e.message : "Couldn't restore that mail." }); }
    finally { finish(); onChanged(); }
  };
  const execute = async () => {
    if (!preview || !request) return;
    setBusy(true);
    const finish = mailChanges.begin();
    try {
      const result = await postJson<MailBatchResult>("/api/mail/batch", { kind: "execute", token: preview.token });
      const verb = request.action === "permanent" ? "permanently deleted" : request.action === "trash" ? "moved to Trash" : "archived";
      onToast({ message: `${result.done} emails ${verb}${result.failed ? `; ${result.failed} failed` : ""}${result.skipped ? `; ${result.skipped} already changed` : ""}`, onUndo: result.undo ? () => void undo(result.undo!) : undefined });
      if (result.subscriptions?.length) setResult(result);
      else setRequest(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't change that mail.");
      setPreview(null);
    } finally { finish(); setBusy(false); onChanged(); }
  };
  const permanent = request?.action === "permanent";
  const label = permanent ? "Delete permanently" : request?.unsubscribe ? "Unsubscribe and delete" : request?.action === "archive" ? "Archive" : "Move to Trash";
  const dialog = (
    <Dialog open={!!request} onClose={() => { if (!busy) setRequest(null); }} title={permanent && !request?.threads ? "Empty Trash" : label}
      description={permanent ? "This cannot be undone in Kite. Only messages still in Trash will be deleted." : request?.unsubscribe ? "Unsubscribing cannot be undone. Deleted emails go to Trash and can be restored." : "Review the emails and accounts before making this change. You can Undo afterwards."}
      footer={<>
        <button disabled={busy} onClick={() => setRequest(null)} className="mr-auto rounded-full border border-pane-border px-4 py-2 text-sm disabled:opacity-50">{result ? "Done" : "Cancel"}</button>
        {!result ? <button disabled={busy || preview?.count === 0} onClick={() => void (preview ? execute() : review())} className="rounded-full bg-pane-fg px-4 py-2 text-sm font-medium text-pane disabled:opacity-50">
          {busy ? "Working…" : preview ? `${label} (${preview.count})` : "Review emails"}
        </button> : null}
      </>}
    >
      <div className="space-y-3 px-5 pb-5 text-sm">
        {result ? <>
          <p>{result.done} emails changed. {result.failed ? `${result.failed} failed.` : ""}</p>
          {result.subscriptions?.map((s) => <p key={s.email}>{s.email}: {s.note}{s.url ? <> <a href={s.url} target="_blank" rel="noreferrer" className="text-accent underline">Open website</a></> : null}</p>)}
        </> : null}
        {!result && request?.senders ? <>
          <p>{request.senders.length} {request.senders.length === 1 ? "sender" : "senders"} selected</p>
          <div className="flex items-center gap-2">Include
            <Select label="Which mail" disabled={busy} value={inboxOnly ? "inbox" : "all"} onChange={(v) => { setInboxOnly(v === "inbox"); setPreview(null); }}
              options={[{ value: "inbox", label: "Inbox only" }, { value: "all", label: "All mail from these senders" }]} />
          </div>
          <p className="text-xs text-pane-muted">All mail includes archived mail. Trash and spam are excluded. Other senders in the same conversation are left alone.</p>
        </> : null}
        {!result && preview ? <>
          <p>{preview.count ? `${preview.count} emails will be affected:` : "No emails match this selection."}</p>
          <ul>{preview.accounts.map((a) => <li key={a.email} className="flex justify-between gap-3 py-1"><span>{a.email}</span><span>{a.count}</span></li>)}</ul>
        </> : !result ? <p className="text-pane-muted">Review checks the mail service for the current count. This can take a moment for large selections.</p> : null}
        {error ? <p role="alert" className="text-warning">{error}</p> : null}
      </div>
    </Dialog>
  );
  return { open, dialog };
}
