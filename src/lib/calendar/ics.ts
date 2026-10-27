import type { AttendeeStatus, Invite, InviteResponse } from "./invite";

// iCalendar (RFC 5545) in and iTIP replies (RFC 5546) out, no dependencies. Reads only what the
// invite card needs; anything it can't make sense of leaves the field out rather than guessing.

type Prop = { name: string; params: Record<string, string>; value: string };
type Block = { type: string; props: Prop[]; children: Block[] };

/** Joins folded lines (a line starting with a space or tab continues the one before). */
function unfold(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}

/** NAME;PARAM=value;PARAM="quoted:value":VALUE */
function parseLine(line: string): Prop | null {
  let i = 0;
  let quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  if (i >= line.length) return null;
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts: string[] = [];
  let current = "";
  quoted = false;
  for (const c of head) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      parts.push(current);
      current = "";
    } else current += c;
  }
  parts.push(current);
  const params: Record<string, string> = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value };
}

function parseBlocks(text: string): Block {
  const root: Block = { type: "ROOT", props: [], children: [] };
  const stack = [root];
  for (const line of unfold(text)) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1];
    if (prop.name === "BEGIN") {
      const block: Block = { type: prop.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(block);
      stack.push(block);
    } else if (prop.name === "END") {
      if (stack.length > 1) stack.pop();
    } else top.props.push(prop);
  }
  return root;
}

const unescape = (v: string) => v.replace(/\\[nN]/g, "\n").replace(/\\([,;\\])/g, "$1");
const escape = (v: string) => v.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

const get = (block: Block, name: string) => block.props.find((p) => p.name === name);
const all = (block: Block, name: string) => block.props.filter((p) => p.name === name);

function mailto(value: string) {
  return value.replace(/^mailto:/i, "").trim();
}

// ---- Time ----

/** Minutes east of UTC that `zone` is at `utcMs` (via Intl; null when the zone isn't known to it). */
function zoneOffset(utcMs: number, zone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(utcMs));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return (Date.UTC(n("year"), n("month") - 1, n("day"), n("hour") % 24, n("minute"), n("second")) - utcMs) / 60000;
  } catch {
    return null;
  }
}

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };

function wallOf(value: string): (Wall & { utc: boolean; dateOnly: boolean }) | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  return { y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] ?? 0), mi: +(m[5] ?? 0), s: +(m[6] ?? 0), utc: !!m[7], dateOnly: !m[4] };
}

const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);

/** "+0200" -> 120 */
function offsetMinutes(value: string) {
  const m = /^([+-])(\d{2})(\d{2})/.exec(value.trim());
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : null;
}

const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The day a yearly rule like BYMONTH=3;BYDAY=-1SU lands on in `year`. */
function ruleDay(rule: string, year: number) {
  const parts = Object.fromEntries(rule.split(";").map((p) => p.split("=") as [string, string]));
  const month = Number(parts.BYMONTH);
  const m = /^([+-]?\d)?([A-Z]{2})$/.exec(parts.BYDAY ?? "");
  if (!month || !m) return null;
  const weekday = DAYS.indexOf(m[2]);
  const nth = Number(m[1] ?? 1);
  if (nth > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return 1 + ((weekday - first + 7) % 7) + (nth - 1) * 7;
  }
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
  return lastDate - ((last - weekday + 7) % 7) + (nth + 1) * 7;
}

/** Offset from a VTIMEZONE block (Outlook's Windows zone names): standard and daylight rules for that year. */
function vtimezoneOffset(tz: Block, w: Wall): number | null {
  let best: { at: number; offset: number } | null = null;
  for (const sub of tz.children) {
    if (sub.type !== "STANDARD" && sub.type !== "DAYLIGHT") continue;
    const offset = offsetMinutes(get(sub, "TZOFFSETTO")?.value ?? "");
    const start = wallOf(get(sub, "DTSTART")?.value ?? "");
    if (offset == null || !start) continue;
    const rule = get(sub, "RRULE")?.value;
    const candidates = [start];
    if (rule) {
      for (const year of [w.y - 1, w.y]) {
        const day = ruleDay(rule, year);
        const month = Number(/BYMONTH=(\d+)/.exec(rule)?.[1]);
        if (day && month) candidates.push({ ...start, y: year, mo: month, d: day });
      }
    }
    for (const c of candidates) {
      const at = wallMs(c);
      if (at <= wallMs(w) && (!best || at > best.at)) best = { at, offset };
    }
  }
  return best?.offset ?? null;
}

