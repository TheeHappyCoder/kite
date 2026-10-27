import { DRAFT, INBOX, SENT, SPAM, SYSTEM_LABELS, TRASH } from "./mailboxes";
import type { SignInVia } from "./connect";
import type { Provider } from "./types";

// How each mail provider organises mail, declared once. The UI and the server read the spec
// for an account's provider instead of assuming Gmail: what the user's own groupings are
// called, how nesting is written, and which provider names are built-in mailboxes.
//
// The kind of a grouping lives on each label (MailLabel.kind), not on the provider:
// - "tag": many per message, applying one keeps the message where it is (Gmail labels, Outlook
//   categories, IMAP keywords later).
// - "folder": one per message, choosing one moves it (Outlook and IMAP folders). Inbox, Trash and
//   Spam are places too, so a message filed in a folder leaves them; one in no place is archived.
// One list, one picker, one chip, one `label:` search and one rule verb serve both kinds.

export type LabelKind = "tag" | "folder";

type LabelNoun = {
  /** What the UI calls one and many ("label", "category", "folder"). */
  noun: string;
  plural: string;
  /** Names nest with this separator ("Work/Clients"), or null when they don't nest. */
  separator: string | null;
};

type OrganiseModel = {
  /** The provider's tags and folders, or null when it has none of that kind. */
  tag: LabelNoun | null;
  folder: LabelNoun | null;
  /** One word for both, for the picker, menus and the sidebar ("labels", "folders and categories"). */
  noun: string;
  plural: string;
  /** The search operator for it, in Kite's syntax (`label:`). */
  searchOperator: string;
};

/** Which kinds of the user's own labels Kite can make, rename and delete for a provider. */
export type LabelManagement = { create: LabelKind[]; rename: LabelKind[]; remove: LabelKind[] };

export type ProviderSpec = {
  id: Provider;
  name: string;
  /** Its sign-in route (/api/auth/<slug>): a redirect for OAuth, a password form for IMAP. */
  signIn: SignInVia | null;
  organise: OrganiseModel;
  /** Provider ids that are built-in mailboxes or flags, never shown as the user's labels/folders. */
  system: ReadonlySet<string>;
  /** Kite reads and changes labels/folders for this provider today. */
  labelsSupported: boolean;
  /** Making, renaming and deleting them in Kite (server/labels.ts; the provider's `labels` adapter does it). */
  manage: LabelManagement;
  /** The account's own calendar, where invite answers go ("Google Calendar"); null when answers go by email. */
  calendar: string | null;
};

const GMAIL_SYSTEM = [
  "INBOX", "SENT", "DRAFT", "SPAM", "TRASH", "UNREAD", "STARRED", "IMPORTANT", "CHAT",
  "CATEGORY_PERSONAL", "CATEGORY_SOCIAL", "CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_FORUMS",
  // Superstars: Gmail's coloured star variants.
  "YELLOW_STAR", "ORANGE_STAR", "RED_STAR", "PURPLE_STAR", "BLUE_STAR", "GREEN_STAR",
  "RED_BANG", "ORANGE_GUILLEMET", "YELLOW_BANG", "GREEN_CHECK", "BLUE_INFO", "PURPLE_QUESTION",
];

