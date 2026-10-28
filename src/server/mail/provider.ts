import "server-only";

import type { SignInVia, ConnectError } from "@/lib/mail/connect";
import type { CalendarEvent, NewEvent } from "@/lib/calendar/event";
import type { Invite, InviteResponse } from "@/lib/calendar/invite";
import type { Message, Provider } from "@/lib/mail/types";
import type { LabelKind } from "@/lib/mail/providers";
import type { Rule } from "@/lib/rules/spec";
import type { GmailFilterState } from "@/lib/rules/gmail";
import type { AccountRow } from "../db";
import type { RenderedMessage } from "../outgoing";
import type {
  AttachmentFile,
  DraftContent,
  LabelChange,
  OutgoingMessage,
  RemoteLabel,
  SavedDraft,
  Sent,
  ThreadList,
  ThreadRecord,
} from "./types";

// The contract every mail provider implements (server/providers/<name>/index.ts). Kite's sync
// engine, store, rules, drafts and routes only talk to this; nothing outside a provider's folder
// imports from it (enforced in eslint.config.mjs). Providers differ, so what isn't universal is
// optional and declared rather than faked: a provider without labels leaves `labels` out, Gmail's
// own filters are `filters`, and so on. How the UI words things comes from lib/mail/providers.ts.

/** Tokens straight from the provider's token endpoint. */
export type TokenSet = { access_token: string; refresh_token?: string; expires_in: number; scope?: string };

/** Who signed in. `tokens` for OAuth; a password sign-in stores its own secret (`save`). */
export type SignedIn = { email: string; name: string; tokens?: TokenSet };

/** What the user typed into a password sign-in (IMAP/SMTP with an app password). */
export type PasswordSignIn = {
  email: string;
  password: string;
  /** The name people see on mail you send (IMAP servers don't know it). */
  name?: string;
  /** Server settings, when Kite couldn't work them out from the address. */
  servers?: MailServers;
};

/** Where an account's mail lives when it isn't behind a web API. */
export type MailServers = {
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** The login name, when it isn't the address. */
  username?: string;
};

/** Sign-in through the provider's own page (OAuth): Gmail, Microsoft. */
export type OAuthAuth = {
  kind: "oauth";
  /** URL segment of the sign-in routes: /api/auth/<slug>(/callback). */
  slug: SignInVia;
  /** Kite's app registration is in the environment. */
  configured(): boolean;
  /**
   * Where to send the browser, carrying `state` (the route checks it on the way back). `secrets`
   * (a PKCE verifier and the like) are kept in short-lived httpOnly cookies and handed to `finish`.
   */
  begin(input: { origin: string; state: string; hint?: string }): Promise<{ url: URL; secrets?: Record<string, string> }>;
  /** Turns the callback's code into tokens and a profile. Throws SignInError for what the user should see. */
  finish(input: { code: string; origin: string; secrets: Record<string, string> }): Promise<SignedIn>;
  /** The provider sent the user back with an error (cancelled, needs admin approval...). */
  errorReason(error: string, description: string): ConnectError;
  /** A valid access token, refreshed when close to expiry (throws ReconnectRequired). */
  accessToken(accountId: string): Promise<string>;
  /** Tells the provider to drop Kite's access. Best effort: local data is removed either way. */
  revoke(accountId: string): Promise<void>;
  /** After a (re)connect, e.g. Gmail filters waiting for permission. */
  connected?(account: AccountRow): Promise<void>;
};

/** `preset`: the known service's id ("gmail" gets the app-password walkthrough). */
type PasswordHint = { service: string | null; passwordName: string; helpUrl: string | null; preset: string | null };

/** Sign-in with an address and an app password, checked against the servers before anything is kept (IMAP/SMTP). */
export type PasswordAuth = {
  kind: "password";
  /** URL segment of the sign-in route: POST /api/auth/<slug>. */
  slug: SignInVia;
  /**
   * Signs in to the servers with what the user typed (finding the servers from the address when
   * `servers` is missing). Throws SignInError with a plain explanation. `save` keeps the secret,
   * sealed, once the account row exists.
   */
  signIn(input: PasswordSignIn): Promise<SignedIn & { save(accountId: string): void }>;
  /** What the sign-in form says for this address: the service (when Kite knows it), what its password for apps is called, where to make one. */
  hint(email: string): Promise<PasswordHint>;
  /** Forgets the stored password and server settings. */
  revoke(accountId: string): Promise<void>;
  connected?(account: AccountRow): Promise<void>;
};

