import * as z from "zod";
import { format } from "date-fns";

// The Kite drive (src-tauri/src/drive.rs): every file in your mail as folders in Explorer, built
// from fixed building blocks the user switches on and orders, each split inside by levels the user
// picks (person, year, month, week, file type, account). The server lists the whole tree
// (server/drive.ts); the desktop shell keeps placeholders for it and downloads a file only when it's
// opened. Read-only: nothing done in Explorer changes mail.

export const DRIVE_FOLDERS = ["people", "spaces", "months", "labels", "searches"] as const;
export type DriveFolder = (typeof DRIVE_FOLDERS)[number];

export const DRIVE_FOLDER_INFO: Record<DriveFolder, { name: string; label: string; detail: string }> = {
  people: { name: "People", label: "People", detail: "A folder for each person, with the files you've exchanged" },
  spaces: { name: "Spaces", label: "Spaces", detail: "Your spaces and pockets, with their conversations' files" },
  months: { name: "By date", label: "By date", detail: "Everything, by when it arrived" },
  labels: { name: "Labels", label: "Labels & folders", detail: "Your mail's labels and folders" },
  searches: { name: "", label: "Your searches", detail: "Saved searches you pick, each a folder of its own" },
};

/** What a folder can be split by inside, in the order the user adds them (dates keep year › month › week). */
export const DRIVE_LEVELS = ["person", "year", "month", "week", "type", "account"] as const;
export type DriveLevel = (typeof DRIVE_LEVELS)[number];
export const DRIVE_LEVEL_INFO: Record<DriveLevel, string> = { person: "Person", year: "Year", month: "Month", week: "Week", type: "File type", account: "Account" };
const DATE_LEVELS: DriveLevel[] = ["year", "month", "week"];
/** At most this many levels inside a folder. */
export const MAX_LEVELS = 3;

/** What each building block splits into when the user hasn't chosen (By date's levels are its own folders). */
export const DEFAULT_LEVELS: Record<DriveFolder, DriveLevel[]> = { people: ["month"], spaces: ["month"], months: ["month"], labels: ["month"], searches: [] };

/** "Only split big folders": a folder with this many files or fewer stays one list; 0 = always split. */
export const SPLIT_CHOICES = [0, 20, 30, 50, 100] as const;

const Folder = z.object({
  kind: z.enum(DRIVE_FOLDERS),
  on: z.boolean(),
  /** Inside each folder of this kind, outermost first. Missing: DEFAULT_LEVELS. */
  levels: z.array(z.enum(DRIVE_LEVELS)).max(MAX_LEVELS).optional(),
});
export type DriveFolderPref = z.infer<typeof Folder>;

export const DrivePrefs = z.object({
  /** Off until the user turns it on (Settings → Files, or the one-time offer). */
  on: z.boolean().default(false),
  /** The offer was answered (either way): never asked again. */
  offered: z.boolean().default(false),
  /** Building blocks in the user's order. */
  folders: z
    .array(Folder)
    .max(DRIVE_FOLDERS.length)
    .default([
      { kind: "people", on: true },
      { kind: "spaces", on: true },
      { kind: "months", on: true },
      { kind: "labels", on: false },
      { kind: "searches", on: false },
    ]),
  people: z.enum(["everyone", "vips", "written"]).default("everyone"),
  splitOver: z.union(SPLIT_CHOICES.map((n) => z.literal(n))).default(30),
  /** Saved search ids shown as top-level folders. */
  searches: z.array(z.string().max(64)).max(50).default([]),
});
export type DrivePrefs = z.infer<typeof DrivePrefs>;

/** Every building block once, in the user's order (new kinds at the end, off), with its levels. */
export function driveFolders(prefs: DrivePrefs): (DriveFolderPref & { levels: DriveLevel[] })[] {
  const listed = prefs.folders.filter((f, i) => prefs.folders.findIndex((g) => g.kind === f.kind) === i);
  const all: DriveFolderPref[] = [...listed, ...DRIVE_FOLDERS.filter((k) => !listed.some((f) => f.kind === k)).map((kind) => ({ kind, on: false }))];
  return all.map((f) => ({ ...f, levels: tidyLevels(f.kind, f.levels ?? DEFAULT_LEVELS[f.kind]) }));
}

/** The levels a building block may use (no person inside People). */
export function levelsAllowed(kind: DriveFolder): DriveLevel[] {
  return kind === "people" ? DRIVE_LEVELS.filter((l) => l !== "person") : [...DRIVE_LEVELS];
}

/** Each level once, allowed for the kind, dates in year › month › week order where they sit; By date starts with a date. */
export function tidyLevels(kind: DriveFolder, levels: DriveLevel[]): DriveLevel[] {
  const allowed = levelsAllowed(kind);
  const once = levels.filter((l, i) => allowed.includes(l) && levels.indexOf(l) === i).slice(0, MAX_LEVELS);
  const dates = DATE_LEVELS.filter((l) => once.includes(l));
  let next = 0;
  const tidy = once.map((l) => (DATE_LEVELS.includes(l) ? dates[next++] : l));
  if (kind !== "months" || DATE_LEVELS.includes(tidy[0])) return tidy;
  const dated: DriveLevel[] = ["month", ...tidy.filter((l) => l !== "month")];
  return dated.slice(0, MAX_LEVELS);
}