const PROVIDERS: Record<Provider, ProviderSpec> = {
  gmail: {
    id: "gmail",
    name: "Gmail",
    signIn: "google",
    organise: { tag: { noun: "label", plural: "labels", separator: "/" }, folder: null, noun: "label", plural: "labels", searchOperator: "label:" },
    system: new Set(GMAIL_SYSTEM),
    labelsSupported: true,
    manage: { create: ["tag"], rename: ["tag"], remove: ["tag"] },
    calendar: "Google Calendar",
  },
  outlook: {
    id: "outlook",
    name: "Outlook",
    signIn: "microsoft",
    // Categories are tags keyed by name (they don't nest); folders nest under their parent.
    organise: {
      tag: { noun: "category", plural: "categories", separator: null },
      folder: { noun: "folder", plural: "folders", separator: "/" },
      noun: "folder or category",
      plural: "folders and categories",
      searchOperator: "label:",
    },
    // The adapter turns built-in folders into Kite's mailbox names; user folders keep their Graph ids.
    system: SYSTEM_LABELS,
    labelsSupported: true,
    // Graph can't rename a category, so a renamed one would be a new category on every message.
    manage: { create: ["folder", "tag"], rename: ["folder"], remove: ["folder", "tag"] },
    calendar: "your Outlook calendar",
  },
  imap: {
    id: "imap",
    name: "IMAP",
    signIn: "imap",
    // Folders nest (the adapter writes every server's delimiter as "/"); keywords are tags that don't.
    organise: {
      tag: { noun: "tag", plural: "tags", separator: null },
      folder: { noun: "folder", plural: "folders", separator: "/" },
      noun: "folder or tag",
      plural: "folders and tags",
      searchOperator: "label:",
    },
    // The adapter turns built-in folders into Kite's mailbox names; user folders and keywords get ids.
    system: SYSTEM_LABELS,
    labelsSupported: true,
    // A keyword exists only on mail that carries it, so there's nothing to make before it's used.
    manage: { create: ["folder"], rename: ["folder", "tag"], remove: ["folder", "tag"] },
    calendar: null,
  },
};

export function providerSpec(provider: Provider | string | undefined): ProviderSpec {
  return PROVIDERS[(provider as Provider) ?? "gmail"] ?? PROVIDERS.gmail;
}

type SpecAccount = { provider: Provider; organisesLike?: Provider | null };

// One spec per pairing, so memoised panes get the same object every render.
const borrowed = new Map<string, ProviderSpec>();

/**
 * The spec for one account: its provider's, with the words and nesting of the service it
 * organises like when that differs (Gmail over IMAP has labels, not folders and tags).
 */
export function accountSpec(account: SpecAccount | undefined): ProviderSpec {
  const own = providerSpec(account?.provider);
  const like = account?.organisesLike;
  if (!like || like === own.id) return own;
  const key = `${own.id}:${like}`;
  if (!borrowed.has(key)) borrowed.set(key, { ...own, organise: providerSpec(like).organise, manage: providerSpec(like).manage });
  return borrowed.get(key)!;
}

/** What an account's mail service is called: the service behind an IMAP account ("iCloud Mail"), else the provider's name. */
export function serviceName(account: { provider: Provider; service?: string | null } | undefined) {
  return account?.service || providerSpec(account?.provider).name;
}

function sentence(names: string[]) {
  const unique = [...new Set(names)];
  return unique.length > 1 ? `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}` : (unique[0] ?? "your mail provider");
}

/** The accounts' services for a sentence: "Gmail", "Gmail and iCloud Mail". */
export function serviceNames(accounts: { provider: Provider; service?: string | null }[]) {
  return sentence(accounts.map(serviceName));
}

/** Whether Kite can do `what` to a label of this kind for this account's provider. */
export function canManage(spec: ProviderSpec, what: keyof LabelManagement, kind: LabelKind) {
  return spec.labelsSupported && spec.manage[what].includes(kind);
}

/**
 * A new or renamed label's name as the provider will store it (trimmed, nesting separators
 * without spaces or empty parts), or a plain reason it can't be one.
 */
export function cleanLabelName(name: string, spec: ProviderSpec, kind: LabelKind): { name: string } | { error: string } {
  const words = spec.organise[kind] ?? { noun: spec.organise.noun, separator: null };
  const separator = words.separator;
  const parts = separator ? name.split(separator).map((p) => p.trim()) : [name.trim()];
  const clean = parts.join(separator ?? "");
  if (!clean) return { error: `Give the ${words.noun} a name.` };
  if (parts.some((p) => !p)) return { error: `A ${words.noun} name can't start or end with “${separator}”, or have two in a row.` };
  if (clean.length > 200) return { error: `That name is too long for a ${words.noun}.` };
  if (spec.system.has(clean.toUpperCase()) || /^(inbox|sent|drafts?|trash|spam|junk|archive|all mail|starred|important)$/i.test(clean)) {
    return { error: `“${clean}” is one of the mailboxes already. Pick another name.` };
  }
  return { name: clean };
}