type AuthAdapter = OAuthAuth | PasswordAuth;

/** Reading and changing mail. Ids are the provider's (REMOTE_ID). */
export type MailAdapter = {
  /** Requests at once per mailbox the provider is comfortable with; the engine never goes above it. */
  concurrency: number;
  /** Drops the provider's own local index of the account ("Reset local copy"), for those that keep one (IMAP). */
  resetLocal?(accountId: string): void;
  /** The change feed's position right now (Gmail history id, Graph delta links). Opaque to the engine. */
  startCursor(account: AccountRow): Promise<string>;
  /** Threads changed since `cursor`, and the new position. Throws CursorExpired when it's too old. */
  changes(account: AccountRow, cursor: string): Promise<{ changed: string[]; cursor: string }>;
  /** Thread ids for a list, newest first, up to `max`; `onPage` sees each page as it arrives. */
  listThreads(account: AccountRow, list: ThreadList, max: number, onPage?: (ids: string[]) => void): Promise<string[]>;
  /** Message ids for a list, up to `max`. */
  listMessages(account: AccountRow, list: ThreadList, max: number): Promise<string[]>;
  /** One thread, with bodies when `full`. Null when it no longer exists. */
  fetchThread(account: AccountRow, remoteId: string, full: boolean): Promise<ThreadRecord | null>;
  /** One message (headers only unless `full`). */
  fetchMessage(account: AccountRow, messageId: string, full: boolean): Promise<Message>;
  /** One attachment's bytes, by part id. Null when it's gone. */
  attachment(account: AccountRow, messageId: string, partId: string, name?: string): Promise<AttachmentFile | null>;
  modifyThreads(account: AccountRow, threadIds: string[], change: LabelChange): Promise<void>;
  modifyMessages(account: AccountRow, messageIds: string[], change: LabelChange): Promise<void>;
  /** Whether this account permits targeted permanent deletion. Never emulate with an unscoped expunge. */
  canDeletePermanently?(account: AccountRow): Promise<boolean>;
  /** Deletes only the given messages, rechecking that each is still in Trash. */
  deletePermanently?(account: AccountRow, messageIds: string[]): Promise<void>;
  send(account: AccountRow, message: OutgoingMessage, rendered: RenderedMessage): Promise<Sent>;
  /** Creates a draft, or replaces `draftId`. Throws ProviderError 400/404 when that draft is gone. */
  saveDraft(account: AccountRow, message: OutgoingMessage, rendered: RenderedMessage, draftId?: string): Promise<SavedDraft>;
  /** Deletes a draft; one already gone counts as done. */
  deleteDraft(account: AccountRow, draftId: string): Promise<void>;
  getDraft(account: AccountRow, draftId: string): Promise<DraftContent>;
  listDrafts(account: AccountRow): Promise<SavedDraft[]>;
  /**
   * Push: calls `onChange` when the mailbox changes, until the returned function stops it (IMAP
   * IDLE). Optional: without it the engine polls the change feed. The engine keeps one per account.
   */
  watch?(account: AccountRow, onChange: () => void): () => void;
  /**
   * Whether the feed has moved past `cursor`, from one cheap request (IMAP: STATUS of the folder new mail
   * lands in). Optional: with it the engine asks every few seconds, even with Kite hidden, and reads the
   * feed only when it says yes, so new mail doesn't wait on a slow push (Gmail's IDLE can lag 10 to 30 s).
   */
  peek?(account: AccountRow, cursor: string): Promise<boolean>;
};

/** Rules kept as filters on the provider's side ("Also run in Gmail"). */
export type ServerFilters = {
  /** How each rule's filters stand, per account. */
  states(): Map<string, GmailFilterState[]>;
  /** The rule has a working filter in this account. */
  live(ruleId: string, accountId: string): boolean;
  /** Brings the filters in line with the rules (queued). */
  sync(rules: () => Rule[], only?: { ruleId?: string; accountId?: string }): Promise<void>;
  /** Disconnect and "Erase everything": removes the filters Kite made in this account. */
  removeAccount(accountId: string): Promise<void>;
};