/** An iCalendar date-time as an ISO instant, using TZID (IANA via Intl, else the file's VTIMEZONE). */
function instant(prop: Prop | undefined, zones: Map<string, Block>): { iso: string; dateOnly: boolean } | null {
  if (!prop) return null;
  const w = wallOf(prop.value);
  if (!w) return null;
  if (w.dateOnly || prop.params.VALUE === "DATE") return { iso: new Date(wallMs(w)).toISOString(), dateOnly: true };
  if (w.utc) return { iso: new Date(wallMs(w)).toISOString(), dateOnly: false };
  const tzid = prop.params.TZID;
  const local = wallMs(w);
  if (tzid) {
    // Intl first (one correction pass for the offset at the result); then the file's own zone rules.
    const first = zoneOffset(local, tzid);
    if (first != null) {
      const second = zoneOffset(local - first * 60000, tzid) ?? first;
      return { iso: new Date(local - second * 60000).toISOString(), dateOnly: false };
    }
    const block = zones.get(tzid);
    const offset = block ? vtimezoneOffset(block, w) : null;
    if (offset != null) return { iso: new Date(local - offset * 60000).toISOString(), dateOnly: false };
  }
  // Floating time: read as the viewer's local time.
  return { iso: new Date(w.y, w.mo - 1, w.d, w.h, w.mi, w.s).toISOString(), dateOnly: false };
}

// ---- Fields ----

const WEEKDAY_NAMES: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };

