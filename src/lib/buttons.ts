import * as z from "zod";

/**
 * Every action on a conversation that can sit on a button: one list for the reader's toolbar, the
 * message list's hover row and the More menus. Settings → Buttons places them; whatever isn't placed
 * stays in More. Kite's words for each live in BUTTON_INFO; icons in components/mail/button-icons.ts.
 */
export const BUTTON_ACTIONS = [
  "archive",
  "trash",
  "snooze",
  "replyAll",
  "forward",
  "read",
  "star",
  "pin",
  "mute",
  "labels",
  "files",
  "chat",
  "people",
  "screenshot",
  "summarise",
  "note",
  "rename",
  "merge",
  "calendar",
  "spam",
] as const;
export type ButtonAction = (typeof BUTTON_ACTIONS)[number];

/** A thin line between groups on the toolbar. */
export const DIVIDER = "divider";
export type ToolbarSlot = ButtonAction | typeof DIVIDER;

/** What a hover-row button can do without opening the conversation (the same verbs as a swipe). */
export const HOVER_ACTIONS = ["archive", "trash", "snooze", "read", "star", "pin", "mute"] as const satisfies readonly ButtonAction[];
export type HoverAction = (typeof HOVER_ACTIONS)[number];
/** Rows are narrow: the hover row holds this many besides More. */
export const HOVER_MAX = 4;

/**
 * `label`: the name in settings and menus. `group`: where it sits in More (a divider between groups),
 * in this order.
 */
export const BUTTON_INFO: Record<ButtonAction, { label: string; group: "write" | "view" | "organise" | "ai" | "kite" | "report" }> = {
  replyAll: { label: "Reply all", group: "write" },
  forward: { label: "Forward", group: "write" },
  files: { label: "Files in this conversation", group: "view" },
  chat: { label: "Chat view", group: "view" },
  people: { label: "People in this conversation", group: "view" },
  screenshot: { label: "Screenshot", group: "view" },
  archive: { label: "Archive", group: "organise" },
  trash: { label: "Delete", group: "organise" },
  snooze: { label: "Snooze until tomorrow", group: "organise" },
  read: { label: "Mark read or unread", group: "organise" },
  star: { label: "Star", group: "organise" },
  pin: { label: "Pin to the top", group: "organise" },
  labels: { label: "Labels", group: "organise" },
  mute: { label: "Mute", group: "organise" },
  summarise: { label: "Summarise with AI", group: "ai" },
  note: { label: "Private note", group: "kite" },
  rename: { label: "Rename subject", group: "kite" },
  merge: { label: "Merge with…", group: "kite" },
  calendar: { label: "Add to calendar…", group: "kite" },
  spam: { label: "Report spam", group: "report" },
};

/** The order of More: BUTTON_INFO's, which is already grouped. */
export const MENU_ORDER = Object.keys(BUTTON_INFO) as ButtonAction[];

const Slots = z.array(z.enum([...BUTTON_ACTIONS, DIVIDER]));

export const ButtonPrefs = z.object({
  /** The reader's toolbar: the left group (triage, writing) and the right group (how you see it). */
  toolbar: z
    .object({
      left: Slots.default(["archive", "trash", DIVIDER, "replyAll", "forward"]),
      right: Slots.default(["files", "star", "chat", "people", "screenshot"]),
    })
    .default({ left: ["archive", "trash", DIVIDER, "replyAll", "forward"], right: ["files", "star", "chat", "people", "screenshot"] }),
  /** The message list's hover row, before its More button. */
  hover: z.array(z.enum(HOVER_ACTIONS)).max(HOVER_MAX).default(["archive", "trash", "snooze"]),
});
export type ButtonPrefs = z.infer<typeof ButtonPrefs>;
export const DEFAULT_BUTTONS: ButtonPrefs = ButtonPrefs.parse({});

/** Every action placed on the toolbar, either side. */
export function onToolbar(prefs: ButtonPrefs): Set<ButtonAction> {
  return new Set([...prefs.toolbar.left, ...prefs.toolbar.right].filter((s): s is ButtonAction => s !== DIVIDER));
}

/** No divider at either end or twice in a row (what's left after a button is taken away). */
export function tidySlots(slots: ToolbarSlot[]): ToolbarSlot[] {
  const out: ToolbarSlot[] = [];
  for (const slot of slots) {
    if (slot === DIVIDER && (!out.length || out[out.length - 1] === DIVIDER)) continue;
    out.push(slot);
  }
  if (out[out.length - 1] === DIVIDER) out.pop();
  return out;
}