/** One attachment as the drive sees it. */
export type DriveFile = {
  accountId: string;
  threadId: string;
  messageId: string;
  partId: string;
  name: string;
  /** Best known size; the shell corrects it when the real bytes are shorter or longer. */
  bytes: number;
  date: string;
  /** Who it's with: the sender, or the recipients of mail you sent. */
  people: { name: string; email: string }[];
  sender: string;
  /** Attachment kind, for the File type level. */
  kind: "pdf" | "doc" | "sheet" | "image" | "other";
  /** The account's name, for the Account level. */
  account: string;
};

/**
 * A placeholder in the tree: its folder path, file name and what to download. An empty folder is one
 * entry with no name. `time`: when it arrived (ms since 1970), shown as the file's date.
 */
export type DriveEntry = { dir: string[]; name: string; id: string; bytes: number; time: number };

/** The groups a building block puts files in: each a folder path and the files in it. */
export type DriveGroup = { dir: string[]; files: DriveFile[] };

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A name Windows accepts for a file or folder. */
export function safeName(raw: string, max = 120) {
  let name = raw.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().replace(/[. ]+$/, "");
  if (!name) name = "Untitled";
  if (RESERVED.test(name)) name = `_${name}`;
  if (name.length > max) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, max - ext.length).trim() + ext;
  }
  return name;
}

/** "84 KB" -> bytes, for providers that list a human size only. */
export function bytesOf(size: string | undefined) {
  const m = /^([\d.,]+)\s*(B|KB|MB|GB)$/i.exec(size?.trim() ?? "");
  if (!m) return 0;
  const n = Number(m[1].replace(",", "."));
  return Math.round(n * { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2].toUpperCase() as "B"]);
}

/**
 * Files that run when opened (programs, scripts, installers, shortcuts, disk images): never in the
 * drive, where one double-click would start them. They stay in Kite, where opening one is a download.
 */
const RUNNABLE = /\.(exe|com|scr|pif|msi|msix|msixbundle|appx|appxbundle|msp|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|cpl|jar|lnk|url|reg|iso|img|vhd|vhdx|chm|application|gadget|inf|dll|sys)$/i;
export const runnable = (name: string) => RUNNABLE.test(name.trim().replace(/[. ]+$/, ""));

export const driveFileId =(f: Pick<DriveFile, "accountId" | "messageId" | "partId">) => `${f.accountId}\n${f.messageId}\n${f.partId}`;

const KIND_NAMES: Record<DriveFile["kind"], string> = { pdf: "PDFs", doc: "Documents", sheet: "Spreadsheets", image: "Images", other: "Other files" };

/** A file's folder name at one level; `above` is the levels already in its path (they shorten date names). */
function levelName(level: Exclude<DriveLevel, "person">, f: DriveFile, above: DriveLevel[]): string {
  if (level === "type") return KIND_NAMES[f.kind];
  if (level === "account") return f.account;
  const d = new Date(f.date);
  if (Number.isNaN(d.getTime())) return "Undated";
  if (level === "year") return format(d, "yyyy");
  if (level === "month") return above.includes("year") ? format(d, "MM MMMM") : format(d, "yyyy-MM");
  // Weeks of the month: 1–7, 8–14, 15–21, 22 to the end.
  const week = Math.min(4, Math.floor((d.getDate() - 1) / 7) + 1);
  const first = (week - 1) * 7 + 1;
  const last = week === 4 ? new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() : first + 6;
  const days = `${first}–${last} ${format(d, "MMM")}`;
  if (above.includes("month")) return `Week ${week} (${days})`;
  return `${format(d, above.includes("year") ? "MM" : "yyyy-MM")} Week ${week} (${days})`;
}

/**
 * A folder's files split by its levels, outermost first. A folder with `splitOver` files or fewer
 * stays one list (0: always split); `force` splits the first level whatever its size (By date).
 */
export function splitGroup(dir: string[], files: DriveFile[], levels: DriveLevel[], splitOver: number, force = false, above: DriveLevel[] = []): DriveGroup[] {
  const [level, ...rest] = levels;
  if (!level || !files.length || (!force && splitOver > 0 && files.length <= splitOver)) return [{ dir, files }];
  let parts: { name: string; files: DriveFile[] }[];
  if (level === "person") {
    parts = peopleGroups(files, () => true, "Just you").map((g) => ({ name: g.dir[0], files: g.files }));
  } else {
    const by = new Map<string, DriveFile[]>();
    for (const f of files) {
      const name = levelName(level, f, above);
      by.set(name, [...(by.get(name) ?? []), f]);
    }
    parts = [...by].map(([name, list]) => ({ name, files: list }));
  }
  return parts.flatMap((p) => splitGroup([...dir, p.name], p.files, rest, splitOver, false, [...above, level]));
}

