"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Cancel01Icon, Download04Icon, MailSend01Icon, PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { format } from "date-fns";
import { formatAmount } from "@/lib/automations/values";
import { columnsOf, comingUp, monthlyTotals, type CollectionData, type CollectionRow } from "@/lib/automations/collections";
import { blurFade } from "@/lib/motion";
import { cn, formatListDate } from "@/lib/utils";
import { Icon } from "../icon";
import { AccentTitle } from "../ui/accent-title";
import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import { Spinner } from "../ui/spinner";
import { Tooltip } from "../ui/tooltip";
import { buttonClass, request } from "./builder";
import { Select } from "../ui/select";
import type { ComposeDraft } from "@/lib/mail/compose";

const PACK_TO = "kite-pack-to";

type PackSummary = { rows: number; files: number; links: number; missing: number; tooBig: number };

/**
 * "Send a month": one month of the collection as an email to your accountant, opened in compose
 * to look over (every file attached, emails with only a link listed). The address is remembered.
 */
function SendMonth({ id, months, onCompose, onToast, onClose }: { id: string; months: string[]; onCompose: (draft: ComposeDraft) => void; onToast: (message: string) => void; onClose: () => void }) {
  const [month, setMonth] = useState(months[0] ?? "");
  const [to, setTo] = useState(() => (typeof localStorage === "undefined" ? "" : (localStorage.getItem(PACK_TO) ?? "")));
  const [busy, setBusy] = useState(false);
  const prepare = async () => {
    setBusy(true);
    try {
      const res = await request<{ draft: ComposeDraft; summary: PackSummary }>(`/api/collections/${id}/pack?month=${month}&to=${encodeURIComponent(to.trim())}`, "GET");
      localStorage.setItem(PACK_TO, to.trim());
      onCompose(res.draft);
      const s = res.summary;
      const extra = [s.links ? `${s.links} to download from a link` : "", s.missing ? `${s.missing} with no file` : "", s.tooBig ? `${s.tooBig} too big to attach` : ""].filter(Boolean);
      onToast(`${s.files} file${s.files === 1 ? "" : "s"} attached${extra.length ? `; ${extra.join(", ")} listed in the email` : ""}.`);
      onClose();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That couldn't be made. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div {...blurFade({ y: -4, blur: 4 })} className="flex basis-full flex-wrap items-center gap-2 rounded-2xl bg-pane-2 px-3.5 py-2.5 text-[12.5px]">
      <span className="text-pane-muted">Send</span>
      <Select label="Month" value={month} options={months.map((m) => ({ value: m, label: format(new Date(`${m}-01T00:00:00`), "MMMM yyyy") }))} onChange={setMonth} />
      <span className="text-pane-muted">to</span>
      <input
        type="email"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && void prepare()}
        placeholder="accountant@example.com"
        aria-label="Who gets it"
        className="h-8 w-56 min-w-0 rounded-full border border-pane-border bg-transparent px-3 outline-none placeholder:text-pane-muted focus:border-accent/60"
      />
      <button onClick={() => void prepare()} disabled={busy || !month || !to.includes("@")} className="flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 font-medium text-accent-fg disabled:opacity-50">
        {busy ? <Spinner size={12} /> : null}
        Open in compose
      </button>
      <button onClick={onClose} className="h-8 rounded-full px-2 text-pane-muted hover:text-pane-fg">
        Cancel
      </button>
      <span className="basis-full text-[11.5px] text-pane-muted">Every file those emails carried is attached; emails that only had a link are listed to download. Nothing is sent until you press Send.</span>
    </motion.div>
  );
}

// One collection (lib/automations/collections.ts): what the types make possible on top (totals by
// month for amounts, coming up for dates), then every row as a table. A row opens its email.

/** The rows as CSV (Excel and Sheets open it): when, from, subject, then each column's text. */
function toCsv(rows: CollectionRow[]) {
  const columns = columnsOf(rows);
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const head = ["When", "From", "Subject", ...columns.map((c) => c.name)];
  const body = rows.map((r) => [format(new Date(r.at), "yyyy-MM-dd HH:mm"), r.sender, r.subject, ...columns.map((c) => r.values[c.key]?.number ?? r.values[c.key]?.text ?? "")].map((v) => cell(String(v))).join(","));
  return [head.join(","), ...body].join("\n");
}

