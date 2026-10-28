import type { Mailbox, Thread } from "./types";
import { sideOf, type InboxSide } from "./sides";
import { inScope, type AccountScope } from "./scope";
import { matchesSearch, parseSearch } from "./search";
import { applyOverride, pinnedFirst, type ThreadOverride } from "./overrides";
import type { SettingsSection } from "@/components/settings/settings-view";
import { within, type Space } from "../spaces";

export type View =
  /** Home: people and everything else (components/home/home-view.tsx), on the inbox. */
  | { kind: "home" }
  | { kind: "mailbox"; mailbox: Mailbox }
  | { kind: "cleanup" }
  | { kind: "files" }
  /** Every private note, on conversations and people (components/notes/notes-view.tsx). */
  | { kind: "notes" }
  /** Everyone your mail knows (components/contacts/contacts-view.tsx). */
  | { kind: "contacts" }
  /** Automations and their collections (components/automations/automations-view.tsx). */
  | { kind: "automations" }
  | { kind: "calendar" }
  /** One of the user's labels/folders (belongs to one account). */
  | { kind: "label"; accountId: string; labelId: string }
  /** One of Kite's own spaces (lib/spaces.ts): its conversations and its pockets', from every account in view. */
  | { kind: "space"; spaceId: string }
  | { kind: "settings"; section?: SettingsSection };

export type MailState = {
  threads: Thread[];
  view: View;
  /** The accounts in view (lib/mail/scope.ts). */
  accountId: AccountScope;
  /** The inbox's side in view: People or Everything else (lib/mail/sides.ts). */
  side: InboxSide;
  query: string;
  selectedId: string | null;
  /** Messages that were unread when the selected thread was opened (captured before it's marked read). */
  unseen: { threadId: string; ids: string[] } | null;
  /** Live accounts: the server already scoped, searched and sorted the threads. */
  remote: boolean;
  /** Live accounts: the search the current threads were loaded for. Until a typed search's results arrive, the list keeps showing what it had. */
  listQuery: string;
  /** Local per-thread state (subject, pin, mute, note, chat view), applied on top of the threads. */
  overrides: Record<string, ThreadOverride>;
  /** Kite's spaces and pockets (lib/spaces.ts). */
  spaces: Space[];
};

export type MailAction =
  | { type: "replace"; threads: Thread[]; listQuery?: string }
  /** Demo mode's local splits and merges (and their undo) rewrite the thread list. */
  | { type: "rewrite"; update: (threads: Thread[]) => Thread[] }
  | { type: "view"; view: View }
  | { type: "account"; accountId: AccountScope }
  | { type: "side"; side: InboxSide }
  | { type: "query"; query: string }
  /** `peek`: shown because the list needed a selection, not opened by the user, so it stays unread. */
  | { type: "select"; id: string | null; peek?: boolean }
  /** Moves the cursor without opening (and so without marking read), for bulk select. */
  | { type: "focus"; id: string | null }
  | { type: "patch"; id: string; patch: Partial<Thread> }
  | { type: "remote"; remote: boolean }
  | { type: "overrides"; overrides: Record<string, ThreadOverride> }
  | { type: "override"; id: string; override: ThreadOverride | null }
  | { type: "spaces"; spaces: Space[] };

export function lastMessageDate(thread: Thread) {
  return thread.messages[thread.messages.length - 1].date;
}

/** `space`: the space in view and its pockets (lib/spaces.ts `within`), for a space view. */
export function inView(thread: Thread, view: View, space?: Set<string>) {
  if (view.kind === "space") return !!space && !!thread.spaces?.some((id) => space.has(id));
  if (view.kind === "cleanup" || view.kind === "settings" || view.kind === "files" || view.kind === "notes" || view.kind === "contacts" || view.kind === "automations" || view.kind === "calendar") return false;
  if (view.kind === "label") return thread.accountId === view.accountId && !!thread.labels?.includes(view.labelId);
  if (view.kind === "home") return thread.mailbox === "inbox";
  if (view.mailbox === "starred") return thread.starred && thread.mailbox !== "screener" && thread.mailbox !== "trash";
  // All mail (id `archive`) shows Inbox conversations as well.
  if (view.mailbox === "archive") return thread.mailbox === "archive" || thread.mailbox === "inbox";
  return thread.mailbox === view.mailbox;
}

function matchesQuery(thread: Thread, query: string) {
  return !query.trim() || matchesSearch(thread, parseSearch(query));
}

/** Threads in the current view before the inbox's split into People and Everything else. */
/** The search the list shows: typed (local data), or the one the live list was loaded for. */
const shownQuery = (state: MailState) => (state.remote ? state.listQuery : state.query).trim();

export function scopedThreads(state: MailState) {
  const shown = state.threads.map((t) => applyOverride(t, state.overrides[t.id]));
  const query = shownQuery(state);
  // Live search results are already scoped by the server; a search inside a label still keeps to the label.
  if (state.remote && query && state.view.kind === "mailbox") return pinnedFirst(shown);
  const ordered = state.view.kind === "mailbox" && ["scheduled", "snoozed"].includes(state.view.mailbox);
  const space = state.view.kind === "space" ? within(state.spaces, state.view.spaceId) : undefined;
  const scoped = shown
    .filter((t) => inScope(state.accountId, t.accountId))
    // Searches look in every mailbox, as they do for live accounts.
    .filter((t) => (query && state.view.kind === "mailbox") || inView(t, state.view, space))
    .filter((t) => state.remote || matchesQuery(t, query));
  return pinnedFirst(ordered ? scoped : scoped.sort((a, b) => lastMessageDate(b).localeCompare(lastMessageDate(a))));
}

