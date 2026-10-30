import * as z from "zod";
import { DrivePrefs } from "./drive";
import { AI_TASKS, AiModelChoices, type AiTask } from "./ai-tasks";
import { Design } from "./design/spec";
import { SwipePrefs } from "./swipe";
import { ButtonPrefs, DEFAULT_BUTTONS } from "./buttons";

// User preferences, stored as one validated JSON record in the local `settings` table.
// Kept as plain typed data so the UI, the sync engine and (later) an AI can all read and change it.

/** Where Kite opens (Settings → Appearance). */
export const START_VIEWS = ["last", "home", "inbox"] as const;
export type StartView = (typeof START_VIEWS)[number];

export const NotificationPrefs = z.object({
  /** Desktop (Windows) notifications while Kite is in the background. */
  desktop: z.boolean().default(true),
  /** Sign-in codes and links: the in-app popup, plus the desktop app's toast with Copy / Open. */
  codes: z.boolean().default(true),
  /** "Scheduled message sent". */
  scheduled: z.boolean().default(true),
  /** Meetings in the user's calendar about to start, in the desktop app's Kite bar (with Join). */
  meetings: z.boolean().default(true),
  /** Holds everything that notifies "with the next batch" (rules, scheduled sends) until the next batch time. */
  batch: z.boolean().default(false),
  /**
   * Show who wrote and what it's about (and the code itself) in notifications. Off: they say only
   * "New mail" or "Sign-in code ready", so nothing shows on the lock screen or a shared screen.
   */
  showContent: z.boolean().default(false),
  /** Local times ("HH:MM") a batch is delivered. */
  batchTimes: z
    .array(z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/))
    .max(6)
    .default(["09:00", "13:00", "17:00"]),
});
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/**
 * An object schema's fields, all optional and without defaults. zod's `.partial()` keeps the
 * defaults, so a patch of one field would reset the others.
 */
function patchOf<S extends Record<string, z.ZodDefault<z.ZodType>>>(schema: z.ZodObject<S>) {
  const shape = Object.fromEntries(Object.entries(schema.shape).map(([key, field]) => [key, field.unwrap().optional()]));
  return z.object(shape) as unknown as z.ZodType<Partial<z.infer<z.ZodObject<S>>>>;
}

/** Signatures are design documents, one per account id. */
const Signatures = z.record(z.string(), Design);

/** Reusable text typed with ";trigger" in the compose body. The body is markup (see mail/body.ts). */
export const Snippet = z.object({
  id: z.string().min(1).max(64),
  trigger: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,23}$/i, "Use letters, numbers, - or _ (up to 24)"),
  body: z.string().min(1, "Write the text this snippet adds").max(20_000),
});
export type Snippet = z.infer<typeof Snippet>;

const Snippets = z.array(Snippet).max(200);

/** A search kept in the sidebar. The query uses Gmail's syntax (see mail/search.ts). */
export const SavedSearch = z.object({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(60),
  query: z.string().trim().min(1).max(500),
});
export type SavedSearch = z.infer<typeof SavedSearch>;

const SavedSearches = z.array(SavedSearch).max(50);

/** A global shortcut in Tauri's accelerator syntax ("CommandOrControl+Alt+C"), or "" for none. */
const Accelerator = z.string().max(60).regex(/^$|^(?:[A-Za-z]+\+)+[A-Za-z0-9]+$/, "Use a shortcut like CommandOrControl+Alt+C");

/** Settings only the desktop app (src-tauri) uses. */
const DesktopPrefs = z.object({
  /** A fresh code shows as a Windows notification with Copy code / Open link (also needs `notifications.desktop`). */
  codeToast: z.boolean().default(true),
  /** A fresh code shows as a floating Kite card over every app (shows even during Do Not Disturb). */
  codeCard: z.boolean().default(true),
  /** Mail a rule said to notify about now shows in the Kite bar, with Reply / Archive / Open (instead of a Windows notification). */
  mailBar: z.boolean().default(true),
  /** Copies the newest fresh sign-in code from anywhere. Off ("") until the user turns it on. */
  codeShortcut: Accelerator.default(""),
});

/** The Kite bar (desktop app): who may show things in it, and how loudly (docs/bar.md). */
const BarPrefs = z.object({
  /** Other apps and scripts with a token may show activities (POST /api/bar/activities). */
  integrations: z.boolean().default(true),
  /** Quiet: everything arrives resting (one line) instead of dropping open. */
  quiet: z.boolean().default(false),
});

/** What turning the code shortcut on sets. */
export const DEFAULT_CODE_SHORTCUT = "CommandOrControl+Alt+C";

/** Fill & sign: the signature drawn or uploaded once, as a private image in data/assets. */
const PdfSignPrefs = z.object({
  signature: z.string().regex(/^[0-9a-f]{24}$/).nullable().default(null),
});

