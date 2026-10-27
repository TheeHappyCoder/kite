import * as z from "zod";

// The Kite bar API: what other apps, scripts and services may show in the Kite bar (docs/bar.md).
// One validated JSON record per activity, drawn by Kite in its own look: no HTML, no remote images,
// nothing that runs. An integration sends these to POST /api/bar/activities with its token; the
// same `key` again updates the activity in place (a progress bar, a countdown, a status).

export const BAR_API_VERSION = 1;

/** The icons an activity may name (Hugeicons, drawn by Kite). */
export const BAR_ICONS = [
  "bell",
  "check",
  "alert",
  "info",
  "build",
  "deploy",
  "bug",
  "code",
  "timer",
  "calendar",
  "message",
  "mail",
  "music",
  "download",
  "upload",
  "chart",
  "money",
  "home",
  "bolt",
  "sparkles",
  "star",
  "heart",
] as const;

/** The accent colour of the icon and progress: Kite's own tokens. */
export const BAR_TINTS = ["accent", "success", "warning", "danger", "neutral"] as const;

const text = (max: number) => z.string().trim().min(1).max(max);

const Https = z
  .url({ protocol: /^https$/, error: "Use an https:// address" })
  .max(2000)
  .describe("Opened in the user's browser, only when they click.");

const BarAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open_url"), label: text(24), url: Https }).describe("Opens an https link in the browser."),
  z.object({ type: z.literal("copy"), label: text(24), text: z.string().min(1).max(500) }).describe("Copies text to the clipboard."),
  z
    .object({
      type: z.literal("callback"),
      label: text(24),
      id: z.string().regex(/^[\w-]{1,40}$/, "Letters, digits, - and _ only"),
    })
    .describe("Tells your integration the user clicked it: an `action` event on GET /api/bar/events."),
]);
type BarAction = z.infer<typeof BarAction>;

export const BarValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: text(40) }).describe("A short line shown large: a score, a price, a status."),
  z.object({ type: z.literal("code"), code: text(40) }).describe("A code shown large with Copy."),
  z
    .object({ type: z.literal("progress"), progress: z.number().min(0).max(1), label: text(40).optional() })
    .describe("A bar from 0 to 1, with an optional label like `3 of 5`."),
  z
    .object({ type: z.literal("countdown"), until: z.iso.datetime({ offset: true }), label: text(40).optional() })
    .describe("Counts down to an instant (ISO 8601 with a zone)."),
]);
export type BarValue = z.infer<typeof BarValue>;

export const BarActivityInput = z
  .object({
    key: z
      .string()
      .regex(/^[\w.:-]{1,64}$/, "Up to 64 letters, digits, . : - _")
      .optional()
      .describe("Your id for this activity. Send the same key again to update it in place; without one, every call is new."),
    title: text(60),
    subtitle: text(100).optional(),
    body: text(280).optional().describe("A sentence or two, shown when the Kite bar opens."),
    icon: z.enum(BAR_ICONS).default("bell"),
    tint: z.enum(BAR_TINTS).default("accent"),
    value: BarValue.optional(),
    actions: z.array(BarAction).max(3).default([]),
    priority: z
      .enum(["passive", "normal", "high"])
      .default("normal")
      .describe("passive: arrives resting, as one line. normal: drops open for a moment. high: also goes ahead of what's waiting."),
    duration: z
      .number()
      .int()
      .min(5)
      .max(86_400)
      .default(60)
      .describe("Seconds it stays (from the last update), up to a day. Long-lived ones take turns with whatever else is waiting."),
  })
  .describe("One activity in the Kite bar.");
export type BarActivityInput = z.input<typeof BarActivityInput>;
export type BarActivitySpec = z.infer<typeof BarActivityInput>;

/** An activity as the Kite bar shows it: the spec plus where it came from and when it goes. */
export type BarActivity = BarActivitySpec & {
  /** `${source id}:${key}`. */
  id: string;
  key: string;
  source: { id: string; name: string };
  updatedAt: string;
  expiresAt: string;
};

/** What an integration hears on GET /api/bar/events. */
export type BarIntegrationEvent =
  | { type: "action"; key: string; action: string }
  | { type: "dismissed"; key: string }
  | { type: "expired"; key: string };

/** The schema served at GET /api/bar, for people and for AI assistants writing integrations. */
export function barSchema() {
  return z.toJSONSchema(BarActivityInput, { io: "input" });
}
