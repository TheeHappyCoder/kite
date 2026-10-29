"use client";

import { forwardRef, useEffect, useMemo, useState } from "react";
import { ArrowLeft01Icon, Cancel01Icon, CrownIcon, Mail01Icon, Note01Icon, PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { format } from "date-fns";
import { contactsFrom, letterOf, shownContacts, type ContactEntry, type ContactFilter, type ContactSort } from "@/lib/mail/contacts";
import { replyTime, summarizePerson, type PersonSummary } from "@/lib/mail/people";
import { personKey, type PersonPatch, type PersonPrefs } from "@/lib/mail/person-prefs";
import type { Account, Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { Avatar } from "../mail/avatar";
import { MailPanes, usePaneBack } from "../mail/mail-panes";
import { PersonNote, Stat } from "../mail/people-panel";
import { AccentTitle } from "../ui/accent-title";
import { CopyIcon, useCopy } from "../ui/copy";
import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";

// Contacts: everyone your mail knows, from the local copy only (lib/mail/contacts.ts). The list on
// the left (People, VIPs or everyone, most in touch or A–Z, searched by name or address); the
// person on the right: what you have together, your private note, and quick ways to write or find
// their mail. VIP flags and notes are the same ones the reader's People panel sets.

const FILTERS: { id: ContactFilter; label: string }[] = [
  { id: "people", label: "People" },
  { id: "vip", label: "VIPs" },
  { id: "everyone", label: "Everyone" },
];

/** Rows rendered at once; the rest arrive as the list scrolls near its end. */
const PAGE = 120;

export const ContactsView = forwardRef<
  HTMLInputElement,
  {
    live: boolean;
    accounts: Account[];
    demoThreads: Thread[];
    refreshKey: string;
    people: Record<string, PersonPrefs>;
    single: boolean;
    width: number | null;
    onUpdate: (patch: PersonPatch) => void;
    onWrite: (contact: { name: string; email: string }) => void;
    onSearch: (email: string) => void;
    onOpenConversation: (target: { threadId: string; accountId: string; subject: string }) => void;
    /** Opens on this person (a space's People tab). */
    initial?: string;
  }
>(function ContactsView({ live, accounts, demoThreads, refreshKey, people, single, width, onUpdate, onWrite, onSearch, onOpenConversation, initial }, searchRef) {
  const [fetched, setFetched] = useState<ContactEntry[] | null>(null);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    fetch("/api/contacts?all=1", { signal: controller.signal })
      .then((res) => (res.ok ? (res.json() as Promise<{ contacts: ContactEntry[] }>) : Promise.reject(new Error("Contacts couldn't be read"))))
      .then((data) => setFetched(data.contacts))
      .catch(() => {});
    return () => controller.abort();
  }, [live, refreshKey]);
  const own = useMemo(() => new Set(accounts.map((a) => a.email.toLowerCase())), [accounts]);
  const entries = useMemo(() => (live ? fetched : contactsFrom(demoThreads, own)), [live, fetched, demoThreads, own]);

  const [filter, setFilter] = useState<ContactFilter>("people");
  const [sort, setSort] = useState<ContactSort>("frequent");
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(initial?.toLowerCase() ?? null);
  const [shownCount, setShownCount] = useState(PAGE);
  const vip = (email: string) => !!people[personKey(email)]?.vip;
  const list = useMemo(
    () => (entries ? shownContacts(entries, { filter, sort, query, vip: (email) => !!people[personKey(email)]?.vip }) : null),
    [entries, filter, sort, query, people],
  );
  const selected = (picked && entries?.find((e) => e.email === picked)) || null;

  const listPane = (
    <section className="flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      <header className="flex flex-col gap-3 px-3.5 pt-3">
        <div className="flex items-baseline gap-2 pl-1">
          <h1 className="flex-1 truncate text-[20px] font-medium tracking-[-0.035em]">
            <AccentTitle text="Contacts" />
          </h1>
          {list ? <span className="text-[12px] tabular-nums text-pane-muted">{list.length}</span> : null}
        </div>
        <label className="flex h-10 items-center gap-2 rounded-full border border-pane-border bg-pane px-3.5 text-[13.5px] transition-colors focus-within:border-accent/60">
          <Icon icon={Search01Icon} size={16} className="text-pane-muted" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShownCount(PAGE);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setQuery("");
                e.currentTarget.blur();
              }
            }}
            placeholder="Find someone by name or address"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted"
          />
          {query ? (
            <button aria-label="Clear search" onClick={() => setQuery("")} className="text-pane-muted hover:text-pane-fg">
              <Icon icon={Cancel01Icon} size={14} />
            </button>
          ) : null}
        </label>
        <div className="flex items-center gap-2 pb-1">
          <FluidList axis="x" tone="pill" role="tablist" className="flex min-w-0 flex-1 gap-0.5 rounded-full bg-pane-2 p-[3px] shadow-[inset_0_0_0_1px_var(--pane-border)]">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                {...FLUID_ITEM}
                role="tab"
                aria-selected={filter === f.id}
                onClick={() => {
                  setFilter(f.id);
                  setShownCount(PAGE);
                }}
                className={cn(
                  "relative h-8 flex-1 rounded-full px-3 text-[13px] transition-[color,font-weight] duration-150",
                  filter === f.id ? "bg-pane-raised font-medium text-pane-fg shadow-[0_1px_2px_rgba(0,0,0,0.08),0_0_0_1px_var(--pane-border)]" : "text-pane-muted data-[lit]:text-pane-fg",
                )}
              >
                {f.label}
              </button>
            ))}
          </FluidList>
          <Select<ContactSort>
            label="Sort contacts"
            value={sort}
            onChange={setSort}
            options={[
              { value: "frequent", label: "Most in touch" },
              { value: "name", label: "A–Z" },
            ]}
          />
        </div>
      </header>

      <div
        className="scroll-fade min-h-0 flex-1 overflow-y-auto px-2 pb-2 pt-1"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (list && shownCount < list.length && el.scrollTop + el.clientHeight > el.scrollHeight - 600) setShownCount((n) => n + PAGE);
        }}
      >
        {!list ? (
          <div className="grid h-40 place-items-center text-pane-muted">
            <Spinner size={18} />
          </div>
        ) : !list.length ? (
          <p className="blur-fade px-3 py-10 text-center text-[13px] text-pane-muted">
            {query ? `Nobody matches “${query}”.` : filter === "vip" ? "No VIPs yet. Mark someone with the crown on their card." : "Nobody here yet. People appear as your mail arrives."}
          </p>
        ) : (
          <FluidList tone="pane" className="flex flex-col">
            {list.slice(0, shownCount).map((entry, i, shown) => {
              const letter = sort === "name" ? letterOf(entry) : null;
              const newLetter = letter && (i === 0 || letterOf(shown[i - 1]) !== letter);
              const prefs = people[personKey(entry.email)];
              return (
                <div key={entry.email}>
                  {newLetter ? <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.09em] text-pane-muted">{letter}</div> : null}
                  <button
                    {...FLUID_ITEM}
                    onClick={() => setPicked(entry.email)}
                    data-selected={entry.email === picked || undefined}
                    style={{ "--i": Math.min(i, 16) } as React.CSSProperties}
                    className={cn(
                      "relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-[background-color] duration-150 [content-visibility:auto] [contain-intrinsic-size:auto_56px]",
                      i < 16 && "blur-fade-up",
                      entry.email === picked && "bg-pane-selected",
                    )}
                  >
                    <Avatar name={entry.name || entry.email} email={entry.email} className="size-9 text-[11.5px]" />
                    <span className="min-w-0 flex-1" data-sensitive>
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[14px] font-medium">{entry.name || entry.email}</span>
                        {prefs?.vip ? <Icon icon={CrownIcon} size={12} className="shrink-0 fill-warning text-warning" /> : null}
                        {prefs?.note ? <Icon icon={Note01Icon} size={12} className="shrink-0 text-pane-muted" /> : null}
                      </span>
                      {entry.name ? <span className="block truncate text-[12.5px] text-pane-muted">{entry.email}</span> : null}
                    </span>
                    <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">{entry.last ? formatListDate(entry.last) : ""}</span>
                  </button>
                </div>
              );
            })}
          </FluidList>
        )}
      </div>
    </section>
  );

  return (
    <MailPanes
      single={single}
      width={width}
      showDetail={!!selected}
      onBack={() => setPicked(null)}
      list={listPane}
      detail={
        selected ? (
          <ContactCard
            key={selected.email}
            entry={selected}
            live={live}
            demoThreads={demoThreads}
            me={accounts.map((a) => a.email)}
            prefs={people[personKey(selected.email)]}
            vip={vip(selected.email)}
            onUpdate={onUpdate}
            onWrite={onWrite}
            onSearch={onSearch}
            onOpenConversation={onOpenConversation}
          />
        ) : (
          <section className="grid h-full place-items-center bg-pane p-8 text-center text-pane-fg">
            <div className="blur-fade max-w-64">
              <p className="text-[20px] font-medium tracking-[-0.03em]">
                Pick <span className="font-accent text-[1.12em]">someone</span>
              </p>
              <p className="mt-1.5 text-[13px] text-pane-muted">Everything you have together: conversations, files, how you usually reply, and your private note.</p>
            </div>
          </section>
        )
      }
    />
  );
});

