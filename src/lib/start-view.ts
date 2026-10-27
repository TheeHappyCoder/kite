import type { View } from "./mail/store";
import type { StartView } from "./settings";

// Where Kite opens (preference `startView`): the screen you were on last, or always Home or the
// Inbox. The last screen is kept on this computer only (localStorage), like the sidebar's state.

const KEY = "kite-last-view";

/** Screens worth coming back to. Settings, a label (its account may be gone) and search are not. */
const KINDS = new Set<View["kind"]>(["home", "mailbox", "calendar", "automations", "files", "notes", "contacts", "cleanup"]);

const INBOX: View = { kind: "mailbox", mailbox: "inbox" };

/** Keeps the screen the user is on, for the next start. */
export function rememberView(view: View) {
  if (!KINDS.has(view.kind)) return;
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch {}
}

/** The screen to open on. */
export function startViewFor(pref: StartView): View {
  if (pref === "home") return { kind: "home" };
  if (pref === "inbox") return INBOX;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as View | null;
    if (saved && KINDS.has(saved.kind) && (saved.kind !== "mailbox" || typeof saved.mailbox === "string")) return saved;
  } catch {}
  return INBOX;
}