/** Seconds a sent message is held so it can be undone (0 = off). */
export const UNDO_SEND_CHOICES = [0, 5, 10, 20] as const;

/** Days without an answer before a conversation shows in Today's "Waiting on" (lib/replies.ts). */
export const WAIT_DAY_CHOICES = [2, 3, 5, 7] as const;

const ComposePrefs = z.object({
  /** Undo send: Send holds the message this many seconds. Scheduled sends aren't held. */
  undoSend: z.union(UNDO_SEND_CHOICES.map((n) => z.literal(n))).default(10),
  waitDays: z.union(WAIT_DAY_CHOICES.map((n) => z.literal(n))).default(3),
});

/** Minutes idle (or away) before Kite locks, when a PIN is set. */
export const LOCK_CHOICES = [1, 5, 15, 60] as const;

/** Remote images: ask (load per message or per sender), always load, or never load. */
export const IMAGE_CHOICES = ["ask", "always", "never"] as const;

const PrivacyPrefs = z.object({
  images: z.enum(IMAGE_CHOICES).default("ask"),
  /** Remove tracking parameters (and known redirect wrappers) from links in the reader. */
  cleanLinks: z.boolean().default(true),
  /** Company logos from the web (BIMI, Gravatar, DuckDuckGo icons), for company senders only. */
  webPictures: z.boolean().default(true),
  /** When this computer's own DNS fails, ask Cloudflare's DNS-over-HTTPS instead (server/dns.ts): domain names only. */
  dnsFallback: z.boolean().default(true),
  /** The desktop app looks for a new version on GitHub now and again (src-tauri/src/updater.rs); Check for updates still works when off. */
  updateChecks: z.boolean().default(true),
  /** With a PIN set (server/lock.ts): lock after this many idle minutes, or when Kite comes back after that long. */
  lockAfter: z.union(LOCK_CHOICES.map((n) => z.literal(n))).default(15),
});

/**
 * A rule's "Draft with AI" (server/ai-drafts.ts), the only AI Kite runs without a click: `on` is
 * the one switch that pauses all of it. What it spends counts against `aiLimits`.
 */
/** Translation on this computer (server/translate.ts): into which language, and whether the reader offers it. */
export const TranslatePrefs = z.object({
  /** A model code ("en", "af"); empty = the user's own language from the browser. */
  to: z
    .string()
    .regex(/^([a-z]{2,3})?$/)
    .default(""),
  /** A line under a message in another language offering to translate it. */
  offer: z.boolean().default(true),
});
export type TranslatePrefs = z.infer<typeof TranslatePrefs>;

export const AiDraftPrefs = z.object({
  on: z.boolean().default(true),
});
export type AiDraftPrefs = z.infer<typeof AiDraftPrefs>;

/**
 * Hard limits on all AI use, clicks and rule drafts alike (server/ai-usage.ts): Kite refuses a call
 * before it's sent when it could cross one. Dollars only with a price in AI settings. null = no limit.
 */
export const AiLimits = z.object({
  unit: z.enum(["dollars", "tokens"]).default("tokens"),
  daily: z.number().positive().nullable().default(null),
  monthly: z.number().positive().nullable().default(null),
});
export type AiLimits = z.infer<typeof AiLimits>;

export const Preferences = z.object({
  /** Sender photos from the user's Google contacts (People API). Off until the user opts in. */
  senderPhotos: z.boolean().default(false),
  /** Answer invites in the account's own calendar (Google Calendar, Outlook): asks for calendar permission at the next sign-in. */
  calendar: z.boolean().default(false),
  /** Open conversations as chat bubbles by default (each thread can still switch). */
  chatView: z.boolean().default(false),
  /** Where Kite opens: the screen you were on last (kept on this computer), or always Home or the Inbox. */
  startView: z.enum(START_VIEWS).default("last"),
  /** What swiping a message-list row does, per direction (touch screens). */
  swipe: SwipePrefs.default(SwipePrefs.parse({})),
  /** Which actions sit on the reader's toolbar and the list's hover row (lib/buttons.ts); the rest are in More. */
  buttons: ButtonPrefs.default(DEFAULT_BUTTONS),
  notifications: NotificationPrefs.default(NotificationPrefs.parse({})),
  /** Signature per account id. */
  signatures: Signatures.default({}),
  snippets: Snippets.default([]),
  savedSearches: SavedSearches.default([]),
  desktop: DesktopPrefs.default(DesktopPrefs.parse({})),
  bar: BarPrefs.default(BarPrefs.parse({})),
  pdfSign: PdfSignPrefs.default(PdfSignPrefs.parse({})),
  compose: ComposePrefs.default(ComposePrefs.parse({})),
  privacy: PrivacyPrefs.default(PrivacyPrefs.parse({})),
  translate: TranslatePrefs.default(TranslatePrefs.parse({})),
  aiDrafts: AiDraftPrefs.default(AiDraftPrefs.parse({})),
  aiLimits: AiLimits.default(AiLimits.parse({})),
  /** Which connected model runs each AI task (lib/ai-tasks.ts); a task not here uses the default model. */
  aiModels: AiModelChoices.default({}),
  /** The Kite drive in Explorer (lib/drive.ts; desktop app only). */
  drive: DrivePrefs.default(DrivePrefs.parse({})),
});

