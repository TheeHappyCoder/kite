"use client";

import { useState } from "react";
import { Calendar03Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import type { CalendarEvent, NewEvent } from "@/lib/calendar/event";
import { stripPrefix } from "@/lib/calendar/ics";
import type { PickedWhen } from "@/lib/calendar/when";
import { calendarName, permissionHref, serviceName } from "@/lib/mail/providers";
import { accountName, type Account } from "@/lib/mail/types";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { AccountFace } from "../mail/account-face";
import { DateTimePicker } from "../ui/date-time-picker";
import { Dialog } from "../ui/dialog";
import { Select } from "../ui/select";
import { Switch } from "../ui/switch";
import { pad, ymd } from "@/lib/format";

/** What "Add to calendar" starts from: the conversation's subject and account, and a date only if the user selected one. */
export type EventSeed = { subject: string; accountId?: string; when: PickedWhen | null };

const field = "h-10 w-full min-w-0 rounded-full border border-pane-border bg-pane-2 px-4 text-[13.5px] outline-none focus:border-accent/60";

/** The next whole hour, for a form opened without a time. */
function nextHour() {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return d;
}

function addHour(time: string) {
  const [h, m] = time.split(":").map(Number);
  return `${pad(Math.min(h + 1, 23))}:${pad(h + 1 > 23 ? 59 : m)}`;
}

const calendarOf = (account: Account) => calendarName(account) ?? "your calendar";

/** Where the event goes, in one line: the account's calendar, or only Kite for a mail calendar. */
const destination = (account: Account) =>
  account.mailCalendar ? `Only in Kite for ${accountName(account)}, not on your phone` : `In ${calendarOf(account)} for ${accountName(account)}`;

/** "Re: Fwd: Lunch on Friday" -> "Lunch on Friday". */
const titleFrom = (subject: string) => stripPrefix(subject.replace(/^(?:\s*(?:re|fwd?|aw|sv)\s*:\s*)+/i, "")).trim();

/**
 * The "Add to calendar" form: the user fills it in and saves; nothing is added by itself. Prefilled
 * with the subject, and with a day and time only when the user selected one in the email.
 */
export function AddEventDialog({
  seed,
  accounts,
  demo,
  onClose,
  onAdded,
}: {
  seed: EventSeed;
  accounts: Account[];
  /** Sample mail: the form works, nothing is saved anywhere. */
  demo: boolean;
  onClose: () => void;
  /** The saved event (null in demo mode). */
  onAdded: (event: CalendarEvent | null, account: Account) => void;
}) {
  const usable = demo ? accounts : accounts.filter((a) => a.calendar === true);
  const missing = accounts.filter((a) => a.calendar === false);
  const start = nextHour();
  const [form, setForm] = useState(() => {
    const time = seed.when?.start ?? `${pad(start.getHours())}:00`;
    return {
      accountId: usable.find((a) => a.id === seed.accountId)?.id ?? usable[0]?.id ?? "",
      summary: titleFrom(seed.subject),
      date: seed.when?.date ?? ymd(start),
      allDay: !!seed.when && !seed.when.start,
      start: time,
      end: seed.when?.end ?? addHour(time),
      location: "",
      notes: "",
    };
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));

  const save = async () => {
    if (saving) return;
    if (demo) return onAdded(null, usable.find((a) => a.id === form.accountId)!);
    setSaving(true);
    setError(null);
    const body: NewEvent = {
      accountId: form.accountId,
      summary: form.summary,
      date: form.date,
      allDay: form.allDay,
      ...(form.allDay ? {} : { start: form.start, end: form.end }),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...(form.location.trim() ? { location: form.location.trim() } : {}),
      ...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
    };
    try {
      const res = await fetch("/api/calendar/events", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const data = (await res.json().catch(() => ({}))) as { event?: CalendarEvent; error?: string };
      if (!res.ok || !data.event) {
        setError(data.error === "reconnect" ? "Reconnect this account in Settings, then try again." : (data.error ?? "Kite couldn't add the event. Try again."));
        return;
      }
      onAdded(data.event, usable.find((a) => a.id === form.accountId)!);
    } catch {
      setError("Kite couldn't reach the server. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const connect = async (account: Account) => {
    // Asks for calendar permission at the next sign-in, then signs in again.
    await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ calendar: true }) }).catch(() => {});
    window.location.assign(permissionHref(account));
  };

  return (
    <Dialog open onClose={onClose} title="Add to calendar" description="Check the details first: Kite only filled in the subject and anything you selected." className="w-[480px] max-w-full">
      {usable.length ? (
        <form
          className="flex flex-col gap-3 px-5 pb-5"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <input
            data-sensitive
            autoFocus
            value={form.summary}
            onChange={(e) => set("summary", e.target.value)}
            placeholder="Title"
            aria-label="Title"
            className={cn(field, "font-medium")}
          />
          <DateTimePicker
            label="When"
            value={{ date: form.date, start: form.start, end: form.end }}
            dateOnly={form.allDay}
            onChange={(when) => setForm((f) => ({ ...f, ...when }))}
          />
          <label className="flex items-center justify-between gap-3 px-1 text-[13px]">
            All day
            <Switch value={form.allDay} onChange={(allDay) => set("allDay", allDay)} label="All day" size="sm" />
          </label>
          <input data-sensitive value={form.location} onChange={(e) => set("location", e.target.value)} placeholder="Where (optional)" aria-label="Where" className={field} />
          <textarea
            data-sensitive
            value={form.notes}
            onChange={(e) => set("notes", e.target.value)}
            placeholder="Notes (optional)"
            aria-label="Notes"
            rows={2}
            className="w-full resize-none rounded-2xl border border-pane-border bg-pane-2 px-4 py-2.5 text-[13.5px] outline-none focus:border-accent/60"
          />
          {usable.length > 1 ? (
            <Select
              label="Calendar"
              value={form.accountId}
              options={usable.map((a) => ({
                value: a.id,
                label: accountName(a),
                detail: `${a.email} · ${a.mailCalendar ? "Only in Kite" : serviceName(a)}`,
                icon: <AccountFace account={a} className="size-5 text-[8px]" />,
              }))}
              onChange={(accountId) => set("accountId", accountId)}
              className="h-10 self-start pl-2"
            />
          ) : (
            <div className="flex min-w-0 items-center gap-2 px-1 text-[12px] text-pane-muted">
              <AccountFace account={usable[0]} className="size-5 text-[8px]" />
              <span className="truncate">{destination(usable[0])}</span>
            </div>
          )}
          {usable.length > 1 && usable.find((a) => a.id === form.accountId)?.mailCalendar ? (
            <p className="px-1 text-[12px] text-pane-muted">{destination(usable.find((a) => a.id === form.accountId)!)}</p>
          ) : null}
          {error ? <p className="blur-fade px-1 text-[12.5px] text-warning">{error}</p> : null}
          <button
            type="submit"
            disabled={saving || !form.summary.trim() || !form.date}
            className="mt-1 flex h-11 w-full items-center justify-center gap-2 rounded-full bg-pane-fg text-[14px] font-medium text-pane disabled:opacity-60"
          >
            <Icon icon={Tick02Icon} size={16} /> {saving ? "Adding…" : error ? "Try again" : "Add to calendar"}
          </button>
        </form>
      ) : (
        <div className="flex flex-col items-start gap-3 px-5 pb-5">
          <p className="flex items-start gap-2 text-[13px] leading-relaxed text-pane-muted">
            <Icon icon={Calendar03Icon} size={16} className="mt-0.5 shrink-0" />
            {missing.length
              ? "Kite needs permission to use your calendar first. Connecting signs you in again and asks for it."
              : "None of your accounts has a calendar Kite can add to."}
          </p>
          {missing.map((account) => (
            <button key={account.id} onClick={() => void connect(account)} className="rounded-full border border-accent/50 px-3.5 py-1.5 text-[12.5px] font-medium text-accent hover:bg-accent-soft">
              Connect {calendarOf(account)}
              {missing.length > 1 ? ` for ${accountName(account)}` : ""}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}
