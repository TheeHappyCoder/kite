"use client";

import { forwardRef, useEffect, useMemo, useState } from "react";
import { Delete02Icon, Mail01Icon, Note01Icon, PencilEdit01Icon, Search01Icon, UserIcon } from "@hugeicons/core-free-icons";
import { formatDistanceToNow } from "date-fns";
import { bodyToHtml } from "@/lib/mail/body";
import { demoNotes, noteMatches, type ConversationNote, type NoteEntry, type NoteFilter, type PersonNote } from "@/lib/mail/notes";
import type { ThreadOverride } from "@/lib/mail/overrides";
import { NOTE_MAX, type PersonPrefs } from "@/lib/mail/person-prefs";
import { singleAccount, type AccountScope } from "@/lib/mail/scope";
import { accountName, type Account, type Thread } from "@/lib/mail/types";
import { useShortcuts } from "@/lib/shortcuts";
import { cn, formatListDate } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Segmented } from "../design/block-editor";
import { Avatar } from "../mail/avatar";
import { RichEditor } from "../mail/rich-editor";
import { useDebounced } from "../mail/app/util";
import { KeyCombo } from "../ui/kbd";
import { AccentTitle } from "../ui/accent-title";

type Props = {
  live: boolean;
  accounts: Account[];
  accountId: AccountScope;
  /** Changes when the list should be read again. */
  refreshKey: string | number;
  /** The app's own copies (loaded with /api/settings and changed in place), so edits anywhere show here at once. */
  overrides: Record<string, ThreadOverride>;
  people: Record<string, PersonPrefs>;
  /** Demo mode: the sample conversations the notes are on. */
  demoThreads: Thread[];
  onOpenConversation: (note: ConversationNote) => void;
  /** Shows mail from this person. */
  onPersonMail: (email: string) => void;
  /** Saves a conversation's note (markup; null deletes it). */
  onSaveConversation: (threadId: string, note: string | null) => void;
  /** Saves a note on a person (plain text; null deletes it). */
  onSavePerson: (email: string, note: string | null) => void;
};

const FILTERS: [NoteFilter, string][] = [
  ["all", "All"],
  ["conversation", "Conversations"],
  ["person", "People"],
];

/**
 * Notes (View kind "notes", sidebar, palette, `notes`): every private note, on conversations and on
 * people, newest first. Open the conversation or the person's mail, edit or delete in place.
 * Notes stay on this computer and are never sent.
 */
export const NotesView = forwardRef<HTMLInputElement, Props>(function NotesView(props, searchRef) {
  const { live, accountId, refreshKey } = props;
  const [query, setQuery] = useState("");
  const debounced = useDebounced(query, 120);
  const [filter, setFilter] = useState<NoteFilter>("all");
  const [result, setResult] = useState<{ key: string; notes: NoteEntry[] } | null>(null);
  const key = `${accountId}:${refreshKey}`;

  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    fetch(`/api/notes?account=${encodeURIComponent(accountId)}`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { notes?: NoteEntry[] }) => setResult({ key, notes: data.notes ?? [] }))
      .catch(() => {});
    return () => controller.abort();
  }, [live, accountId, key]);

  // The text comes from the app's copies, so an edit (here or in the reader) shows straight away and a
  // deleted note leaves the list.
  const all = useMemo(() => {
    const base = live ? (result?.notes ?? []) : demoNotes(props.demoThreads, props.overrides, props.people);
    return base.flatMap((entry): NoteEntry[] => {
      const note = entry.kind === "conversation" ? props.overrides[entry.id]?.note : props.people[entry.id]?.note;
      return note ? [{ ...entry, note }] : [];
    });
  }, [live, result, props.demoThreads, props.overrides, props.people]);
  const shown = all.filter((e) => (filter === "all" || e.kind === filter) && noteMatches(e, debounced));
  const counts = { conversation: all.filter((e) => e.kind === "conversation").length, person: all.filter((e) => e.kind === "person").length };
  const loading = live && !result;
  const multiple = !singleAccount(accountId, props.accounts);

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-2xl bg-pane pane-on-sky text-pane-fg">
      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div className="blur-fade-up mx-auto max-w-[820px] px-6 pb-12 pt-6 max-sm:px-4">
          <header className="mb-5 flex flex-wrap items-center gap-3">
            <span className="grid size-11 place-items-center rounded-2xl bg-warning/15 text-warning">
              <Icon icon={Note01Icon} size={22} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-medium tracking-[-0.035em]"><AccentTitle text="Notes" /></h1>
              <p className="text-[13px] text-pane-muted">
                {loading
                  ? "Gathering your notes…"
                  : `${all.length.toLocaleString()} private ${all.length === 1 ? "note" : "notes"} · only on this computer, never sent`}
              </p>
            </div>
          </header>

          <div className="mb-5 flex flex-wrap items-center gap-3">
            <label className="flex h-10 min-w-[220px] flex-1 items-center gap-2 rounded-full border border-pane-border bg-pane px-3.5 text-[13.5px] transition-colors focus-within:border-accent/60 touch:h-11">
              <Icon icon={Search01Icon} size={16} className="text-pane-muted" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setQuery("");
                    e.currentTarget.blur();
                  }
                }}
                placeholder="Search notes, subjects and people"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
              />
            </label>
            <Segmented
              value={filter}
              options={FILTERS.map(([id, label]): [NoteFilter, string] => [id, id === "all" ? label : `${label} ${counts[id]}`])}
              onChange={setFilter}
            />
          </div>

          {loading ? (
            <div className="flex flex-col gap-3">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="h-28 animate-pulse rounded-2xl bg-pane-2" />
              ))}
            </div>
          ) : shown.length ? (
            <div key={`${filter}:${debounced}`} className="flex flex-col gap-3">
              {shown.map((entry, i) =>
                entry.kind === "conversation" ? (
                  <ConversationCard
                    key={`c:${entry.id}`}
                    index={i}
                    entry={entry}
                    account={multiple ? props.accounts.find((a) => a.id === entry.accountId) : undefined}
                    onOpen={() => props.onOpenConversation(entry)}
                    onSave={(note) => props.onSaveConversation(entry.id, note)}
                  />
                ) : (
                  <PersonCard
                    key={`p:${entry.id}`}
                    index={i}
                    entry={entry}
                    onMail={() => props.onPersonMail(entry.id)}
                    onSave={(note) => props.onSavePerson(entry.id, note)}
                  />
                ),
              )}
            </div>
          ) : (
            <Empty searching={!!debounced || filter !== "all"} />
          )}
        </div>
      </div>
    </section>
  );
});