/** "Weekly on Tuesday", "Every 2 weeks", "Every day until 3 Nov". */
function describeRule(rule: string) {
  const parts = Object.fromEntries(rule.split(";").map((p) => p.split("=") as [string, string]));
  const interval = Number(parts.INTERVAL ?? 1);
  const unit = { DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" }[parts.FREQ as string];
  if (!unit) return "Repeats";
  let text = interval > 1 ? `Every ${interval} ${unit}s` : { day: "Every day", week: "Weekly", month: "Monthly", year: "Yearly" }[unit]!;
  const days = (parts.BYDAY ?? "")
    .split(",")
    .map((d) => WEEKDAY_NAMES[d.replace(/^[+-]?\d+/, "")])
    .filter(Boolean);
  if (unit === "week" && days.length) text += ` on ${days.length === 5 && !days.includes("Saturday") && !days.includes("Sunday") ? "weekdays" : days.join(", ")}`;
  const until = wallOf(parts.UNTIL ?? "");
  if (until) text += ` until ${new Date(wallMs(until)).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`;
  else if (parts.COUNT) text += `, ${parts.COUNT} times`;
  return text;
}

const JOIN = /https:\/\/(?:meet\.google\.com\/[a-z0-9-]+|teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+|teams\.live\.com\/meet\/[^\s"<>]+|(?:[\w-]+\.)?zoom\.us\/j\/[^\s"<>]+|[\w-]+\.webex\.com\/[^\s"<>]+)/i;

/** A video call link in any of these texts (location first, then the description). */
export function findJoinLink(...texts: (string | undefined)[]) {
  for (const text of texts) {
    const found = text && JOIN.exec(text)?.[0];
    if (found) return found.replace(/[).,;>]+$/, "");
  }
  return undefined;
}

/** One occurrence of a series: the raw property (echoed back in replies) and when it was meant to start. */
function occurrence(prop: Prop | undefined, zones: Map<string, Block>) {
  if (!prop) return {};
  const params = Object.entries(prop.params).map(([k, v]) => `;${k}=${/[:;,]/.test(v) ? `"${v}"` : v}`).join("");
  return { recurrenceId: `${params}:${prop.value.trim()}`, occurrence: instant(prop, zones)?.iso };
}

/** An event title without the "Canceled: " / "Accepted: " style prefix mail apps add. */
export function stripPrefix(title: string) {
  return title.replace(/^(?:(?:Canceled|Cancelled)(?: event)?|Updated(?: invitation)?|Invitation|Accepted|Declined|Tentative(?:ly accepted)?|New time proposed):\s*/i, "").trim();
}

const PARTSTAT: Record<string, AttendeeStatus> = {
  ACCEPTED: "accepted",
  TENTATIVE: "tentative",
  DECLINED: "declined",
  "NEEDS-ACTION": "needs-action",
  DELEGATED: "delegated",
};

function person(prop: Prop) {
  const email = mailto(prop.value);
  return { name: prop.params.CN?.trim() || email.split("@")[0] || email, email };
}

type Calendar = { calendar: Block; zones: Map<string, Block>; method: Invite["method"] };

function calendarOf(text: string): Calendar | null {
  const root = parseBlocks(text);
  const calendar = root.children.find((b) => b.type === "VCALENDAR");
  if (!calendar) return null;
  const zones = new Map(calendar.children.filter((b) => b.type === "VTIMEZONE").map((b) => [get(b, "TZID")?.value ?? "", b] as const));
  const raw = (get(calendar, "METHOD")?.value ?? "PUBLISH").trim().toUpperCase();
  const known = ["REQUEST", "CANCEL", "REPLY", "PUBLISH", "COUNTER"] as const;
  return { calendar, zones, method: (known as readonly string[]).includes(raw) ? (raw as Invite["method"]) : "OTHER" };
}

/** One VEVENT as an invite (null without a start). */
function inviteOf(event: Block, { zones, method }: Calendar, me?: string): Invite | null {
  const start = instant(get(event, "DTSTART"), zones);
  if (!start) return null;
  let end = instant(get(event, "DTEND"), zones);
  const duration = get(event, "DURATION")?.value;
  if (!end && duration) {
    const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(duration.trim());
    if (m) {
      const ms = ((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 86400 + +(m[3] ?? 0) * 3600 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) * 1000;
      end = { iso: new Date(Date.parse(start.iso) + ms).toISOString(), dateOnly: start.dateOnly };
    }
  }

  const description = get(event, "DESCRIPTION");
  const location = get(event, "LOCATION");
  const attendees = all(event, "ATTENDEE").map((p) => ({
    ...person(p),
    status: PARTSTAT[(p.params.PARTSTAT ?? "NEEDS-ACTION").toUpperCase()] ?? "needs-action",
    ...(p.params.ROLE?.toUpperCase() === "OPT-PARTICIPANT" ? { optional: true } : {}),
  }));
  const organizer = get(event, "ORGANIZER");
  const mine = me?.toLowerCase();
  const you = mine ? attendees.find((a) => a.email.toLowerCase() === mine)?.status : undefined;
  const rule = get(event, "RRULE")?.value;
  const conference = get(event, "X-GOOGLE-CONFERENCE")?.value ?? get(event, "CONFERENCE")?.value;
  const statusValue = get(event, "STATUS")?.value.trim().toUpperCase();

  return {
    uid: get(event, "UID")?.value.trim() ?? "",
    method,
    sequence: Number(get(event, "SEQUENCE")?.value ?? 0) || 0,
    // Outlook writes "Canceled: " / "Updated: " into the event's own title on cancellations and updates.
    summary: stripPrefix(unescape(get(event, "SUMMARY")?.value ?? "")) || "(no title)",
    start: start.iso,
    end: end?.iso,
    allDay: start.dateOnly,
    timeZone: get(event, "DTSTART")?.params.TZID,
    recurrence: rule ? describeRule(rule) : undefined,
    ...occurrence(get(event, "RECURRENCE-ID"), zones),
    location: location ? unescape(location.value).trim() || undefined : undefined,
    join: findJoinLink(conference, location && unescape(location.value), description && unescape(description.value)),
    organizer: organizer ? person(organizer) : undefined,
    attendees,
    cancelled: method === "CANCEL" || statusValue === "CANCELLED" || undefined,
    you,
  };
}

/**
 * The invite in an iCalendar file, from the point of view of `me` (your address: which attendee
 * is you). Null when there's no event in it.
 */
export function parseIcs(text: string, me?: string): Invite | null {
  const parsed = calendarOf(text);
  if (!parsed) return null;
  const events = parsed.calendar.children.filter((b) => b.type === "VEVENT");
  // The series itself when there is one; an occurrence (RECURRENCE-ID) only when it's all there is.
  const event = events.find((e) => !get(e, "RECURRENCE-ID")) ?? events[0];
  return event ? inviteOf(event, parsed, me) : null;
}

/** A VEVENT with what repeating it needs (the mail calendar, server/mail-calendar.ts). */
export type IcsEvent = Invite & {
  /** The raw RRULE ("FREQ=WEEKLY;BYDAY=TU"), for lib/calendar/recur.ts. */
  rule?: string;
  /** Starts left out of the series (EXDATE), as ISO instants like `start`. */
  exdates: string[];
  /** DTSTART as wall-clock time in its own zone (Date.UTC of its fields). */
  wallStart: number;
  /** A wall-clock time in the event's zone (as `wallStart`) -> ISO instant, the way `start` was read. */
  instantAt(wall: number): string;
  /** Whether a wall-clock occurrence is past the rule's UNTIL. */
  pastUntil(wall: number): boolean;
};

/** Wall-clock ms back to an iCalendar value: a day, a UTC time ("Z", like the start it came from) or a local one. */
const wallValue = (wall: number, dateOnly: boolean, utc: boolean) => {
  const iso = new Date(wall).toISOString().replace(/[-:]/g, "");
  return dateOnly ? iso.slice(0, 8) : `${iso.slice(0, 15)}${utc ? "Z" : ""}`;
};

/** Every event in a file (a series, its changed occurrences, or single events), with the file's METHOD. */
export function parseEvents(text: string, me?: string): { method: Invite["method"]; events: IcsEvent[] } | null {
  const parsed = calendarOf(text);
  if (!parsed) return null;
  const events: IcsEvent[] = [];
  for (const block of parsed.calendar.children.filter((b) => b.type === "VEVENT")) {
    const invite = inviteOf(block, parsed, me);
    const dtstart = get(block, "DTSTART")!;
    const wall = invite && wallOf(dtstart.value);
    if (!invite || !wall) continue;
    const dateOnly = invite.allDay;
    const at = (w: number) => instant({ ...dtstart, value: wallValue(w, dateOnly, wall.utc) }, parsed.zones)?.iso ?? new Date(w).toISOString();
    const exdates = all(block, "EXDATE").flatMap((p) =>
      p.value.split(",").flatMap((v) => instant({ ...p, value: v.trim() }, parsed.zones)?.iso ?? []),
    );
    const rule = get(block, "RRULE")?.value.trim();
    const untilValue = rule ? /(?:^|;)UNTIL=([^;]+)/i.exec(rule)?.[1] : undefined;
    // UNTIL in UTC (Z), as a day, or (floating) in the start's own zone.
    const until = untilValue ? instant({ name: "UNTIL", params: /Z$/i.test(untilValue) ? {} : dtstart.params, value: untilValue }, parsed.zones) : null;
    const untilDay = until?.dateOnly ? until.iso.slice(0, 10) : null;
    events.push({
      ...invite,
      rule,
      exdates,
      wallStart: wallMs(wall),
      instantAt: at,
      pastUntil: (w) => (!until ? false : untilDay ? new Date(w).toISOString().slice(0, 10) > untilDay : at(w) > until.iso),
    });
  }
  return { method: parsed.method, events };
}

/** A wall-clock time ("2026-10-20T15:00:00") in an IANA zone -> ISO instant. */
export function zonedInstant(wall: string, zone: string) {
  return instant({ name: "DTSTART", params: { TZID: zone }, value: wall.replace(/[-:]/g, "") }, new Map())?.iso ?? null;
}

// ---- Replies ----

const OUT: Record<InviteResponse, string> = { accepted: "ACCEPTED", tentative: "TENTATIVE", declined: "DECLINED" };

/** Lines folded at 75 octets, as RFC 5545 asks. */
function fold(line: string) {
  const byteSize = (text: string) => new TextEncoder().encode(text).length;
  if (byteSize(line) <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const char of line) {
    const n = byteSize(char);
    if (size + n > (out.length ? 74 : 75)) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += char;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

const stamp = (date: Date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** DTSTART / DTEND for an ISO instant (UTC) or, all day, its date. */
const timeLine = (name: string, iso: string, allDay: boolean) => (allDay ? `${name};VALUE=DATE:${iso.slice(0, 10).replace(/-/g, "")}` : `${name}:${stamp(new Date(iso))}`);

/** An iTIP REPLY to `invite` answering for `me`. */
export function buildReply(invite: Invite, me: { name: string; email: string }, response: InviteResponse, note?: string, now = new Date()) {
  const cn = me.name.replace(/["\r\n]/g, "");
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Calendar//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${invite.uid}`,
    `DTSTAMP:${stamp(now)}`,
    `SEQUENCE:${invite.sequence}`,
    invite.recurrenceId ? `RECURRENCE-ID${invite.recurrenceId}` : null,
    // The event's times, as Google and Outlook send them: a reply without them can't be read back (the mail calendar reads your answers in Sent).
    timeLine("DTSTART", invite.start, invite.allDay),
    invite.end ? timeLine("DTEND", invite.end, invite.allDay) : null,
    invite.organizer ? `ORGANIZER;CN="${invite.organizer.name.replace(/["\r\n]/g, "")}":mailto:${invite.organizer.email}` : null,
    `ATTENDEE;CN="${cn}";PARTSTAT=${OUT[response]}:mailto:${me.email}`,
    `SUMMARY:${escape(invite.summary)}`,
    note?.trim() ? `COMMENT:${escape(note.trim())}` : null,
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter((l): l is string => l !== null);
  return lines.map(fold).join("\r\n") + "\r\n";
}
