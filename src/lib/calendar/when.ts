import { pad, ymd } from "../format";

// Reads a day (and maybe a time) from text the user selected before "Add to calendar", so the form
// opens on it. Only the selection, never the rest of the email; when it isn't clearly one date,
// nothing is filled in. Day-first numbers (20/10/2026), as written in South Africa and most places.

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAY = "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)";

export type PickedWhen = { date: string; start?: string; end?: string };

function valid(year: number, month: number, day: number) {
  const d = new Date(year, month, day);
  return d.getFullYear() === year && d.getMonth() === month && d.getDate() === day ? d : null;
}

/** A date with no year: this year, or next year when it has already passed. */
function upcoming(month: number, day: number, now: Date) {
  const d = valid(now.getFullYear(), month, day);
  if (!d) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d < today ? valid(now.getFullYear() + 1, month, day) : d;
}

function fullYear(text: string) {
  const n = Number(text);
  return text.length === 2 ? 2000 + n : n;
}

function findDate(text: string, now: Date): Date | null {
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (m) return valid(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2}|\d{4}))?\b/.exec(text);
  if (m) return m[3] ? valid(fullYear(m[3]), Number(m[2]) - 1, Number(m[1])) : upcoming(Number(m[2]) - 1, Number(m[1]), now);
  m = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+of)?\\s+${MONTH}\\.?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    return m[3] ? valid(Number(m[3]), month, Number(m[1])) : upcoming(month, Number(m[1]), now);
  }
  m = new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(text);
  if (m) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    return m[3] ? valid(Number(m[3]), month, Number(m[2])) : upcoming(month, Number(m[2]), now);
  }
  if (/\btoday\b/i.test(text)) return new Date(now);
  if (/\btomorrow\b/i.test(text)) return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  m = new RegExp(`\\b(next\\s+)?${WEEKDAY}\\b`, "i").exec(text);
  if (m) {
    const target = WEEKDAYS.indexOf(m[2].slice(0, 3).toLowerCase());
    let ahead = (target - now.getDay() + 7) % 7;
    // "Tuesday" on a Tuesday is today; "next Tuesday" is a week away.
    if (ahead === 0 && m[1]) ahead = 7;
    return new Date(now.getFullYear(), now.getMonth(), now.getDate() + ahead);
  }
  return null;
}

/** "3pm", "3:30 pm", "15:00", "15h00" -> "HH:mm". */
function times(text: string) {
  const found: string[] = [];
  const re = /\b(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\b|\s|$)/gi;
  for (const m of text.matchAll(re)) {
    const meridiem = m[3]?.replace(/\./g, "").toLowerCase();
    // A bare number is a day or a count, not a time.
    if (!m[2] && !meridiem) continue;
    let hour = Number(m[1]);
    const minute = Number(m[2] ?? 0);
    if (minute > 59 || hour > 23 || (meridiem && (hour < 1 || hour > 12))) continue;
    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
    found.push(`${pad(hour)}:${pad(minute)}`);
  }
  return found;
}

/** The one date in a short selection (plus its time, and an end time when given), or null. */
export function whenFromSelection(text: string, now: Date): PickedWhen | null {
  const selected = text.trim();
  if (!selected || selected.length > 200) return null;
  // Dates are matched before times, so "20/10" is never read as a time.
  const date = findDate(selected, now);
  if (!date) return null;
  const withoutDates = selected.replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}[/.]\d{1,2}(?:[/.]\d{2,4})?\b/g, " ");
  const [start, end] = times(withoutDates);
  return { date: ymd(date), ...(start ? { start } : {}), ...(start && end && end > start ? { end } : {}) };
}