/** A user label/folder as Kite stores it (provider-neutral). */
export type MailLabel = {
  accountId: string;
  /** The provider's id (Gmail "Label_26", a Graph folder id, an Outlook category's name, an IMAP path). */
  id: string;
  /** Full name, nested with the kind's separator ("Work/Clients"). */
  name: string;
  /** A tag stays with the message; a folder is where the message is. */
  kind: LabelKind;
  /** Background colour the provider stores, if any. */
  color: string | null;
  /** Conversations in the local copy carrying it, and how many of those are unread. */
  total: number;
  unread: number;
};

/** The words and nesting for one kind of label on this provider. */
function nounFor(spec: ProviderSpec, kind: LabelKind): LabelNoun {
  return spec.organise[kind] ?? { noun: spec.organise.noun, plural: spec.organise.plural, separator: null };
}

const separatorOf = (spec: ProviderSpec, label: Pick<MailLabel, "kind">) => nounFor(spec, label.kind).separator;

/** The last part of a nested name ("Clients" in "Work/Clients"). */
export function leafName(label: Pick<MailLabel, "name" | "kind">, spec: ProviderSpec) {
  const separator = separatorOf(spec, label);
  return separator ? (label.name.split(separator).pop() ?? label.name) : label.name;
}

/** How deep a nested name sits (0 at the top). */
export function labelDepth(label: Pick<MailLabel, "name" | "kind">, spec: ProviderSpec) {
  const separator = separatorOf(spec, label);
  return separator ? label.name.split(separator).length - 1 : 0;
}

/** Folders first, then tags; within each, children follow their parent (case-insensitive by full path). */
export function sortLabels<T extends Pick<MailLabel, "name" | "kind">>(labels: T[], spec: ProviderSpec) {
  const key = (l: T) => {
    const separator = separatorOf(spec, l);
    const path = separator ? l.name.split(separator).map((p) => p.toLowerCase()).join("\u0000") : l.name.toLowerCase();
    return `${l.kind === "folder" ? 0 : 1}${path}`;
  };
  return [...labels].sort((a, b) => key(a).localeCompare(key(b)));
}

/** Places a message can be in besides a folder. Filing it in a folder takes it out of these. */
const PLACES: ReadonlySet<string> = new Set([INBOX, TRASH, SPAM]);

/**
 * A message's labels after a change: tags are added and removed as they are; adding a folder
 * moves the message there (out of Inbox, Trash, Spam and any other folder); taking it out of its
 * folder leaves it archived. Your own sent mail and drafts aren't filed with the rest.
 */
export function applyLabelChange(labels: Iterable<string>, change: { add: string[]; remove: string[] }, isFolder: (id: string) => boolean) {
  const next = new Set(labels);
  const filedApart = next.has(SENT) || next.has(DRAFT);
  change.remove.forEach((l) => next.delete(l));
  for (const l of change.add) {
    if (isFolder(l)) {
      if (filedApart) continue;
      for (const x of [...next]) if (PLACES.has(x) || isFolder(x)) next.delete(x);
    }
    next.add(l);
  }
  return next;
}

type ExtrasAccount = { id: string; email: string; provider: Provider; googleLink?: boolean };

/**
 * Where to ask for an optional permission (calendar, contact photos): the provider's own sign-in
 * again, or for Gmail over IMAP its separate Google sign-in (/api/google-link).
 */
export function permissionHref(account: ExtrasAccount) {
  if (account.googleLink !== undefined) return `/api/google-link?account=${encodeURIComponent(account.id)}`;
  return `/api/auth/${providerSpec(account.provider).signIn}?hint=${encodeURIComponent(account.email)}`;
}

/** The account's calendar as the UI names it ("Google Calendar"), or null when it has none. */
export function calendarName(account: ExtrasAccount | undefined) {
  if (account?.googleLink !== undefined) return PROVIDERS.gmail.calendar;
  return providerSpec(account?.provider).calendar;
}