/** One thread as shown, with its local overrides applied. */
export function shownThread(state: MailState, id: string | null) {
  const thread = id ? state.threads.find((t) => t.id === id) : undefined;
  return thread ? applyOverride(thread, state.overrides[thread.id]) : null;
}

export function visibleThreads(state: MailState) {
  const scoped = scopedThreads(state);
  const splitInbox = state.view.kind === "mailbox" && state.view.mailbox === "inbox" && !shownQuery(state);
  return splitInbox ? scoped.filter((t) => sideOf(t) === state.side) : scoped;
}

/**
 * Messages the user hasn't seen, captured as a thread opens (before it's marked read).
 * A thread marked unread without an unread message (some demo threads): the newest counts as new.
 */
function unseenMessageIds(thread: Thread): string[] {
  if (!thread.unread) return [];
  const flagged = thread.messages.filter((m) => m.unread && !m.draft).map((m) => m.id);
  const last = thread.messages[thread.messages.length - 1];
  return flagged.length ? flagged : last ? [last.id] : [];
}

/** A thread as list responses carry it (bodies stripped like server/store.ts `hydrate`), for comparing. */
const signatures = new WeakMap<Thread, string>();
function listSignature(thread: Thread) {
  let signature = signatures.get(thread);
  if (signature === undefined) {
    signature = JSON.stringify({
      ...thread,
      loaded: undefined,
      messages: thread.messages.map((m) => ({ ...m, labels: undefined, html: undefined, body: m.snippet ? [] : m.body.slice(0, 1), trackersBlocked: undefined })),
    });
    signatures.set(thread, signature);
  }
  return signature;
}

/**
 * A reloaded list keeps the objects of threads that didn't change, so memoised rows don't
 * re-render and an open conversation keeps its downloaded bodies. A changed thread that was
 * opened keeps its bodies while its messages are the same ones.
 */
function keepUnchanged(previous: Thread[], next: Thread[]): Thread[] {
  if (!previous.length || !next.length) return next;
  const byId = new Map(previous.map((t) => [t.id, t]));
  return next.map((thread) => {
    const before = byId.get(thread.id);
    if (!before) return thread;
    if (listSignature(before) === listSignature(thread)) return before;
    const sameMessages = before.messages.length === thread.messages.length && before.messages.every((m, i) => m.id === thread.messages[i].id);
    if (!before.loaded || !sameMessages) return thread;
    return {
      ...thread,
      loaded: true,
      messages: thread.messages.map((m, i) => {
        const full = before.messages[i];
        return { ...m, html: full.html, body: full.body, labels: full.labels, trackersBlocked: full.trackersBlocked };
      }),
    };
  });
}

export function mailReducer(state: MailState, action: MailAction): MailState {
  switch (action.type) {
    case "replace":
      return { ...state, threads: keepUnchanged(state.threads, action.threads), listQuery: action.listQuery ?? state.listQuery };
    case "rewrite":
      return { ...state, threads: action.update(state.threads) };
    case "remote":
      return { ...state, remote: action.remote };
    case "overrides":
      return { ...state, overrides: action.overrides };
    case "spaces":
      return { ...state, spaces: action.spaces };
    case "override": {
      const overrides = { ...state.overrides };
      if (action.override) overrides[action.id] = action.override;
      else delete overrides[action.id];
      return { ...state, overrides };
    }
    // Live lists are loaded per view: the old list is dropped first, so nothing from it is
    // auto-opened (and marked read) while the new one loads.
    case "view": {
      const loads =
        state.remote &&
        (action.view.kind === "mailbox" || action.view.kind === "label" || action.view.kind === "space") &&
        JSON.stringify(action.view) !== JSON.stringify(state.view);
      return { ...state, view: action.view, selectedId: null, threads: loads ? [] : state.threads };
    }
    case "account":
      return {
        ...state,
        accountId: action.accountId,
        selectedId: null,
        threads: state.remote && action.accountId !== state.accountId ? [] : state.threads,
      };
    case "side":
      return { ...state, side: action.side, selectedId: null };
    case "query":
      return { ...state, query: action.query };
    case "select": {
      const opened = state.threads.find((t) => t.id === action.id);
      return {
        ...state,
        selectedId: action.id,
        unseen: opened ? { threadId: opened.id, ids: unseenMessageIds(opened) } : null,
        threads: state.threads.map((t) =>
          t.id === action.id && !action.peek && (t.unread || t.messages.some((m) => m.unread))
            ? { ...t, unread: false, messages: t.messages.map((m) => (m.unread ? { ...m, unread: undefined } : m)) }
            : t,
        ),
      };
    }
    case "focus":
      return { ...state, selectedId: action.id };
    case "patch":
      return {
        ...state,
        threads: state.threads.map((t) => (t.id === action.id ? { ...t, ...action.patch } : t)),
      };
  }
}