/** Placeholders for groups: names made safe, clashes told apart by sender and date, newest first. */
export function driveEntries(groups: DriveGroup[]): DriveEntry[] {
  const entries: DriveEntry[] = [];
  const dirs = new Map<string, DriveFile[]>();
  for (const g of groups) {
    const dir = g.dir.map((d) => safeName(d, 80));
    const key = dir.join("\u0000");
    const list = dirs.get(key) ?? [];
    dirs.set(key, list.concat(g.files));
  }
  for (const [key, files] of dirs) {
    const dir = key ? key.split("\u0000") : [];
    if (!files.length) {
      entries.push({ dir, name: "", id: "", bytes: 0, time: 0 });
      continue;
    }
    const seen = new Map<string, number>();
    const taken = new Set<string>();
    const sorted = [...files].sort((a, b) => b.date.localeCompare(a.date));
    for (const f of sorted) seen.set(safeName(f.name).toLowerCase(), (seen.get(safeName(f.name).toLowerCase()) ?? 0) + 1);
    const ids = new Set<string>();
    for (const f of sorted) {
      const id = driveFileId(f);
      if (ids.has(id)) continue;
      ids.add(id);
      const base = safeName(f.name);
      let name = base;
      if ((seen.get(base.toLowerCase()) ?? 0) > 1) {
        const dot = base.lastIndexOf(".");
        const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, ""];
        const day = Number.isNaN(new Date(f.date).getTime()) ? "" : `, ${format(new Date(f.date), "d MMM yyyy")}`;
        name = safeName(`${stem} (${f.sender}${day})${ext}`);
      }
      for (let n = 2; taken.has(name.toLowerCase()); n++) {
        const dot = name.lastIndexOf(".");
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
        name = `${stem.replace(/ \d+$/, "")} ${n}${ext}`;
      }
      taken.add(name.toLowerCase());
      entries.push({ dir, name, id, bytes: f.bytes, time: Math.max(0, new Date(f.date).getTime() || 0) });
    }
  }
  return entries;
}

/** People folders: one per person, named by name, the address added only where two names clash; `nobody` collects files with no one else. */
export function peopleGroups(files: DriveFile[], keep: (email: string) => boolean, nobody?: string): DriveGroup[] {
  const byEmail = new Map<string, { name: string; files: DriveFile[] }>();
  const alone: DriveFile[] = [];
  for (const f of [...files].sort((a, b) => b.date.localeCompare(a.date))) {
    if (nobody && !f.people.length) alone.push(f);
    for (const p of f.people) {
      const email = p.email.toLowerCase();
      if (!email || !keep(email)) continue;
      const entry = byEmail.get(email) ?? { name: p.name.trim() || p.email, files: [] };
      entry.files.push(f);
      byEmail.set(email, entry);
    }
  }
  const names = new Map<string, number>();
  for (const { name } of byEmail.values()) names.set(name.toLowerCase(), (names.get(name.toLowerCase()) ?? 0) + 1);
  const groups = [...byEmail].map(([email, { name, files }]) => ({
    dir: [(names.get(name.toLowerCase()) ?? 0) > 1 && name.toLowerCase() !== email ? `${name} (${email})` : name],
    files,
  }));
  return nobody && alone.length ? [...groups, { dir: [nobody], files: alone }] : groups;
}

/** A folder in Settings' preview: its name, how many files are in it and below, its first few folders and files. */
export type DrivePreviewNode = { name: string; total: number; folders: DrivePreviewNode[]; moreFolders: number; files: string[]; moreFiles: number };

/** A small copy of the tree for the preview: the biggest `width` folders per level (dates newest first) and three file names per folder. */
export function previewTree(entries: DriveEntry[], width = 4): DrivePreviewNode[] {
  type Node = { name: string; total: number; children: Map<string, Node>; files: string[] };
  const root: Node = { name: "", total: 0, children: new Map(), files: [] };
  for (const e of entries) {
    let at = root;
    for (const part of e.dir) {
      const next = at.children.get(part) ?? { name: part, total: 0, children: new Map(), files: [] };
      at.children.set(part, next);
      at = next;
      if (e.name) at.total++;
    }
    if (e.name) at.files.push(e.name);
  }
  const out = (n: Node, top: boolean): DrivePreviewNode => {
    const children = [...n.children.values()];
    const dated = children.length > 0 && children.every((c) => /^(\d{2,4}|Week )/.test(c.name));
    // Top-level folders keep the user's order; dates read newest first; anything else biggest first.
    const ordered = top ? children : dated ? children.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })) : children.sort((a, b) => b.total - a.total);
    return { name: n.name, total: n.total, folders: ordered.slice(0, width).map((c) => out(c, false)), moreFolders: Math.max(0, ordered.length - width), files: n.files.slice(0, 3), moreFiles: Math.max(0, n.files.length - 3) };
  };
  return out(root, true).folders.length ? [...root.children.values()].map((c) => out(c, false)) : [];
}
