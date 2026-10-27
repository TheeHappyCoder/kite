"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Cancel01Icon, CrownIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { format } from "date-fns";
import { participants, replyTime, summarizePerson, type PersonSummary } from "@/lib/mail/people";
import { NOTE_MAX, type PersonPatch, type PersonPrefs } from "@/lib/mail/person-prefs";
import type { Thread } from "@/lib/mail/types";
import { cn, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";
import { Avatar } from "./avatar";
import { FileThumb, type FileRef } from "../files/file-preview";

import { FLUID_ITEM, FluidList } from "../ui/fluid-hover";
/**
 * The People panel beside a conversation: who this is to you, from the local copy only.
 * Conversations together, files they sent, and how quickly each of you usually replies.
 */
export function PeoplePanel({
  thread,
  me,
  live,
  demoThreads,
  email,
  onPick,
  onOpenThread,
  onSearch,
  onPreview,
  onClose,
  people: local,
  onUpdate,
}: {
  thread: Thread;
  /** Your own addresses. */
  me: string[];
  live: boolean;
  demoThreads: Thread[];
  /** The person shown; null picks the conversation's main correspondent. */
  email: string | null;
  onPick: (email: string) => void;
  onOpenThread: (id: string, email: string) => void;
  onSearch: (query: string) => void;
  onPreview: (file: FileRef) => void;
  onClose: () => void;
  /** VIP flags and private notes, keyed by lower-cased address. */
  people: Record<string, PersonPrefs>;
  onUpdate: (patch: PersonPatch) => void;
}) {
  const people = useMemo(() => participants(thread, me), [thread, me]);
  const current = (email && people.find((p) => p.email.toLowerCase() === email.toLowerCase())) || people[0];
  const address = current?.email ?? "";
  const [fetched, setFetched] = useState<{ email: string; person: PersonSummary | null } | null>(null);

  useEffect(() => {
    if (!live || !address) return;
    const controller = new AbortController();
    fetch(`/api/people?email=${encodeURIComponent(address)}&account=${thread.accountId}`, { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { person?: PersonSummary }) => setFetched({ email: address, person: data.person ?? null }))
      .catch((error: Error) => {
        if (error.name !== "AbortError") setFetched({ email: address, person: null });
      });
    return () => controller.abort();
  }, [live, address, thread.accountId]);

  const demo = useMemo(() => (!live && address ? summarizePerson(demoThreads, address, me) : null), [live, address, demoThreads, me]);
  const person = live ? (fetched?.email === address ? fetched.person : undefined) : demo;
  const prefs = local[address.toLowerCase()];

  return (
    <aside
      aria-label="People"
      className="blur-fade-left flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l border-pane-border bg-pane @max-[40rem]:absolute @max-[40rem]:inset-y-0 @max-[40rem]:right-0 @max-[40rem]:z-20 @max-[40rem]:shadow-2xl"
    >
      <div className="flex items-center gap-2 px-4 pb-2 pt-3">
        <span className="flex-1 text-[11px] font-medium uppercase tracking-wider text-pane-muted">People</span>
        <Tooltip label="Close" shortcut="people">
          <button aria-label="Close people" onClick={onClose} className="grid size-7 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
            <Icon icon={Cancel01Icon} size={14} />
          </button>
        </Tooltip>
      </div>

      {people.length > 1 ? (
        <div className="flex flex-wrap gap-1 px-4 pb-2">
          {people.slice(0, 8).map((p) => (
            <Tooltip key={p.email} label={p.email}>
              <button
                aria-label={p.name || p.email}
                aria-pressed={p.email === address}
                onClick={() => onPick(p.email)}
                className={cn("rounded-full ring-2 transition-shadow", p.email === address ? "ring-accent" : "ring-transparent hover:ring-pane-border")}
              >
                <Avatar name={p.name || p.email} email={p.email} className="size-7" />
              </button>
            </Tooltip>
          ))}
        </div>
      ) : null}

      {!current ? (
        <p className="px-4 py-6 text-[12.5px] text-pane-muted">Just you in this conversation.</p>
      ) : (
        <div key={address} className="blur-fade flex flex-col gap-5 px-4 pb-6 pt-2">
          <div className="flex flex-col items-center text-center">
            <Avatar name={person?.contact.name ?? current.name ?? address} email={address} className="size-14 text-[16px]" />
            <div className="mt-2 flex max-w-full items-center gap-1">
              <span className="min-w-0 truncate text-[14px] font-semibold">{person?.contact.name ?? current.name}</span>
              <Tooltip label={prefs?.vip ? "Remove from VIPs" : "Mark VIP"} shortcut="vip" className="shrink-0">
                <button
                  aria-label={prefs?.vip ? "Remove from VIPs" : "Mark VIP"}
                  aria-pressed={!!prefs?.vip}
                  onClick={() => onUpdate({ email: address, vip: !prefs?.vip })}
                  className={cn(
                    "grid size-7 place-items-center rounded-full border border-pane-border hover:bg-pane-hover",
                    prefs?.vip ? "text-warning" : "text-pane-muted hover:text-pane-fg",
                  )}
                >
                  <Icon icon={CrownIcon} size={14} className={cn(prefs?.vip && "fill-warning")} />
                </button>
              </Tooltip>
            </div>
            <div className="max-w-full truncate text-[12px] text-pane-muted">{address}</div>
            {person?.firstDate ? (
              <div className="mt-1 text-[11.5px] text-pane-muted">In your mail since {format(new Date(person.firstDate), "MMM yyyy")}</div>
            ) : null}
          </div>

          <PersonNote note={prefs?.note ?? ""} onSave={(note) => onUpdate({ email: address, note: note || null })} />

          {person === undefined ? (
            <div className="space-y-2">
              {[80, 60, 70].map((w, i) => (
                <div key={i} className="h-3 animate-pulse rounded bg-pane-hover" style={{ width: `${w}%` }} />
              ))}
            </div>
          ) : person === null ? (
            <p className="text-[12.5px] text-pane-muted">Kite couldn&apos;t look this person up. Try again in a moment.</p>
          ) : (
            <>
              <dl className="grid grid-cols-3 gap-2 text-center">
                <Stat label="Conversations" value={person.conversations} />
                <Stat label="From them" value={person.received} />
                <Stat label="From you" value={person.sent} />
              </dl>

              {person.youReply || person.theyReply ? (
                <div className="space-y-1 rounded-xl bg-pane-2 px-3 py-2.5 text-[12.5px]">
                  {person.youReply ? (
                    <p>
                      You usually reply <span className="font-medium">{replyTime(person.youReply.minutes)}</span>
                    </p>
                  ) : null}
                  {person.theyReply ? (
                    <p>
                      They usually reply <span className="font-medium">{replyTime(person.theyReply.minutes)}</span>
                    </p>
                  ) : null}
                  <p className="text-[11px] text-pane-muted">From {(person.youReply?.samples ?? 0) + (person.theyReply?.samples ?? 0)} replies on this device</p>
                </div>
              ) : null}

              {person.recent.length ? (
                <section>
                  <h3 className="pb-1.5 text-[11px] font-medium uppercase tracking-wider text-pane-muted">Recent conversations</h3>
                  <FluidList tone="pane" role="list" className="-mx-2">
                    {person.recent.map((t, i) => (
                      <li key={t.id} className="blur-fade-up" style={{ "--i": i } as React.CSSProperties}>
                        <button
                          {...FLUID_ITEM}
                          onClick={() => onOpenThread(t.id, address)}
                          className={cn(
                            "relative flex w-full items-baseline gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]",
                            t.id === thread.id && "bg-pane-hover",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate">{t.subject}</span>
                          <span className="shrink-0 text-[11.5px] tabular-nums text-pane-muted">{formatListDate(t.date)}</span>
                        </button>
                      </li>
                    ))}
                  </FluidList>
                </section>
              ) : null}

              {person.files.length ? (
                <section>
                  <h3 className="pb-1.5 text-[11px] font-medium uppercase tracking-wider text-pane-muted">Files they sent</h3>
                  <FluidList tone="pane" role="list" className="-mx-2">
                    {person.files.map((f, i) => (
                      <li key={`${f.threadId}:${f.attachment.partId ?? f.attachment.name}:${i}`}>
                        <button
                          {...FLUID_ITEM}
                          onClick={() => onPreview({ accountId: f.accountId, messageId: f.messageId, attachment: f.attachment, subject: f.subject, threadId: f.threadId, from: f.from })}
                          className="relative flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px]"
                        >
                          <FileThumb file={{ accountId: f.accountId, messageId: f.messageId, attachment: f.attachment }} size={18} />
                          <span className="min-w-0 flex-1 truncate">{f.attachment.name}</span>
                          <span className="shrink-0 text-[11.5px] tabular-nums text-pane-muted">{formatListDate(f.date)}</span>
                        </button>
                      </li>
                    ))}
                  </FluidList>
                </section>
              ) : null}

              <button
                onClick={() => onSearch(address)}
                className="flex h-8 items-center justify-center gap-2 rounded-full border border-pane-border text-[12.5px] font-medium hover:bg-pane-hover"
              >
                <Icon icon={Search01Icon} size={14} className="text-pane-muted" />
                All mail with {(person.contact.name || address).split(" ")[0]}
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

export function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col-reverse rounded-xl bg-pane-2 px-1 py-2">
      <dt className="text-[10.5px] text-pane-muted">{label}</dt>
      <dd className="text-[16px] font-semibold tabular-nums">{value}</dd>
    </div>
  );
}

/** A short private note about this person, saved on this device as you type. */
export function PersonNote({ note, onSave }: { note: string; onSave: (note: string) => void }) {
  const [draft, setDraft] = useState(note);
  const saved = useRef(note);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const save = (value: string) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (value.trim() === saved.current.trim()) return;
    saved.current = value;
    onSave(value.trim());
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wider text-pane-muted">Private note</span>
      <textarea
        value={draft}
        maxLength={NOTE_MAX}
        rows={2}
        placeholder="Only you see this, on this device"
        onChange={(e) => {
          const value = e.target.value;
          setDraft(value);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => save(value), 600);
        }}
        onBlur={() => save(draft)}
        className="block w-full resize-y rounded-xl border border-pane-border bg-pane-2 px-3 py-2 text-[12.5px] leading-5 outline-none placeholder:text-pane-muted focus:border-accent/60"
      />
    </label>
  );
}