/** Photos of the people you write to, from the provider's contacts (opt-in). */
export type ContactPhotos = {
  /** Whether this account can have them at all (absent: every account of the provider). Use `contactPhotosFor` in the registry. */
  offered?(accountId: string): boolean;
  /** This account's sign-in allows looking them up. */
  enabled(accountId: string): boolean;
  /** Some account can look them up. */
  available(): boolean;
  url(email: string): Promise<string | null>;
};

/**
 * The account's own calendar, for answering invites there (so your calendar and the organiser's
 * both update). Optional: without it Kite answers by email (an iTIP reply, server/calendar.ts).
 */
export type CalendarAdapter = {
  /**
   * Whether this account has the calendar at all (absent: every account of the provider). Gmail over
   * IMAP has it only once the optional Google sign-in is connected. Use `calendarFor` in the registry.
   */
  offered?(accountId: string): boolean;
  /** One plain line when the sign-in lacks calendar permission (the card offers Connect), else null. */
  missing(accountId: string): string | null;
  /** The invite a message carries when the provider keeps it as an event, not a calendar part (Outlook). */
  invite?(account: AccountRow, message: Message): Promise<Invite | null>;
  /**
   * Answers in the calendar. "not_found" when the event isn't there (Kite then answers by email
   * when `email` allows); throws ProviderError for the rest.
   */
  respond(account: AccountRow, input: { message: Message; invite: Invite; response: InviteResponse; note?: string }): Promise<"done" | "not_found">;
  /** Whether an answer can go by email when the calendar can't take it (an iTIP reply built by buildMime). */
  email: boolean;
  /**
   * Events in a window (Today), for the local `events` table (server/events.ts). `cursor` is what the
   * last read returned for the same window (null: read it all). `full` means the result replaces every
   * stored event of the account; otherwise `events` are changed ones and `removed` provider ids are gone.
   */
  events(account: AccountRow, input: { cursor: string | null; from: string; to: string }): Promise<EventChanges>;
  /** Events in any window, read once for the Calendar view's weeks outside the synced one (never stored). */
  range(account: AccountRow, input: { from: string; to: string }): Promise<CalendarEvent[]>;
  /** Adds an event the user filled in ("Add to calendar") and returns it as stored. */
  create(account: AccountRow, event: NewEvent): Promise<CalendarEvent>;
};

export type EventChanges = { full: boolean; events: CalendarEvent[]; removed: string[]; cursor: string | null };

export type MailProvider = {
  id: Provider;
  auth: AuthAdapter;
  /** Null while Kite can sign in to this provider but doesn't read its mail yet. */
  mail: MailAdapter | null;
  /** The user's own labels/folders. */
  labels?: {
    list(account: AccountRow): Promise<RemoteLabel[]>;
    /** One plain line when the sign-in lacks an optional permission the labels need (shown with Reconnect), else null. */
    reconnectFor?(accountId: string): string | null;
    /**
     * Making, renaming and deleting the user's own (server/labels.ts calls these, then updates the
     * local copy; which kinds each takes is declared in `ProviderSpec.manage`). A provider keeps its
     * own local index right (`resetLocal`'s tables) and says through LabelError what it won't do.
     * `rename` returns the label as it is now (its id may change: IMAP paths). `remove` returns
     * where a folder's mail went, as a Kite label (Outlook: TRASH), or null when it's just gone.
     */
    create?(account: AccountRow, label: { name: string; kind: LabelKind }): Promise<RemoteLabel>;
    rename?(account: AccountRow, label: RemoteLabel, name: string): Promise<RemoteLabel>;
    remove?(account: AccountRow, label: RemoteLabel): Promise<string | null>;
  };
  /**
   * The account's own profile photo, as image bytes (null when it has none). Kite checks the type,
   * caches it with the other avatars and asks again when the cached copy is two weeks old.
   */
  picture?(account: AccountRow): Promise<Buffer | null>;
  filters?: ServerFilters;
  contactPhotos?: ContactPhotos;
  calendar?: CalendarAdapter;
  /** The service behind one account when the provider's name says too little (IMAP: "iCloud Mail", or the server's name). */
  serviceName?(accountId: string): string | null;
  /** The provider whose words for labels one account follows when not its own (Gmail over IMAP: "gmail"); see `accountSpec`. */
  organisesLike?(accountId: string): Provider | null;
};
