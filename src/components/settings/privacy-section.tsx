"use client";

import { useEffect, useState } from "react";
import { format, isSameDay, subDays } from "date-fns";
import { AiMagicIcon, Cancel01Icon, Globe02Icon, Image01Icon, MailRemove01Icon, TranslateIcon, Settings01Icon } from "@hugeicons/core-free-icons";
import type { PersonPrefs } from "@/lib/mail/person-prefs";
import { PIN_LENGTH } from "@/lib/lock";
import { IMAGE_CHOICES, LOCK_CHOICES, type Preferences } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { Icon, type IconData } from "../icon";
import { Avatar } from "../mail/avatar";
import { Tooltip } from "../ui/tooltip";
import { Group, Note, Row, Segmented, buttonClass, quietButtonClass } from "./settings-ui";

type ImageChoice = Preferences["privacy"]["images"];

const IMAGE_LABELS: Record<ImageChoice, string> = { ask: "Ask", always: "Always", never: "Never" };
const IMAGE_DETAIL: Record<ImageChoice, string> = {
  ask: "Images wait until you load them. Loading tells the sender you opened the email.",
  always: "Images load straight away. Pixels are still removed, but senders see your network.",
  never: "Images never load. Some emails will look incomplete.",
};

/** Remote images: Ask / Always / Never. */
export function ImagesRow({ value, onChange }: { value: ImageChoice; onChange: (value: ImageChoice) => void }) {
  return (
    <Row
      label="Remote images"
      detail={IMAGE_DETAIL[value]}
      control={<Segmented label="Remote images" value={value} options={IMAGE_CHOICES.map((c) => ({ id: c, label: IMAGE_LABELS[c] }))} onChange={onChange} />}
    />
  );
}

type LogEntry = { at: string; kind: "ai" | "picture" | "dns" | "unsubscribe" | "setup" | "translation"; service: string; action: string; detail: string | null };
type LogCount = { kind: LogEntry["kind"]; service: string; count: number };

const KIND: Record<LogEntry["kind"], { label: string; icon: IconData; tone: string }> = {
  ai: { label: "AI", icon: AiMagicIcon, tone: "bg-accent-soft text-accent" },
  picture: { label: "Pictures", icon: Image01Icon, tone: "bg-pane-hover text-pane-muted" },
  dns: { label: "DNS", icon: Globe02Icon, tone: "bg-pane-hover text-pane-muted" },
  unsubscribe: { label: "Unsubscribe", icon: MailRemove01Icon, tone: "bg-warning/10 text-warning" },
  setup: { label: "Account setup", icon: Settings01Icon, tone: "bg-pane-hover text-pane-muted" },
  translation: { label: "Translation", icon: TranslateIcon, tone: "bg-pane-hover text-pane-muted" },
};

const SHOWN = 12;

/** "Today", "Yesterday", or "Mon 12 Oct". */
function dayLabel(day: Date, now: Date) {
  if (isSameDay(day, now)) return "Today";
  if (isSameDay(day, subDays(now, 1))) return "Yesterday";
  return format(day, "EEE d MMM");
}

/**
 * What Kite sent anywhere other than the mail provider in the last 7 days, read from the local
 * privacy log: routine lookups as totals, and each request that carried mail (AI, unsubscribes) on
 * a timeline by day.
 */
