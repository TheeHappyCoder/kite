"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type ShortcutAction =
  | "next"
  | "prev"
  | "open"
  | "back"
  | "menu"
  | "archive"
  | "delete"
  | "spam"
  | "star"
  | "toggleRead"
  | "snooze"
  | "reply"
  | "replyAll"
  | "forward"
  | "summarise"
  | "chatView"
  | "mute"
  | "pin"
  | "note"
  | "merge"
  | "people"
  | "vip"
  | "label"
  | "space"
  | "moveSpace"
  | "actions"
  | "addToCalendar"
  | "screenshot"
  | "translate"
  | "annotateUndo"
  | "annotateRedo"
  | "compose"
  | "search"
  | "refresh"
  | "undo"
  | "palette"
  | "shortcuts"
  | "theme"
  | "settings"
  | "screenPrivacy"
  | "lock"
  | "files"
  | "notes"
  | "home"
  | "contacts"
  | "automations"
  | "calendar"
  | "calendarPrev"
  | "calendarNext"
  | "calendarToday"
  | "accountAll"
  | AccountShortcut
  | "select"
  | "selectNext"
  | "selectPrev"
  | "selectAll"
  | "clearSelection"
  | "tab1"
  | "tab2"
  | "tab3"
  | "tab4"
  | "send"
  | "sendArchive"
  | "ccBcc"
  | "attach"
  | "attachFromFiles"
  | "bold"
  | "italic"
  | "link"
  | "bulletList"
  | "numberList"
  | "minimizeCompose";

/** Switches to the nth connected account (in the order they were added). */
type AccountShortcut = `account${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`;

type Definition = { id: ShortcutAction; label: string; group: string; defaults: string[] };

