import type { FieldType, FieldValue } from "./fields";

// Collections: your own tables, filled by automations ("Add to a collection"). A row is one email:
// what the automation read from it, plus who sent it, the subject and when. Columns come from the
// rows themselves, and the views come from the column types: amounts get totals by month, dates
// get "coming up". Shared by the server (server/collections.ts) and the Automations view.

export type CollectionColumn = { key: string; name: string; type: FieldType };

export type CollectionRow = {
  id: string;
  ruleId: string | null;
  accountId: string;
  threadId: string;
  messageId: string;
  subject: string;
  sender: string;
  /** When the email arrived. */
  at: string;
  values: Record<string, FieldValue | null>;
  columns: CollectionColumn[];
};

export type CollectionSummary = { id: string; name: string; rows: number; last: string | null };

export type CollectionData = { id: string; name: string; rows: CollectionRow[] };

/** The columns across the rows, in the order they first appear (a later automation can add some). */
export function columnsOf(rows: CollectionRow[]): CollectionColumn[] {
  const seen = new Map<string, CollectionColumn>();
  for (const row of [...rows].reverse()) for (const c of row.columns) if (!seen.has(c.key)) seen.set(c.key, c);
  return [...seen.values()];
}

/** Totals of an amount column per month (newest first), per currency. */
export function monthlyTotals(rows: CollectionRow[], key: string) {
  const months = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const v = row.values[key];
    if (v?.number == null) continue;
    const month = row.at.slice(0, 7);
    const byCurrency = months.get(month) ?? new Map<string, number>();
    const currency = v.currency ?? "";
    byCurrency.set(currency, (byCurrency.get(currency) ?? 0) + v.number);
    months.set(month, byCurrency);
  }
  return [...months]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, totals]) => ({ month, totals: [...totals].map(([currency, total]) => ({ currency, total })) }));
}

/** Rows whose date column is today or later, soonest first. */
export function comingUp(rows: CollectionRow[], key: string, now = Date.now()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  return rows
    .flatMap((row) => {
      const date = row.values[key]?.date;
      return date && Date.parse(date) >= today.getTime() ? [{ row, date }] : [];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