export function PrivacyLog({ onToast }: { onToast: (message: string) => void }) {
  const [log, setLog] = useState<{ entries: LogEntry[]; counts: LogCount[]; now: number } | null>(null);
  const [key, setKey] = useState(0);
  const [all, setAll] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/privacy", { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { entries: LogEntry[]; counts: LogCount[] }) => setLog({ ...data, now: Date.now() }))
      .catch(() => {});
    return () => controller.abort();
  }, [key]);

  const clear = async () => {
    const res = await fetch("/api/privacy", { method: "DELETE" }).catch(() => null);
    if (res?.ok) setKey((k) => k + 1);
    else onToast("Kite couldn't clear the log. Try again.");
  };

  const empty = log && !log.entries.length && !log.counts.length;
  const entries = log ? [...log.entries].sort((a, b) => b.at.localeCompare(a.at)) : [];
  const shown = all ? entries : entries.slice(0, SHOWN);
  const days: { label: string; items: LogEntry[] }[] = [];
  for (const entry of shown) {
    const label = dayLabel(new Date(entry.at), new Date(log?.now ?? 0));
    if (days.at(-1)?.label === label) days.at(-1)!.items.push(entry);
    else days.push({ label, items: [entry] });
  }

  return (
    <Group
      title="What left this computer"
      description="The last 7 days, besides your mail provider. Kept only here."
      action={
        log && !empty ? (
          <button onClick={() => void clear()} className={quietButtonClass}>
            Clear log
          </button>
        ) : null
      }
      bare
    >
      {!log ? (
        <div className="h-24 animate-pulse rounded-xl bg-pane-2" />
      ) : empty ? (
        <Note>Nothing. Only your mail provider has heard from Kite.</Note>
      ) : (
        <div className="flex flex-col gap-4">
          {log.counts.length ? (
            <div className="flex flex-col gap-2">
              <p className="px-1 text-[11.5px] font-medium text-pane-muted">Routine lookups</p>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,12rem),1fr))] gap-2">
                {log.counts.map((c) => (
                  <div key={`${c.kind}:${c.service}`} className="flex min-w-0 items-center gap-2.5 rounded-xl border border-pane-border px-3 py-2.5">
                    <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", KIND[c.kind].tone)}>
                      <Icon icon={KIND[c.kind].icon} size={14} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12.5px] font-medium">{c.service}</p>
                      <p className="text-[11.5px] tabular-nums text-pane-muted">
                        {c.count} lookup{c.count === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {entries.length ? (
            <div className="flex flex-col gap-2">
              <p className="px-1 text-[11.5px] font-medium text-pane-muted">Requests with your mail</p>
              <div className="rounded-xl border border-pane-border px-4 py-3">
                {days.map((day) => (
                  <div key={day.label} className="flex flex-col">
                    <p className="pb-1.5 pt-1 text-[11.5px] font-semibold text-pane-muted">{day.label}</p>
                    <ol className="flex flex-col">
                      {day.items.map((e, i) => (
                        <li key={`${e.at}:${i}`} className="flex min-w-0 gap-3" data-sensitive>
                          <span className="w-10 shrink-0 pt-[7px] text-right text-[11px] tabular-nums text-pane-muted">{format(new Date(e.at), "HH:mm")}</span>
                          <span className="flex shrink-0 flex-col items-center">
                            <span className={cn("mt-1 grid size-6 place-items-center rounded-full", KIND[e.kind].tone)}>
                              <Icon icon={KIND[e.kind].icon} size={12} />
                            </span>
                            {i < day.items.length - 1 ? <span className="w-px flex-1 bg-pane-border" /> : null}
                          </span>
                          <div className="min-w-0 flex-1 pb-3 pt-1">
                            <p className="truncate text-[12.5px]">
                              <span className="font-medium">{e.action}</span>
                              {e.detail ? <span className="text-pane-muted"> · {e.detail}</span> : null}
                            </p>
                            <p className="truncate text-[11.5px] text-pane-muted">
                              {KIND[e.kind].label} · {e.service}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ol>
                  </div>
                ))}
                {entries.length > SHOWN ? (
                  <button onClick={() => setAll((a) => !a)} className="mt-1 text-[12px] font-medium text-accent hover:opacity-80">
                    {all ? "Show fewer" : `Show all ${entries.length}`}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Group>
  );
}

/**
 * App lock: set, change or remove a PIN (the current one is asked for), and how long idle or away
 * before Kite locks. The PIN goes only to Kite's own server, which keeps a salted hash.
 */
export function LockRow({
  on,
  after,
  onAfter,
  onChanged,
  onToast,
}: {
  on: boolean;
  after: (typeof LOCK_CHOICES)[number];
  onAfter: (minutes: (typeof LOCK_CHOICES)[number]) => void;
  onChanged: (on: boolean) => void;
  onToast: (message: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "set" | "remove">("idle");
  const [current, setCurrent] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setMode("idle");
    setCurrent("");
    setPin("");
    setError(null);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    const body = mode === "remove" ? { action: "clear", current } : { action: "set", pin, current: on ? current : undefined };
    try {
      const res = await fetch("/api/lock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { enabled?: boolean; error?: string };
      if (!res.ok) {
        setError(data.error ?? "That didn't work. Try again.");
        return;
      }
      onChanged(!!data.enabled);
      onToast(data.enabled ? (on ? "PIN changed" : "Kite now locks with your PIN") : "Lock removed");
      reset();
    } finally {
      setBusy(false);
    }
  };

  const digits = (value: string) => value.replace(/\D/g, "").slice(0, PIN_LENGTH);
  const pinInput = "h-8 w-28 rounded-full border border-pane-border bg-pane-2 px-3 text-center tabular-nums text-[13px] tracking-[0.3em] outline-none focus:border-accent";

  return (
    <>
    <Row
      label="Lock with a PIN"
      detail={on ? "Kite opens locked. Lock now with Shift+L." : "Keeps people at this computer out of your mail."}
      control={
        mode === "idle" ? (
          <div className="flex items-center gap-1.5">
            <button onClick={() => setMode("set")} className={buttonClass}>
              {on ? "Change PIN" : "Set a PIN"}
            </button>
            {on ? (
              <button onClick={() => setMode("remove")} className={quietButtonClass}>
                Remove
              </button>
            ) : null}
          </div>
        ) : null
      }
    >
      {mode !== "idle" ? (
        <form
          className="blur-fade-down flex flex-wrap items-center gap-2 rounded-lg bg-pane-2 px-3 py-2.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {on ? (
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label="Current PIN"
              placeholder="Current"
              value={current}
              onChange={(e) => setCurrent(digits(e.target.value))}
              className={pinInput}
              autoFocus
            />
          ) : null}
          {mode === "set" ? (
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              aria-label="New PIN"
              placeholder={`New ${PIN_LENGTH}-digit PIN`}
              value={pin}
              onChange={(e) => setPin(digits(e.target.value))}
              className={pinInput}
              autoFocus={!on}
            />
          ) : null}
          <span className="min-w-0 flex-1 text-[12px] text-warning">{error ?? ""}</span>
          <button type="button" onClick={reset} className={quietButtonClass}>
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || (mode === "set" ? pin.length < PIN_LENGTH : current.length < PIN_LENGTH) || (on && current.length < PIN_LENGTH)}
            className="h-8 rounded-full bg-pane-fg px-3.5 text-[12.5px] font-medium text-pane disabled:opacity-40"
          >
            {mode === "remove" ? "Remove lock" : "Save PIN"}
          </button>
        </form>
      ) : null}
    </Row>
    {on ? (
      <Row
        label="Lock after"
        detail="Idle or away this long."
        control={
          <Segmented
            label="Lock after"
            value={after}
            options={LOCK_CHOICES.map((m) => ({ id: m, label: m === 60 ? "1 hour" : `${m} min` }))}
            onChange={onAfter}
          />
        }
      />
    ) : null}
    </>
  );
}

/** Senders whose images always load, with Remove. Added from a message's privacy chip. */
export function ImageSenders({ people, onRemove }: { people: Record<string, PersonPrefs>; onRemove: (email: string) => void }) {
  const senders = Object.keys(people)
    .filter((email) => people[email].images)
    .sort();
  return (
    <div data-setting="Images always load from" className="flex flex-col gap-2 px-4 py-3.5">
      <p className="text-[13px] font-medium">Images always load from</p>
      {senders.length ? (
        <ul className="flex flex-col gap-1">
          {senders.map((email) => (
            <li key={email} className="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1" data-sensitive>
              <Avatar name={email} email={email} className="size-6 shrink-0 text-[10px]" />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{email}</span>
              <Tooltip label="Ask again" className="shrink-0">
                <button
                  aria-label={`Ask before loading images from ${email}`}
                  onClick={() => onRemove(email)}
                  className="grid size-6 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                >
                  <Icon icon={Cancel01Icon} size={12} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] leading-snug text-pane-muted">No one yet. Choose “Always for this sender” from the shield on a message.</p>
      )}
    </div>
  );
}
