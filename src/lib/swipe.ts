import * as z from "zod";

/** What a swipe on a message-list row does (touch screens). Settings → Appearance picks one per direction. */
export const SWIPE_ACTIONS = ["none", "archive", "trash", "snooze", "read", "star", "pin", "mute"] as const;
export type SwipeAction = (typeof SWIPE_ACTIONS)[number];

/** `right`: the finger moves right (the action shows at the row's left edge). */
export const SwipePrefs = z.object({
  right: z.enum(SWIPE_ACTIONS).default("archive"),
  left: z.enum(SWIPE_ACTIONS).default("snooze"),
});
export type SwipePrefs = z.infer<typeof SwipePrefs>;
export type SwipeSide = keyof SwipePrefs;

/** The colour the row's backdrop fills with once the swipe will go through. */
export type SwipeTone = "success" | "warning" | "danger" | "accent";

export const SWIPE_INFO: Record<Exclude<SwipeAction, "none">, { label: string; tone: SwipeTone }> = {
  archive: { label: "Archive", tone: "success" },
  trash: { label: "Move to trash", tone: "danger" },
  snooze: { label: "Snooze until tomorrow", tone: "warning" },
  read: { label: "Mark read or unread", tone: "accent" },
  star: { label: "Star or unstar", tone: "warning" },
  pin: { label: "Pin or unpin", tone: "accent" },
  mute: { label: "Mute or unmute", tone: "accent" },
};
