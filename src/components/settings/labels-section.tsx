"use client";

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Add01Icon, Delete02Icon, Folder01Icon, PencilEdit01Icon, Tag01Icon } from "@hugeicons/core-free-icons";
import { accountSpec, canManage, labelDepth, leafName, serviceName, sortLabels, type LabelKind, type MailLabel, type ProviderSpec } from "@/lib/mail/providers";
import { accountName, type Account } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { buttonClass, Confirm, Group, Note, quietButtonClass } from "./settings-ui";
import { capitalise } from "@/lib/format";

// Settings → Labels: each account's own labels/folders, named the way its provider names them,
// made, renamed and deleted right there in the provider (server/labels.ts). What each provider
// allows comes from its spec (`manage`); nothing else is offered.

async function send<T>(url: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? "That didn't go through. Try again.");
  return data;
}

type Editing = { accountId: string; id: string | null; kind: LabelKind; name: string };

const nounOf = (spec: ProviderSpec, kind: LabelKind) => spec.organise[kind]?.noun ?? spec.organise.noun;

/** What deleting does, in one line, by kind and provider. */
function deleteLine(label: MailLabel, spec: ProviderSpec, service: string) {
  const noun = nounOf(spec, label.kind);
  if (label.kind === "folder") return `Delete the ${noun} “${label.name}” in ${service}? Only an empty ${noun} with nothing inside can go.`;
  const on = label.total ? ` It comes off ${label.total === 1 ? "the conversation" : `${label.total} conversations`} here` : " It comes off any mail carrying it";
  return `Delete the ${noun} “${label.name}” in ${service}?${on}; the mail stays where it is.`;
}