function ContactCard({
  entry,
  live,
  demoThreads,
  me,
  prefs,
  vip,
  onUpdate,
  onWrite,
  onSearch,
  onOpenConversation,
}: {
  entry: ContactEntry;
  live: boolean;
  demoThreads: Thread[];
  me: string[];
  prefs: PersonPrefs | undefined;
  vip: boolean;
  onUpdate: (patch: PersonPatch) => void;
  onWrite: (contact: { name: string; email: string }) => void;
  onSearch: (email: string) => void;
  onOpenConversation: (target: { threadId: string; accountId: string; subject: string }) => void;
}) {
  const back = usePaneBack();
  const { copied, copy } = useCopy();
  const [fetched, setFetched] = useState<PersonSummary | null | undefined>(undefined);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    fetch(`/api/people?email=${encodeURIComponent(entry.email)}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { person?: PersonSummary }) => setFetched(data.person ?? null))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setFetched(null);
      });
    return () => controller.abort();
  }, [live, entry.email]);
  const demo = useMemo(() => (live ? undefined : summarizePerson(demoThreads, entry.email, me, { recent: 8, files: 8 })), [live, demoThreads, entry.email, me]);
  const person = live ? fetched : demo;
  const name = entry.name || person?.contact.name || entry.email;
  const first = name.split(/\s+/)[0];

  return (
    <section className="flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      {back ? (
        <div className="flex shrink-0 items-center gap-2 px-3 pt-3">
          <button
            onClick={back}
            className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[13px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
          >
            <Icon icon={ArrowLeft01Icon} size={15} /> Contacts
          </button>
        </div>
      ) : null}
      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto">
        <div className="blur-fade mx-auto flex max-w-[560px] flex-col gap-6 px-6 pb-10 pt-8" data-sensitive>
          <div className="flex flex-col items-center text-center">
            <Avatar name={name} email={entry.email} className="size-20 text-[22px]" />
            <h2 className="mt-3 flex max-w-full items-center gap-1.5 text-[24px] font-medium tracking-[-0.035em]">
              <span className="truncate">{name}</span>
              {vip ? <Icon icon={CrownIcon} size={16} className="shrink-0 fill-warning text-warning" /> : null}
            </h2>
            <button
              onClick={() => copy(entry.email)}
              className="mt-0.5 flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[13px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
            >
              <span className="truncate">{entry.email}</span>
              <CopyIcon copied={copied} size={12} />
            </button>
            {person?.firstDate ? <p className="mt-1 text-[12px] text-pane-muted">In your mail since {format(new Date(person.firstDate), "MMMM yyyy")}</p> : null}

            <div className="mt-4 flex flex-wrap justify-center gap-2">
              <button
                onClick={() => onWrite({ name: entry.name, email: entry.email })}
                className="flex h-9 items-center gap-2 rounded-full bg-accent px-4 text-[13px] font-medium text-accent-fg transition-[filter] duration-150 hover:brightness-110"
              >
                <Icon icon={PencilEdit02Icon} size={15} />
                Write to {first}
              </button>
              <Tooltip label={vip ? "Remove from VIPs" : "VIPs come first and can notify you right away"}>
                <button
                  aria-pressed={vip}
                  onClick={() => onUpdate({ email: entry.email, vip: !vip })}
                  className={cn(
                    "flex h-9 items-center gap-2 rounded-full border border-pane-border px-4 text-[13px] font-medium transition-colors duration-150 hover:bg-pane-hover",
                    vip && "border-warning/40 bg-warning/10 text-warning",
                  )}
                >
                  <Icon icon={CrownIcon} size={15} className={cn(vip && "fill-warning")} />
                  {vip ? "VIP" : "Make VIP"}
                </button>
              </Tooltip>
              <button
                onClick={() => onSearch(entry.email)}
                className="flex h-9 items-center gap-2 rounded-full border border-pane-border px-4 text-[13px] font-medium transition-colors duration-150 hover:bg-pane-hover"
              >
                <Icon icon={Mail01Icon} size={15} className="text-pane-muted" />
                All mail
              </button>
            </div>
          </div>

          <dl className="grid grid-cols-3 gap-2 text-center">
            <Stat label="Conversations" value={person?.conversations ?? 0} />
            <Stat label={`From ${first}`} value={entry.seen} />
            <Stat label="From you" value={entry.sent} />
          </dl>

          {person?.youReply || person?.theyReply ? (
            <div className="space-y-1 rounded-2xl bg-pane-2 px-4 py-3 text-[13px]">
              {person.youReply ? (
                <p>
                  You usually reply <span className="font-medium">{replyTime(person.youReply.minutes)}</span>
                </p>
              ) : null}
              {person.theyReply ? (
                <p>
                  {first} usually replies <span className="font-medium">{replyTime(person.theyReply.minutes)}</span>
                </p>
              ) : null}
            </div>
          ) : null}

          <PersonNote note={prefs?.note ?? ""} onSave={(note) => onUpdate({ email: entry.email, note: note || null })} />

          {person === undefined ? (
            <div className="grid h-20 place-items-center text-pane-muted">
              <Spinner size={16} />
            </div>
          ) : person === null ? (
            <p className="text-[13px] text-pane-muted">Kite couldn&apos;t read your history with {first}. Try again in a moment.</p>
          ) : (
            <>
              {person.recent.length ? (
                <section>
                  <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-pane-muted">Recent conversations</h3>
                  <FluidList tone="pane" className="-mx-2 flex flex-col">
                    {person.recent.map((t, i) => (
                      <button
                        key={t.id}
                        {...FLUID_ITEM}
                        onClick={() => onOpenConversation({ threadId: t.id, accountId: t.accountId, subject: t.subject })}
                        style={{ "--i": i } as React.CSSProperties}
                        className="blur-fade-up relative flex w-full items-baseline gap-3 rounded-xl px-2.5 py-2 text-left text-[13.5px]"
                      >
                        <span className="min-w-0 flex-1 truncate">{t.subject || "(no subject)"}</span>
                        {t.count > 1 ? <span className="shrink-0 text-[11.5px] text-pane-muted">{t.count}</span> : null}
                        <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">{formatListDate(t.date)}</span>
                      </button>
                    ))}
                  </FluidList>
                </section>
              ) : null}
              {person.files.length ? (
                <section>
                  <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-[0.09em] text-pane-muted">Files from {first}</h3>
                  <FluidList tone="pane" className="-mx-2 flex flex-col">
                    {person.files.map((f, i) => (
                      <button
                        key={`${f.threadId}:${f.attachment.partId ?? f.attachment.name}:${i}`}
                        {...FLUID_ITEM}
                        onClick={() => onOpenConversation({ threadId: f.threadId, accountId: f.accountId, subject: f.subject })}
                        className="relative flex w-full items-baseline gap-3 rounded-xl px-2.5 py-2 text-left text-[13.5px]"
                      >
                        <span className="min-w-0 flex-1 truncate">{f.attachment.name}</span>
                        <span className="shrink-0 text-[12px] tabular-nums text-pane-muted">{formatListDate(f.date)}</span>
                      </button>
                    ))}
                  </FluidList>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