export function CollectionView({
  id,
  refreshKey,
  onOpenConversation,
  onCompose,
  onChanged,
  onDeleted,
  onToast,
}: {
  id: string;
  refreshKey: string;
  onOpenConversation: (target: { threadId: string; accountId: string; subject: string }) => void;
  /** Opens an email in compose (Send a month); absent in the demo. */
  onCompose?: (draft: ComposeDraft) => void;
  /** The list of collections changed (a rename). */
  onChanged: () => void;
  onDeleted: () => void;
  onToast: (message: string) => void;
}) {
  const [data, setData] = useState<CollectionData | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/collections/${id}`, { signal: controller.signal })
      .then((r) => r.json() as Promise<{ collection?: CollectionData }>)
      .then((d) => d.collection && setData(d.collection))
      .catch(() => {});
    return () => controller.abort();
  }, [id, refreshKey, reloads]);

  const [query, setQuery] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [packing, setPacking] = useState(false);
  const columns = useMemo(() => (data ? columnsOf(data.rows) : []), [data]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data || !q) return data?.rows ?? [];
    return data.rows.filter((r) => `${r.subject} ${r.sender} ${Object.values(r.values).map((v) => v?.text ?? "").join(" ")}`.toLowerCase().includes(q));
  }, [data, query]);
  const amount = columns.find((c) => c.type === "money" || c.type === "number");
  const date = columns.find((c) => c.type === "date");
  const months = useMemo(() => (data && amount ? monthlyTotals(data.rows, amount.key).slice(0, 6) : []), [data, amount]);
  const [now] = useState(() => Date.now());
  const upcoming = useMemo(() => (data && date ? comingUp(data.rows, date.key, now).slice(0, 5) : []), [data, date, now]);

  if (!data) {
    return (
      <div className="grid h-full place-items-center bg-pane text-pane-muted">
        <Spinner size={18} />
      </div>
    );
  }

  const rename = async () => {
    if (!renaming?.trim()) return setRenaming(null);
    try {
      await request(`/api/collections/${id}`, "PATCH", { name: renaming });
      setData({ ...data, name: renaming.trim() });
      setRenaming(null);
      onChanged();
    } catch (error) {
      onToast(error instanceof Error ? error.message : "That didn't save.");
    }
  };
  const remove = async () => {
    await request(`/api/collections/${id}`, "DELETE").catch(() => {});
    onDeleted();
  };
  const removeRow = async (row: CollectionRow) => {
    setData({ ...data, rows: data.rows.filter((r) => r.id !== row.id) });
    await request(`/api/collections/${id}?row=${row.id}`, "DELETE").catch(() => setReloads((n) => n + 1));
  };
  const exportCsv = () => {
    const url = URL.createObjectURL(new Blob([toCsv(data.rows)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.name}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };
  const peak = Math.max(1, ...months.map((m) => Math.abs(m.totals[0]?.total ?? 0)));

  return (
    <section className="@container flex h-full min-w-0 flex-col bg-pane text-pane-fg">
      <header className="flex flex-wrap items-center gap-2 px-6 pb-3 pt-5">
        {renaming !== null ? (
          <input
            autoFocus
            value={renaming}
            onChange={(e) => setRenaming(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => void rename()}
            aria-label="Collection name"
            className="h-9 min-w-0 flex-1 rounded-lg bg-pane-2 px-2 text-[22px] font-medium tracking-[-0.035em] outline-none"
          />
        ) : (
          <h2 className="min-w-0 flex-1 truncate text-[24px] font-medium tracking-[-0.035em]">
            <AccentTitle text={data.name} />
            <span className="ml-2 text-[13px] font-normal tracking-normal text-pane-muted">{data.rows.length} rows</span>
          </h2>
        )}
        <AnimatePresence mode="popLayout" initial={false}>
          {confirm ? (
            <motion.div key="confirm" {...blurFade({ x: 6, blur: 4 })} className="flex items-center gap-1.5 text-[12.5px]">
              <span className="text-pane-muted">Delete it and its rows? Your mail stays.</span>
              <button onClick={() => setConfirm(false)} className="h-8 rounded-full px-3 text-pane-muted hover:text-pane-fg">
                Keep
              </button>
              <button onClick={() => void remove()} className="h-8 rounded-full bg-pane-fg px-3.5 font-medium text-pane">
                Delete
              </button>
            </motion.div>
          ) : (
            <motion.div key="tools" {...blurFade({ x: -6, blur: 4 })} className="flex items-center gap-1.5">
              <button onClick={() => setRenaming(data.name)} className={buttonClass}>
                <Icon icon={PencilEdit02Icon} size={13} />
                Rename
              </button>
              <button onClick={exportCsv} disabled={!data.rows.length} className={buttonClass}>
                <Icon icon={Download04Icon} size={13} />
                Export
              </button>
              {onCompose ? (
                <button onClick={() => setPacking((p) => !p)} disabled={!data.rows.length} className={buttonClass}>
                  <Icon icon={MailSend01Icon} size={13} />
                  Send a month
                </button>
              ) : null}
              <button onClick={() => setConfirm(true)} className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:text-pane-fg">
                Delete
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence initial={false}>
          {packing && onCompose ? (
            <SendMonth
              key="pack"
              id={id}
              months={[...new Set(data.rows.map((r) => format(new Date(r.at), "yyyy-MM")))].sort().reverse()}
              onCompose={onCompose}
              onToast={onToast}
              onClose={() => setPacking(false)}
            />
          ) : null}
        </AnimatePresence>
      </header>

      <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-6 pb-8">
        {!data.rows.length ? (
          <div className="blur-fade mt-10 text-center">
            <p className="text-[18px] font-medium tracking-[-0.03em]">
              Nothing <span className="font-accent text-[1.12em]">yet</span>
            </p>
            <p className="mx-auto mt-1 max-w-80 text-[13px] text-pane-muted">Rows arrive as automations add to this collection. Use Run on existing mail in an automation to fill it from the last 30 days.</p>
          </div>
        ) : (
          <>
            {months.length || upcoming.length ? (
              <div className="grid gap-3 pb-4 @min-[640px]:grid-cols-2">
                {months.length && amount ? (
                  <div className="rounded-2xl bg-pane-2 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-pane-muted">{amount.name} by month</p>
                    <ul className="mt-3 flex flex-col gap-2">
                      {months.map((m) => {
                        const first = m.totals[0];
                        return (
                          <li key={m.month} className="grid grid-cols-[64px_1fr_auto] items-center gap-3 text-[12.5px]">
                            <span className="text-pane-muted">{format(new Date(`${m.month}-01T00:00:00`), "MMM yyyy")}</span>
                            <span className="h-2 overflow-hidden rounded-full bg-pane">
                              <span className="block h-full rounded-full bg-accent" style={{ width: `${(Math.abs(first.total) / peak) * 100}%` }} />
                            </span>
                            <span className="font-medium tabular-nums" data-sensitive>
                              {m.totals.map((t) => formatAmount(t.total, t.currency)).join(" · ")}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                ) : null}
                {upcoming.length && date ? (
                  <div className="rounded-2xl bg-pane-2 p-4">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-pane-muted">Coming up · {date.name}</p>
                    <FluidList tone="pane" className="-mx-2 mt-2 flex flex-col">
                      {upcoming.map(({ row, date: when }) => (
                        <button
                          key={row.id}
                          {...FLUID_ITEM}
                          onClick={() => onOpenConversation({ threadId: row.threadId, accountId: row.accountId, subject: row.subject })}
                          className="relative flex items-baseline gap-3 rounded-lg px-2 py-1.5 text-left text-[12.5px]"
                        >
                          <span className="w-16 shrink-0 font-medium tabular-nums">{format(new Date(when), "d MMM")}</span>
                          <span className="min-w-0 flex-1 truncate" data-sensitive>
                            {row.sender} · {row.subject}
                          </span>
                          {amount && row.values[amount.key] ? (
                            <span className="shrink-0 tabular-nums text-pane-muted" data-sensitive>
                              {row.values[amount.key]!.text}
                            </span>
                          ) : null}
                        </button>
                      ))}
                    </FluidList>
                  </div>
                ) : null}
              </div>
            ) : null}

            <label className="mb-2 flex h-9 items-center gap-2 rounded-full border border-pane-border px-3 text-[13px] focus-within:border-accent/60">
              <Icon icon={Search01Icon} size={14} className="text-pane-muted" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${data.name}`} className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-pane-muted" />
            </label>

            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-separate border-spacing-0 text-left text-[12.5px]">
                <thead>
                  <tr className="text-[11px] uppercase tracking-[0.06em] text-pane-muted">
                    <th className="border-b border-pane-border px-2 py-2 font-semibold">When</th>
                    <th className="border-b border-pane-border px-2 py-2 font-semibold">From</th>
                    {columns.map((c) => (
                      <th key={c.key} className={cn("border-b border-pane-border px-2 py-2 font-semibold", (c.type === "money" || c.type === "number") && "text-right")}>
                        {c.name}
                      </th>
                    ))}
                    <th className="w-8 border-b border-pane-border" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((row) => (
                    <tr
                      key={row.id}
                      onClick={() => onOpenConversation({ threadId: row.threadId, accountId: row.accountId, subject: row.subject })}
                      className="group cursor-default transition-colors duration-150 hover:bg-pane-hover"
                    >
                      <td className="whitespace-nowrap border-b border-pane-border/60 px-2 py-2 tabular-nums text-pane-muted">{formatListDate(row.at)}</td>
                      <td className="max-w-48 truncate border-b border-pane-border/60 px-2 py-2" data-sensitive>
                        <span className="font-medium">{row.sender}</span>
                        <span className="block truncate text-[11.5px] text-pane-muted">{row.subject}</span>
                      </td>
                      {columns.map((c) => {
                        const v = row.values[c.key];
                        return (
                          <td
                            key={c.key}
                            className={cn("max-w-56 truncate border-b border-pane-border/60 px-2 py-2", (c.type === "money" || c.type === "number") && "text-right font-medium tabular-nums")}
                            data-sensitive
                          >
                            {!v ? (
                              <span className="text-pane-muted/60">·</span>
                            ) : c.type === "link" ? (
                              <a href={v.text} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
                                Open
                              </a>
                            ) : (
                              v.text
                            )}
                          </td>
                        );
                      })}
                      <td className="border-b border-pane-border/60 px-1 py-2">
                        <Tooltip label="Remove this row (the email stays)">
                          <button
                            {...FLUID_IGNORE}
                            aria-label="Remove this row"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeRow(row);
                            }}
                            className="grid size-6 place-items-center rounded-full text-pane-muted opacity-0 hover:bg-pane-2 hover:text-pane-fg group-hover:opacity-100"
                          >
                            <Icon icon={Cancel01Icon} size={11} />
                          </button>
                        </Tooltip>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
