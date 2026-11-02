"use client";

import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import type { Design } from "@/lib/design/spec";
import { accountName, type Account } from "@/lib/mail/types";
import type { AccountSignatures, Preferences, Signature } from "@/lib/settings";
import { Icon } from "../icon";
import { DesignPreview } from "../design/design-preview";
import { SignatureEditor } from "../design/design-editor";
import { AccountFace } from "../mail/account-face";
import { Select } from "../ui/select";
import { Tooltip } from "../ui/tooltip";
import { Confirm, buttonClass } from "./settings-ui";

// Settings → Signatures: each account's signatures (as many as you like, each with a name),
// and which one new messages and replies start with. Compose can switch to any of them.

/** `n` makes each opening a fresh editor. */
type Editing = { account: Account; id: string | null; n: number };

const NONE = "none";

export function SignaturesSection({
  accounts,
  signatures,
  onSave,
}: {
  accounts: Account[];
  signatures: Preferences["signatures"];
  /** Replaces an account's whole set (null removes them all). */
  onSave: (accountId: string, set: AccountSignatures | null) => Promise<void>;
}) {
  // Kept after closing so the editor can animate out.
  const [editing, setEditing] = useState<Editing | null>(null);
  const [open, setOpen] = useState(false);

  const setOf = (accountId: string): AccountSignatures => signatures[accountId] ?? { list: [], newMail: null, replies: null };
  const edited = editing ? setOf(editing.account.id).list.find((s) => s.id === editing.id) : undefined;

  const save = (account: Account, id: string | null, design: Design) => {
    const set = setOf(account.id);
    if (id && set.list.some((s) => s.id === id)) {
      return onSave(account.id, { ...set, list: set.list.map((s) => (s.id === id ? { ...s, design } : s)) });
    }
    const made: Signature = { id: crypto.randomUUID().replace(/-/g, "").slice(0, 12), name: nextName(set.list), design };
    // The first one is what new messages and replies start with.
    return onSave(account.id, {
      list: [...set.list, made],
      newMail: set.newMail ?? (set.list.length ? null : made.id),
      replies: set.replies ?? (set.list.length ? null : made.id),
    });
  };

  const remove = (accountId: string, id: string) => {
    const set = setOf(accountId);
    const list = set.list.filter((s) => s.id !== id);
    if (!list.length) return onSave(accountId, null);
    return onSave(accountId, { list, newMail: set.newMail === id ? null : set.newMail, replies: set.replies === id ? null : set.replies });
  };

  return (
    <div className="flex flex-col gap-3">
      {accounts.map((account) => (
        <AccountSignaturesCard
          key={account.id}
          account={account}
          set={setOf(account.id)}
          onEdit={(id) => {
            setEditing((last) => ({ account, id, n: (last?.n ?? 0) + 1 }));
            setOpen(true);
          }}
          onChange={(set) => onSave(account.id, set)}
          onRemove={(id) => remove(account.id, id)}
        />
      ))}

      {editing ? (
        <SignatureEditor
          key={editing.n}
          open={open}
          account={editing.account}
          name={setOf(editing.account.id).list.length > 1 ? edited?.name : undefined}
          initial={edited?.design ?? null}
          onSave={(design) => save(editing.account, editing.id, design)}
          onRemove={() => (editing.id ? remove(editing.account.id, editing.id) : Promise.resolve())}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}

function nextName(list: Signature[]) {
  if (!list.length) return "Signature";
  const taken = new Set(list.map((s) => s.name.toLowerCase()));
  for (let n = list.length + 1; ; n++) if (!taken.has(`signature ${n}`)) return `Signature ${n}`;
}

function AccountSignaturesCard({
  account,
  set,
  onEdit,
  onChange,
  onRemove,
}: {
  account: Account;
  set: AccountSignatures;
  onEdit: (id: string | null) => void;
  onChange: (set: AccountSignatures) => Promise<void>;
  onRemove: (id: string) => Promise<void>;
}) {
  const options = [{ value: NONE, label: "No signature" }, ...set.list.map((s) => ({ value: s.id, label: s.name }))];
  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-xl border border-pane-border">
      <div className="flex min-w-0 items-center gap-2.5 px-3.5 py-3">
        <AccountFace account={account} className="size-6 text-[10px]" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-medium">{accountName(account)}</p>
          <p className="truncate text-[11.5px] text-pane-muted">{account.email}</p>
        </div>
        <button onClick={() => onEdit(null)} className={buttonClass}>
          <Icon icon={Add01Icon} size={14} />
          New signature
        </button>
      </div>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-2.5 border-t border-pane-border bg-pane-2/60 p-2.5">
        {set.list.length ? (
          set.list.map((signature) => (
            <SignatureTile
              key={signature.id}
              signature={signature}
              uses={[set.newMail === signature.id && "New messages", set.replies === signature.id && "Replies"].filter((u): u is string => !!u)}
              onEdit={() => onEdit(signature.id)}
              onRename={(name) => onChange({ ...set, list: set.list.map((s) => (s.id === signature.id ? { ...s, name } : s)) })}
              onRemove={() => onRemove(signature.id)}
            />
          ))
        ) : (
          <button
            onClick={() => onEdit(null)}
            className="grid min-h-20 place-items-center rounded-lg border border-dashed border-pane-border text-[12px] text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
          >
            No signature yet
          </button>
        )}
      </div>

      {set.list.length ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-pane-border px-3.5 py-2.5 text-[12.5px]">
          <label className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-pane-muted">New messages</span>
            <Select label="Signature for new messages" value={set.newMail ?? NONE} options={options} onChange={(v) => void onChange({ ...set, newMail: v === NONE ? null : v })} />
          </label>
          <label className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-pane-muted">Replies and forwards</span>
            <Select label="Signature for replies and forwards" value={set.replies ?? NONE} options={options} onChange={(v) => void onChange({ ...set, replies: v === NONE ? null : v })} />
          </label>
        </div>
      ) : null}
    </div>
  );
}

function SignatureTile({
  signature,
  uses,
  onEdit,
  onRename,
  onRemove,
}: {
  signature: Signature;
  uses: string[];
  onEdit: () => void;
  onRename: (name: string) => Promise<void>;
  onRemove: () => Promise<void>;
}) {
  const [name, setName] = useState(signature.name);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const commit = () => {
    const next = name.trim().slice(0, 60);
    if (!next) setName(signature.name);
    else if (next !== signature.name) void onRename(next);
  };
  return (
    <div className="group flex min-w-0 flex-col gap-1.5 rounded-lg border border-pane-border bg-pane p-1.5">
      <div className="flex min-w-0 items-center gap-1">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") {
              setName(signature.name);
              e.currentTarget.blur();
            }
          }}
          aria-label="Signature name"
          className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1.5 text-[12.5px] font-medium outline-none hover:bg-pane-hover focus:bg-pane-2"
        />
        {uses.length ? <span className="shrink-0 truncate rounded-full bg-pane-2 px-2 py-0.5 text-[10.5px] text-pane-muted">{uses.join(" · ")}</span> : null}
        <Tooltip label="Delete signature" side="top">
          <button
            onClick={() => setConfirm(true)}
            aria-label="Delete signature"
            className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted transition-colors hover:bg-pane-hover hover:text-pane-fg"
          >
            <Icon icon={Delete02Icon} size={14} />
          </button>
        </Tooltip>
      </div>
      <AnimatePresence initial={false}>
        {confirm ? (
          <Confirm
            action="Delete"
            danger
            busy={busy}
            onCancel={() => setConfirm(false)}
            onConfirm={async () => {
              setBusy(true);
              try {
                await onRemove();
              } finally {
                setBusy(false);
              }
            }}
          >
            Delete “{signature.name}”?
          </Confirm>
        ) : null}
      </AnimatePresence>
      <button onClick={onEdit} aria-label={`Edit ${signature.name}`} className="block min-h-20 rounded-md text-left transition-opacity hover:opacity-90">
        <DesignPreview design={signature.design} className="pointer-events-none" />
      </button>
    </div>
  );
}