export type Preferences = z.infer<typeof Preferences>;
/** The on/off notification kinds. */
export type NotificationKind = "desktop" | "codes" | "scheduled" | "meetings";

export const DEFAULT_PREFERENCES: Preferences = Preferences.parse({});

/** A partial update: top-level keys replace, `swipe`, `notifications`, `desktop`, `bar`, `pdfSign`, `compose`, `privacy` and `signatures` merge. A null signature removes it. */
export const PreferencesPatch = z.object({
  senderPhotos: z.boolean().optional(),
  calendar: z.boolean().optional(),
  chatView: z.boolean().optional(),
  startView: z.enum(START_VIEWS).optional(),
  swipe: patchOf(SwipePrefs).optional(),
  /** Replaces the whole layout. */
  buttons: ButtonPrefs.optional(),
  notifications: patchOf(NotificationPrefs).optional(),
  signatures: z.record(z.string(), Design.nullable()).optional(),
  /** Replaces the whole list. */
  snippets: Snippets.optional(),
  /** Replaces the whole list. */
  savedSearches: SavedSearches.optional(),
  desktop: patchOf(DesktopPrefs).optional(),
  bar: patchOf(BarPrefs).optional(),
  pdfSign: patchOf(PdfSignPrefs).optional(),
  compose: patchOf(ComposePrefs).optional(),
  privacy: patchOf(PrivacyPrefs).optional(),
  translate: patchOf(TranslatePrefs).optional(),
  aiDrafts: patchOf(AiDraftPrefs).optional(),
  aiLimits: patchOf(AiLimits).optional(),
  /** Merges per task; null puts a task back on the default model. */
  aiModels: z.partialRecord(z.enum(AI_TASKS), z.string().max(120).nullable()).optional(),
  drive: patchOf(DrivePrefs).optional(),
});

export type PreferencesPatch = z.infer<typeof PreferencesPatch>;

export type StorageInfo = {
  /** Bytes for the SQLite database (including its write-ahead log). */
  database: number;
  /** Bytes for cached sender avatars. */
  avatars: number;
  /** Bytes for downloaded attachments. */
  attachments: number;
  threads: number;
  /** Threads with full bodies downloaded (readable offline). */
  offline: number;
  accounts: { id: string; threads: number; syncedAt: string | null; error: string | null }[];
};

/** Applies a patch: `notifications`, `desktop` and `signatures` merge key by key; a null signature removes it. */
export function applyPatch(current: Preferences, patch: PreferencesPatch): Preferences {
  const signatures = { ...current.signatures };
  for (const [id, design] of Object.entries(patch.signatures ?? {})) {
    if (design) signatures[id] = design;
    else delete signatures[id];
  }
  const aiModels: AiModelChoices = { ...current.aiModels };
  for (const [task, model] of Object.entries(patch.aiModels ?? {}) as [AiTask, string | null][]) {
    if (model) aiModels[task] = model;
    else delete aiModels[task];
  }
  return {
    senderPhotos: patch.senderPhotos ?? current.senderPhotos,
    calendar: patch.calendar ?? current.calendar,
    chatView: patch.chatView ?? current.chatView,
    startView: patch.startView ?? current.startView,
    swipe: { ...current.swipe, ...patch.swipe },
    buttons: patch.buttons ?? current.buttons,
    notifications: { ...current.notifications, ...patch.notifications },
    signatures,
    snippets: patch.snippets ?? current.snippets,
    savedSearches: patch.savedSearches ?? current.savedSearches,
    desktop: { ...current.desktop, ...patch.desktop },
    bar: { ...current.bar, ...patch.bar },
    pdfSign: { ...current.pdfSign, ...patch.pdfSign },
    compose: { ...current.compose, ...patch.compose },
    privacy: { ...current.privacy, ...patch.privacy },
    translate: { ...current.translate, ...patch.translate },
    aiDrafts: { ...current.aiDrafts, ...patch.aiDrafts },
    aiLimits: { ...current.aiLimits, ...patch.aiLimits },
    aiModels,
    drive: { ...current.drive, ...patch.drive },
  };
}