/** When the note was written, else nothing (older notes don't know). */
function Written({ at }: { at: string | null }) {
  if (!at) return null;
  return <span className="shrink-0 text-[11.5px] text-pane-muted">{formatDistanceToNow(new Date(at), { addSuffix: true })}</span>;
}

function ConversationCard({
  index,
  entry,
  account,
  onOpen,
  onSave,
}: {
  index: number;
  entry: ConversationNote;
  account?: Account;
  onOpen: () => void;
  onSave: (note: string | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const thread = entry.thread;
  const last = thread?.messages[thread.messages.length - 1];
  const sender = thread?.messages.find((m) => m.from.name !== "You")?.from ?? last?.from;
  const html = useMemo(() => bodyToHtml(entry.note, "var(--accent)"), [entry.note]);

  return (
    <article className="blur-fade-up rounded-2xl border border-pane-border p-4" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
      <div className="flex min-w-0 items-start gap-3">
        <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-full bg-warning/15 text-warning">
          <Icon icon={Note01Icon} size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <button onClick={onOpen} data-sensitive className="min-w-0 truncate text-left text-[14px] font-semibold hover:underline">
              {entry.subject || "(no subject)"}
            </button>
            <span className="ml-auto" />
            <Written at={entry.noteAt} />
          </div>
          <p data-sensitive className="flex min-w-0 items-center gap-1.5 truncate text-[12px] text-pane-muted">
            {account ? (
              <>
                <span className="size-1.5 shrink-0 rounded-full" style={{ background: account.color }} />
                <span className="truncate">{accountName(account)}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            {thread && sender && last ? (
              <span className="truncate">
                {sender.name} · {thread.messages.length} {thread.messages.length === 1 ? "message" : "messages"} · {formatListDate(last.date)}
              </span>
            ) : (
              <span>This conversation isn&apos;t on this computer right now</span>
            )}
          </p>
        </div>
      </div>

      {editing !== null ? (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-3 pb-2 pt-1">
          <RichEditor
            initial={entry.note}
            autoFocus
            ariaLabel="Private note"
            placeholder="Write a note to yourself about this conversation…"
            className="min-h-12 py-1.5 text-[13.5px] leading-6"
            onChange={setEditing}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(null);
              }
            }}
          />
          <EditButtons
            onCancel={() => setEditing(null)}
            onSave={() => {
              onSave(editing.trim() ? editing : null);
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <div
          data-sensitive
          className="mt-3 rounded-xl bg-warning/10 px-3.5 py-2.5 text-[13.5px] leading-6 [&>*:last-child]:mb-0!"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}

      <Actions
        confirming={confirming}
        onConfirm={setConfirming}
        onDelete={() => onSave(null)}
        editing={editing !== null}
        items={[
          { icon: Mail01Icon, label: "Open conversation", onClick: onOpen },
          { icon: PencilEdit01Icon, label: "Edit", onClick: () => setEditing(entry.note) },
        ]}
      />
    </article>
  );
}

function PersonCard({
  index,
  entry,
  onMail,
  onSave,
}: {
  index: number;
  entry: PersonNote;
  onMail: () => void;
  onSave: (note: string | null) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  return (
    <article className="blur-fade-up rounded-2xl border border-pane-border p-4" style={{ "--i": Math.min(index, 12) } as React.CSSProperties}>
      <div className="flex min-w-0 items-start gap-3">
        <span data-sensitive className="shrink-0">
          <Avatar name={entry.name ?? entry.id} email={entry.id} className="size-8 text-[11px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span data-sensitive className="min-w-0 truncate text-[14px] font-semibold">
              {entry.name ?? entry.id}
            </span>
            <span className="shrink-0 rounded-full bg-pane-hover px-1.5 text-[10.5px] font-medium text-pane-muted">
              <Icon icon={UserIcon} size={10} className="-mt-px mr-0.5 inline" />
              Person
            </span>
            <span className="ml-auto" />
            <Written at={entry.noteAt} />
          </div>
          {entry.name ? (
            <p data-sensitive className="truncate text-[12px] text-pane-muted">
              {entry.id}
            </p>
          ) : null}
        </div>
      </div>

      {editing !== null ? (
        <div className="mt-3 rounded-xl border border-warning/30 bg-warning/10 px-3 pb-2 pt-2">
          <textarea
            autoFocus
            value={editing}
            maxLength={NOTE_MAX}
            rows={3}
            aria-label="Private note"
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(null);
              }
            }}
            className="w-full resize-none bg-transparent text-[13.5px] leading-6 outline-none [field-sizing:content]"
          />
          <EditButtons
            onCancel={() => setEditing(null)}
            onSave={() => {
              onSave(editing.trim() ? editing.trim() : null);
              setEditing(null);
            }}
          />
        </div>
      ) : (
        <p data-sensitive className="mt-3 whitespace-pre-line rounded-xl bg-warning/10 px-3.5 py-2.5 text-[13.5px] leading-6">
          {entry.note}
        </p>
      )}

      <Actions
        confirming={confirming}
        onConfirm={setConfirming}
        onDelete={() => onSave(null)}
        editing={editing !== null}
        items={[
          { icon: Mail01Icon, label: "Their emails", onClick: onMail },
          { icon: PencilEdit01Icon, label: "Edit", onClick: () => setEditing(entry.note) },
        ]}
      />
    </article>
  );
}

const pill =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium text-pane-muted transition-colors duration-150 hover:bg-pane-hover hover:text-pane-fg touch:h-11";

/** The card's actions; Delete asks once, inline. Hidden while editing (the editor has its own). */
function Actions({
  items,
  editing,
  confirming,
  onConfirm,
  onDelete,
}: {
  items: { icon: IconData; label: string; onClick: () => void }[];
  editing: boolean;
  confirming: boolean;
  onConfirm: (on: boolean) => void;
  onDelete: () => void;
}) {
  if (editing) return null;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1">
      {confirming ? (
        <>
          <span className="mr-auto pl-1 text-[12.5px] text-pane-muted">Delete this note? It can&apos;t be brought back.</span>
          <button onClick={() => onConfirm(false)} className={pill}>
            Keep
          </button>
          <button onClick={onDelete} className={cn(pill, "text-danger hover:bg-danger/10 hover:text-danger")}>
            <Icon icon={Delete02Icon} size={14} />
            Delete
          </button>
        </>
      ) : (
        <>
          {items.map((item) => (
            <button key={item.label} onClick={item.onClick} className={pill}>
              <Icon icon={item.icon} size={14} />
              {item.label}
            </button>
          ))}
          <button onClick={() => onConfirm(true)} className={cn(pill, "ml-auto")}>
            <Icon icon={Delete02Icon} size={14} />
            Delete
          </button>
        </>
      )}
    </div>
  );
}

function EditButtons({ onCancel, onSave }: { onCancel: () => void; onSave: () => void }) {
  return (
    <div className="mt-1 flex justify-end gap-1">
      <button onClick={onCancel} className={pill}>
        Cancel
      </button>
      <button onClick={onSave} className="inline-flex h-8 items-center rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane transition-opacity hover:opacity-90 touch:h-11">
        Save
      </button>
    </div>
  );
}

function Empty({ searching }: { searching: boolean }) {
  const shortcuts = useShortcuts();
  const note = shortcuts.primary("note");
  const people = shortcuts.primary("people");
  return (
    <div className="grid place-items-center px-6 py-16 text-center">
      <div>
        <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-warning/15 text-warning">
          <Icon icon={Note01Icon} size={20} />
        </div>
        <p className="text-[13px] font-medium">{searching ? "No notes match" : "No notes yet"}</p>
        <p className="mx-auto mt-1 max-w-sm text-[12px] leading-5 text-pane-muted">
          {searching ? (
            "Try other words, or show all notes."
          ) : (
            <>
              Open a conversation and add a private note from More{note ? <> (<KeyCombo combo={note} />)</> : null}, or note something about a
              person in People{people ? <> (<KeyCombo combo={people} />)</> : null}. They all gather here.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
