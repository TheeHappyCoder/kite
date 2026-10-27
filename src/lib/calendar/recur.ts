// Occurrences of a repeating event (RFC 5545 RRULE), for the mail calendar (server/mail-calendar.ts).
// Works on wall-clock time in the event's own zone (Date.UTC of the local fields), so a weekly 10:00
// stays at 10:00 across daylight saving; the caller turns each one into an instant. Covers what
// invites use: FREQ, INTERVAL, COUNT, UNTIL, BYDAY (with "2TU" / "-1FR"), BYMONTHDAY, BYMONTH,
// BYSETPOS, WKST. Anything else returns null, and the caller shows only the first occurrence.

const DAY = 86_400_000;
const WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const FREQS = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"] as const;
const KNOWN = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "BYMONTHDAY", "BYMONTH", "BYSETPOS", "WKST"]);
/** Periods walked at most (a daily series about 40 years long). */
const MAX_PERIODS = 15_000;

type Rule = {
  freq: (typeof FREQS)[number];
  interval: number;
  count?: number;
  byDay: { nth: number; day: number }[];
  byMonthDay: number[];
  byMonth: number[];
  bySetPos: number[];
  wkst: number;
};

const numbers = (value: string | undefined) => (value ? value.split(",").map(Number).filter((n) => Number.isInteger(n) && n !== 0) : []);

function parseRule(text: string): Rule | null {
  const parts = Object.fromEntries(
    text
      .split(";")
      .filter(Boolean)
      .map((p) => {
        const eq = p.indexOf("=");
        return [p.slice(0, eq).trim().toUpperCase(), p.slice(eq + 1).trim().toUpperCase()] as const;
      }),
  );
  const freq = FREQS.find((f) => f === parts.FREQ);
  if (!freq || Object.keys(parts).some((k) => !KNOWN.has(k))) return null;
  const byDay: Rule["byDay"] = [];
  for (const item of (parts.BYDAY ?? "").split(",").filter(Boolean)) {
    const m = /^([+-]?\d{1,2})?([A-Z]{2})$/.exec(item);
    const day = m ? WEEKDAYS.indexOf(m[2]) : -1;
    if (!m || day < 0) return null;
    byDay.push({ nth: Number(m[1] ?? 0), day });
  }
  // An ordinal weekday across a whole year ("20th Monday") isn't something invites use.
  if (freq === "YEARLY" && byDay.some((d) => d.nth) && !parts.BYMONTH) return null;
  const count = parts.COUNT ? Number(parts.COUNT) : undefined;
  return {
    freq,
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    count: count && count > 0 ? count : undefined,
    byDay,
    byMonthDay: numbers(parts.BYMONTHDAY),
    byMonth: numbers(parts.BYMONTH),
    bySetPos: numbers(parts.BYSETPOS),
    wkst: Math.max(0, WEEKDAYS.indexOf(parts.WKST ?? "MO")),
  };
}

const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** Whether day `d` of the month matches one of the BYDAY entries (ordinals count within the month). */
function matchesDay(year: number, month: number, d: number, byDay: Rule["byDay"]) {
  const weekday = new Date(Date.UTC(year, month, d)).getUTCDay();
  const fromStart = Math.ceil(d / 7);
  const fromEnd = -(Math.floor((daysIn(year, month) - d) / 7) + 1);
  return byDay.some((b) => b.day === weekday && (!b.nth || b.nth === fromStart || b.nth === fromEnd));
}

/** The matching days (UTC midnight ms) of one month; `startDay` when the rule names none. */
function monthDays(year: number, month: number, rule: Rule, startDay: number): number[] {
  const n = daysIn(year, month);
  let days: number[];
  if (rule.byMonthDay.length) days = rule.byMonthDay.map((d) => (d > 0 ? d : n + 1 + d)).filter((d) => d >= 1 && d <= n);
  else if (rule.byDay.length) days = Array.from({ length: n }, (_, i) => i + 1);
  else days = startDay <= n ? [startDay] : [];
  if (rule.byDay.length) days = days.filter((d) => matchesDay(year, month, d, rule.byDay));
  return [...new Set(days)].sort((a, b) => a - b).map((d) => Date.UTC(year, month, d));
}

/** Candidate days (UTC midnight ms) in period `index` of the rule, and where that period starts. */
function period(rule: Rule, start: Date, index: number): { first: number; days: number[] } {
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const step = index * rule.interval;
  const inMonth = (day: number) => !rule.byMonth.length || rule.byMonth.includes(new Date(day).getUTCMonth() + 1);
  switch (rule.freq) {
    case "DAILY": {
      const day = startDay + step * DAY;
      const date = new Date(day);
      const ok =
        inMonth(day) &&
        (!rule.byMonthDay.length || monthDays(date.getUTCFullYear(), date.getUTCMonth(), { ...rule, byDay: [] }, 0).includes(day)) &&
        (!rule.byDay.length || rule.byDay.some((b) => b.day === date.getUTCDay()));
      return { first: day, days: ok ? [day] : [] };
    }
    case "WEEKLY": {
      const weekStart = startDay - ((start.getUTCDay() - rule.wkst + 7) % 7) * DAY + step * 7 * DAY;
      const wanted = rule.byDay.length ? rule.byDay.map((b) => b.day) : [start.getUTCDay()];
      const days = Array.from({ length: 7 }, (_, i) => weekStart + i * DAY).filter((day) => wanted.includes(new Date(day).getUTCDay()) && inMonth(day));
      return { first: weekStart, days };
    }
    case "MONTHLY": {
      const first = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + step, 1);
      const date = new Date(first);
      return { first, days: inMonth(first) ? monthDays(date.getUTCFullYear(), date.getUTCMonth(), rule, start.getUTCDate()) : [] };
    }
    case "YEARLY": {
      const year = start.getUTCFullYear() + step;
      const months = rule.byMonth.length ? [...rule.byMonth].sort((a, b) => a - b).map((m) => m - 1) : [start.getUTCMonth()];
      return { first: Date.UTC(year, 0, 1), days: months.flatMap((m) => monthDays(year, m, rule, start.getUTCDate())) };
    }
  }
}

/**
 * Wall-clock starts of a series from `start` (always the first) up to `before` (exclusive), honouring
 * COUNT and UNTIL (`pastUntil`). EXDATE and changed occurrences are the caller's. Null when the rule
 * uses something this doesn't read.
 */
export function expandRule(text: string, start: number, before: number, pastUntil: (wall: number) => boolean = () => false): number[] | null {
  const rule = parseRule(text);
  if (!rule) return null;
  const startDate = new Date(start);
  const timeOfDay = start - Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), startDate.getUTCDate());
  if (start >= before) return [];
  const out = [start];
  if (rule.count === 1) return out;
  for (let index = 0; index < MAX_PERIODS; index++) {
    const { first, days } = period(rule, startDate, index);
    if (first >= before) break;
    let picked = days;
    if (rule.bySetPos.length) {
      picked = rule.bySetPos
        .map((pos) => (pos > 0 ? days[pos - 1] : days[days.length + pos]))
        .filter((d): d is number => d !== undefined)
        .sort((a, b) => a - b);
    }
    for (const day of picked) {
      const wall = day + timeOfDay;
      if (wall <= start) continue;
      if (wall >= before || pastUntil(wall)) return out;
      out.push(wall);
      if (rule.count && out.length >= rule.count) return out;
    }
  }
  return out;
}