export const SHORTCUT_DEFINITIONS: Definition[] = [
  { id: "next", label: "Next conversation", group: "Navigation", defaults: ["j", "ArrowDown"] },
  { id: "prev", label: "Previous conversation", group: "Navigation", defaults: ["k", "ArrowUp"] },
  { id: "open", label: "Open conversation (one pane at a time)", group: "Navigation", defaults: ["Enter", "o"] },
  { id: "back", label: "Back to the list (one pane at a time)", group: "Navigation", defaults: ["Backspace"] },
  { id: "menu", label: "Sidebar (narrow windows)", group: "Navigation", defaults: ["g"] },
  { id: "search", label: "Search", group: "Navigation", defaults: ["/"] },
  { id: "tab1", label: "Primary tab", group: "Navigation", defaults: ["1"] },
  { id: "tab2", label: "Second inbox tab", group: "Navigation", defaults: ["2"] },
  { id: "tab3", label: "Third inbox tab", group: "Navigation", defaults: ["3"] },
  { id: "tab4", label: "Fourth inbox tab", group: "Navigation", defaults: ["4"] },
  { id: "files", label: "All files", group: "Navigation", defaults: ["shift+f"] },
  { id: "notes", label: "Notes", group: "Navigation", defaults: ["shift+n"] },
  { id: "contacts", label: "Contacts", group: "Navigation", defaults: ["shift+o"] },
  { id: "automations", label: "Automations", group: "Navigation", defaults: ["shift+u"] },
  { id: "home", label: "Home", group: "Navigation", defaults: ["shift+h"] },
  { id: "calendar", label: "Calendar", group: "Navigation", defaults: ["w"] },
  { id: "calendarPrev", label: "Calendar: back", group: "Navigation", defaults: ["["] },
  { id: "calendarNext", label: "Calendar: forward", group: "Navigation", defaults: ["]"] },
  { id: "calendarToday", label: "Calendar: today", group: "Navigation", defaults: ["."] },
  { id: "accountAll", label: "All accounts", group: "Accounts", defaults: ["alt+0"] },
  ...([1, 2, 3, 4, 5, 6, 7, 8, 9] as const).map((n) => ({
    id: `account${n}` as AccountShortcut,
    label: `Account ${n}`,
    group: "Accounts",
    defaults: [`alt+${n}`],
  })),
  { id: "select", label: "Select conversation", group: "Selection", defaults: ["x"] },
  { id: "selectNext", label: "Extend selection down", group: "Selection", defaults: ["shift+j", "shift+ArrowDown"] },
  { id: "selectPrev", label: "Extend selection up", group: "Selection", defaults: ["shift+k", "shift+ArrowUp"] },
  { id: "selectAll", label: "Select all in list", group: "Selection", defaults: ["shift+a"] },
  { id: "clearSelection", label: "Clear selection", group: "Selection", defaults: ["Escape"] },
  { id: "archive", label: "Archive", group: "Conversation", defaults: ["e"] },
  { id: "snooze", label: "Snooze until tomorrow", group: "Conversation", defaults: ["h"] },
  { id: "star", label: "Star", group: "Conversation", defaults: ["s"] },
  { id: "toggleRead", label: "Mark read / unread", group: "Conversation", defaults: ["u"] },
  { id: "spam", label: "Report spam", group: "Conversation", defaults: ["!"] },
  { id: "delete", label: "Delete", group: "Conversation", defaults: ["#"] },
  { id: "summarise", label: "Summarise thread", group: "Conversation", defaults: ["shift+s"] },
  { id: "chatView", label: "Chat view / email view", group: "Conversation", defaults: ["v"] },
  { id: "pin", label: "Pin to the top", group: "Conversation", defaults: ["p"] },
  { id: "mute", label: "Mute / unmute", group: "Conversation", defaults: ["m"] },
  { id: "note", label: "Private note", group: "Conversation", defaults: ["n"] },
  { id: "merge", label: "Merge with another conversation", group: "Conversation", defaults: ["shift+m"] },
  { id: "people", label: "People in this conversation", group: "Conversation", defaults: ["i"] },
  { id: "vip", label: "Mark VIP / not VIP", group: "Conversation", defaults: ["shift+v"] },
  { id: "label", label: "Labels / folders", group: "Conversation", defaults: ["l"] },
  { id: "space", label: "Add to a space", group: "Conversation", defaults: ["y"] },
  { id: "moveSpace", label: "Move to a space (out of the Inbox)", group: "Conversation", defaults: ["shift+y"] },
  { id: "actions", label: "Actions menu", group: "Conversation", defaults: ["ContextMenu", "F10"] },
  { id: "addToCalendar", label: "Add to calendar", group: "Conversation", defaults: ["shift+c"] },
  { id: "screenshot", label: "Screenshot the conversation", group: "Conversation", defaults: ["shift+x"] },
  { id: "translate", label: "Translate the newest message (on this PC)", group: "Conversation", defaults: ["t"] },
  { id: "reply", label: "Reply", group: "Writing", defaults: ["r"] },
  { id: "replyAll", label: "Reply all", group: "Writing", defaults: ["a"] },
  { id: "forward", label: "Forward", group: "Writing", defaults: ["f"] },
  { id: "compose", label: "New message", group: "Writing", defaults: ["c"] },
  { id: "send", label: "Send", group: "Compose", defaults: ["mod+Enter"] },
  { id: "sendArchive", label: "Send and archive the conversation", group: "Compose", defaults: ["mod+shift+Enter"] },
  { id: "ccBcc", label: "Show Cc and Bcc", group: "Compose", defaults: ["mod+shift+c"] },
  { id: "attach", label: "Attach files from this computer", group: "Compose", defaults: ["mod+shift+a"] },
  { id: "attachFromFiles", label: "Attach from your files", group: "Compose", defaults: ["mod+shift+e"] },
  { id: "bold", label: "Bold", group: "Compose", defaults: ["mod+b"] },
  { id: "italic", label: "Italic", group: "Compose", defaults: ["mod+i"] },
  { id: "link", label: "Link", group: "Compose", defaults: ["mod+shift+k"] },
  { id: "bulletList", label: "Bulleted list", group: "Compose", defaults: ["mod+*"] },
  { id: "numberList", label: "Numbered list", group: "Compose", defaults: ["mod+&"] },
  { id: "minimizeCompose", label: "Minimise / restore message", group: "Compose", defaults: ["mod+shift+m"] },
  { id: "annotateUndo", label: "Undo the last mark", group: "Screenshot", defaults: ["mod+z"] },
  { id: "annotateRedo", label: "Redo", group: "Screenshot", defaults: ["mod+shift+z", "mod+y"] },
  { id: "palette", label: "Command palette", group: "App", defaults: ["mod+k"] },
  { id: "shortcuts", label: "Keyboard shortcuts", group: "App", defaults: ["?"] },
  { id: "refresh", label: "Refresh", group: "App", defaults: ["shift+r"] },
  { id: "undo", label: "Undo", group: "App", defaults: ["z"] },
  { id: "theme", label: "Toggle light / dark panes", group: "App", defaults: ["shift+t"] },
  { id: "settings", label: "Settings", group: "App", defaults: ["mod+,"] },
  { id: "screenPrivacy", label: "Screen privacy (blur mail while sharing)", group: "App", defaults: ["shift+p"] },
  { id: "lock", label: "Lock Kite", group: "App", defaults: ["shift+l"] },
];