export function LabelsSection({ accounts, demo, onChanged, onToast }: { accounts: Account[]; demo: boolean; onChanged: () => void; onToast: (message: string) => void }) {
  const [labels, setLabels] = useState<MailLabel[] | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/labels")
      .then((res) => res.json())
      .then((data: { labels?: MailLabel[] }) => setLabels(data.labels ?? []))
      .catch(() => setLabels([]));
  }, []);
  useEffect(() => {
    if (!demo) load();
  }, [demo, load]);

  if (demo) return <Note>Connect an account to make, rename and delete its labels and folders here.</Note>;
  if (!labels) {
    return (
      <p className="flex items-center gap-2 px-1 text-[12.5px] text-pane-muted">
        <Spinner size={13} /> Reading your labels…
      </p>
    );
  }

  const run = async (work: () => Promise<unknown>, done: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      setEditing(null);
      setConfirming(null);
      onToast(done);
      load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't go through. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const save = (account: Account, spec: ProviderSpec) => {
    if (!editing) return;
    const noun = nounOf(spec, editing.kind);
    const name = editing.name.trim();
    if (editing.id) {
      const id = editing.id;
      void run(() => send("/api/labels", "PATCH", { account: account.id, id, name }), `Renamed to “${name}”`);
    } else {
      void run(() => send("/api/labels", "POST", { account: account.id, name, kind: editing.kind }), `${capitalise(noun)} “${name}” made in ${serviceName(account)}`);
    }
  };

  return (
    <div className="flex flex-col gap-8">
      {accounts.map((account) => {
        const spec = accountSpec(account);
        const service = serviceName(account);
        const own = sortLabels(
          labels.filter((l) => l.accountId === account.id),
          spec,
        );
        const creatable = (["folder", "tag"] as const).filter((kind) => spec.organise[kind] && canManage(spec, "create", kind));
        const adding = editing?.accountId === account.id && editing.id === null ? editing : null;
        return (
          <Group
            key={account.id}
            id={`Labels for ${accountName(account)}`}
            title={accounts.length > 1 ? `${accountName(account)} · ${service}` : capitalise(spec.organise.plural)}
            description={
              spec.organise.folder && spec.organise.tag
                ? `${capitalise(spec.organise.folder.plural)} hold the mail you file in them; ${spec.organise.tag.plural} stay with it wherever it is.`
                : `Changes here happen in ${service} at once.`
            }
            action={
              creatable.length ? (
                <div className="flex flex-wrap justify-end gap-1.5">
                  {creatable.map((kind) => (
                    <button
                      key={kind}
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setConfirming(null);
                        setEditing({ accountId: account.id, id: null, kind, name: "" });
                      }}
                      className={buttonClass}
                    >
                      <Icon icon={Add01Icon} size={14} />
                      New {nounOf(spec, kind)}
                    </button>
                  ))}
                </div>
              ) : null
            }
          >
            {adding ? (
              <NameRow
                editing={adding}
                spec={spec}
                busy={busy}
                error={error}
                onChange={(name) => setEditing({ ...adding, name })}
                onSave={() => save(account, spec)}
                onCancel={() => setEditing(null)}
              />
            ) : null}
            {own.length ? (
              own.map((label) => {
                const noun = nounOf(spec, label.kind);
                if (editing?.accountId === account.id && editing.id === label.id) {
                  return (
                    <NameRow
                      key={label.id}
                      editing={editing}
                      spec={spec}
                      busy={busy}
                      error={error}
                      onChange={(name) => setEditing({ ...editing, name })}
                      onSave={() => save(account, spec)}
                      onCancel={() => setEditing(null)}
                    />
                  );
                }
                const key = `${account.id}:${label.id}`;
                return (
                  <div key={label.id} data-setting={label.name} className="flex flex-col gap-2.5 px-4 py-2.5">
                    <div className="flex min-w-0 items-center gap-2.5" style={{ paddingLeft: labelDepth(label, spec) * 16 }}>
                      {label.color && label.kind === "tag" ? (
                        <span className="grid size-4 shrink-0 place-items-center">
                          <span className="size-2.5 rounded-full" style={{ background: label.color }} />
                        </span>
                      ) : (
                        <Icon icon={label.kind === "folder" ? Folder01Icon : Tag01Icon} size={15} className="shrink-0 text-pane-muted" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium" title={label.name}>
                          {leafName(label, spec)}
                        </span>
                        <span className="block text-[11.5px] text-pane-muted">
                          {label.total ? `${label.total} ${label.total === 1 ? "conversation" : "conversations"}` : "Nothing stored yet"}
                        </span>
                      </span>
                      {canManage(spec, "rename", label.kind) ? (
                        <Tooltip label={`Rename ${noun}`}>
                          <button
                            aria-label={`Rename ${label.name}`}
                            disabled={busy}
                            onClick={() => {
                              setError(null);
                              setConfirming(null);
                              setEditing({ accountId: account.id, id: label.id, kind: label.kind, name: label.name });
                            }}
                            className="grid size-8 shrink-0 place-items-center rounded-full text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg touch:size-11"
                          >
                            <Icon icon={PencilEdit01Icon} size={15} />
                          </button>
                        </Tooltip>
                      ) : null}
                      {canManage(spec, "remove", label.kind) ? (
                        <Tooltip label={`Delete ${noun}`}>
                          <button
                            aria-label={`Delete ${label.name}`}
                            disabled={busy}
                            onClick={() => {
                              setError(null);
                              setEditing(null);
                              setConfirming(key);
                            }}
                            className="grid size-8 shrink-0 place-items-center rounded-full text-pane-muted transition-colors hover:bg-pane-hover hover:text-warning touch:size-11"
                          >
                            <Icon icon={Delete02Icon} size={15} />
                          </button>
                        </Tooltip>
                      ) : null}
                    </div>
                    <AnimatePresence initial={false}>
                      {confirming === key ? (
                        <Confirm
                          key="confirm"
                          action="Delete"
                          danger
                          busy={busy}
                          onCancel={() => setConfirming(null)}
                          onConfirm={() => void run(() => send(`/api/labels?account=${encodeURIComponent(account.id)}&id=${encodeURIComponent(label.id)}`, "DELETE"), `Deleted “${label.name}”`)}
                        >
                          {error ?? deleteLine(label, spec, service)}
                        </Confirm>
                      ) : null}
                    </AnimatePresence>
                  </div>
                );
              })
            ) : adding ? null : (
              <p className="px-4 py-3.5 text-[12.5px] text-pane-muted">No {spec.organise.plural} in this account yet.</p>
            )}
          </Group>
        );
      })}
    </div>
  );
}

/** The name field for a new label or a rename, with Save and Cancel; the server's reason shows under it. */
function NameRow({
  editing,
  spec,
  busy,
  error,
  onChange,
  onSave,
  onCancel,
}: {
  editing: Editing;
  spec: ProviderSpec;
  busy: boolean;
  error: string | null;
  onChange: (name: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const noun = nounOf(spec, editing.kind);
  const separator = spec.organise[editing.kind]?.separator;
  return (
    <div className="blur-fade-down flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={editing.name}
          aria-label={editing.id ? `New name for the ${noun}` : `Name of the new ${noun}`}
          placeholder={separator ? `Name (“Work${separator}Clients” nests it)` : "Name"}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && editing.name.trim()) onSave();
            if (e.key === "Escape") {
              e.stopPropagation();
              onCancel();
            }
          }}
          className="h-9 min-w-0 flex-1 basis-48 rounded-full border border-pane-border bg-pane px-3.5 text-[13px] outline-none focus:border-accent/60 touch:h-11"
        />
        <button onClick={onCancel} disabled={busy} className={quietButtonClass}>
          Cancel
        </button>
        <button
          onClick={onSave}
          disabled={busy || !editing.name.trim()}
          className={cn("flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane disabled:opacity-50 touch:h-11")}
        >
          {busy ? <Spinner /> : null}
          {editing.id ? "Rename" : `Make ${noun}`}
        </button>
      </div>
      {error ? <p className="text-[12px] text-warning">{error}</p> : null}
    </div>
  );
}