type Bindings = Record<ShortcutAction, string[]>;

const STORAGE_KEY = "kite-shortcuts";

export const DEFAULT_BINDINGS = Object.fromEntries(
  SHORTCUT_DEFINITIONS.map((d) => [d.id, d.defaults]),
) as Bindings;

const NAMED_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Enter", "Escape", "Backspace", "Delete", "Tab", " "]);
const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "CapsLock", "Dead", "Unidentified"]);

/**
 * Normalises a keyboard event to a combo string such as "mod+k", "shift+s" or "#".
 * Shift is recorded only for letters and named keys, because for symbols it is
 * already part of the character ("#" rather than "shift+3").
 */
export function comboFromEvent(e: KeyboardEvent | React.KeyboardEvent): string | null {
  // Browser autofill fires synthetic keydown events with no key.
  if (!e.key || MODIFIER_KEYS.has(e.key)) return null;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey && (/^[a-z]$/.test(key) || NAMED_KEYS.has(e.key))) parts.push("shift");
  parts.push(key === " " ? "Space" : key);
  return parts.join("+");
}

const KEY_LABELS: Record<string, string> = {
  mod: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "⌫",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Space: "Space",
};

export function comboParts(combo: string) {
  return combo.split("+").map((part) => KEY_LABELS[part] ?? part.toUpperCase());
}

function loadBindings(): Bindings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<Bindings> | null;
    if (saved && typeof saved === "object") return { ...DEFAULT_BINDINGS, ...saved };
  } catch {}
  return DEFAULT_BINDINGS;
}

type ShortcutsContextValue = {
  bindings: Bindings;
  actionFor: (combo: string) => ShortcutAction | undefined;
  primary: (action: ShortcutAction) => string | undefined;
  /** Assigns a combo to an action, removing it from any action that already used it. Returns that action. */
  assign: (action: ShortcutAction, combo: string, replaceIndex?: number) => ShortcutAction | undefined;
  remove: (action: ShortcutAction, index: number) => void;
  reset: (action?: ShortcutAction) => void;
};

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function ShortcutsProvider({ children }: { children: React.ReactNode }) {
  const [bindings, setBindings] = useState<Bindings>(loadBindings);

  const save = useCallback((next: Bindings) => {
    setBindings(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const value = useMemo<ShortcutsContextValue>(() => {
    const lookup = new Map<string, ShortcutAction>();
    for (const [action, combos] of Object.entries(bindings)) {
      for (const combo of combos) lookup.set(combo, action as ShortcutAction);
    }
    return {
      bindings,
      actionFor: (combo) => lookup.get(combo),
      primary: (action) => bindings[action]?.[0],
      assign: (action, combo, replaceIndex) => {
        const previousOwner = lookup.get(combo);
        const next = { ...bindings };
        if (previousOwner && previousOwner !== action) {
          next[previousOwner] = next[previousOwner].filter((c) => c !== combo);
        }
        const list = [...next[action]].filter((c) => c !== combo);
        if (replaceIndex != null && replaceIndex < next[action].length) {
          const original = next[action][replaceIndex];
          const at = list.indexOf(original);
          if (at >= 0) list.splice(at, 1, combo);
          else list.splice(replaceIndex, 0, combo);
        } else {
          list.push(combo);
        }
        next[action] = list;
        save(next);
        return previousOwner !== action ? previousOwner : undefined;
      },
      remove: (action, index) => {
        save({ ...bindings, [action]: bindings[action].filter((_, i) => i !== index) });
      },
      reset: (action) => {
        save(action ? { ...bindings, [action]: DEFAULT_BINDINGS[action] } : DEFAULT_BINDINGS);
      },
    };
  }, [bindings, save]);

  return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}

export function useShortcuts() {
  const context = useContext(ShortcutsContext);
  if (!context) throw new Error("useShortcuts must be used inside ShortcutsProvider");
  return context;
}
