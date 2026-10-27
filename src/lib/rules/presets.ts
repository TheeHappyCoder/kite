import type { PresetId, Rule } from "./spec";

// Built-in rules, in the order they're first listed. They replace what used to be hard-wired
// (mute, Block, the Screener, new-mail notifications). Each ships on or off once; after that only
// the user changes it. Kite never adds a rule by itself beyond these.

type Preset = Omit<Rule, "id" | "preset" | "gmail" | "ai" | "aiModel" | "fields" | "checks" | "schedule" | "delay"> & { preset: PresetId; about: string };

export const PRESET_RULES: Preset[] = [
  {
    preset: "muted",
    name: "Muted conversations",
    about: "New replies in a conversation you muted skip the inbox and stay quiet.",
    enabled: true,
    when: "new_mail",
    accounts: [],
    query: "",
    conditions: [{ kind: "muted", negate: false }],
    actions: [{ verb: "archive" }, { verb: "notify", mode: "silent" }],
    stop: true,
  },
  {
    preset: "blocked",
    name: "Blocked senders",
    about: "Mail from people you blocked skips the inbox and stays quiet.",
    enabled: true,
    when: "new_mail",
    accounts: [],
    query: "",
    conditions: [{ kind: "sender", status: "blocked", negate: false }],
    actions: [{ verb: "archive" }, { verb: "notify", mode: "silent" }],
    stop: true,
  },
  {
    preset: "screener",
    name: "Hold new senders",
    about: "People emailing you for the first time wait in the Screener until you let them in.",
    enabled: false,
    when: "new_mail",
    accounts: [],
    query: "in:inbox",
    conditions: [{ kind: "sender", status: "new", negate: false }],
    actions: [{ verb: "screen" }, { verb: "notify", mode: "silent" }],
    stop: false,
  },
  {
    preset: "vip-notify",
    name: "VIPs: notify now",
    about: "Mail from people you marked VIP notifies straight away, even with batches on.",
    enabled: true,
    when: "new_mail",
    accounts: [],
    query: "in:inbox",
    conditions: [{ kind: "vip", negate: false }],
    actions: [{ verb: "notify", mode: "now" }],
    stop: false,
  },
  {
    preset: "new-mail-notify",
    name: "Everyone else: notify",
    about: "Any other new mail in your inbox notifies, with the next batch when batches are on.",
    enabled: false,
    when: "new_mail",
    accounts: [],
    query: "in:inbox",
    conditions: [],
    actions: [{ verb: "notify", mode: "batch" }],
    stop: false,
  },
];

export const presetAbout = (id: PresetId) => PRESET_RULES.find((p) => p.preset === id)?.about ?? "";

/** New rules go just above this one, so a catch-all notify stays last. */
export const LAST_PRESET: PresetId = "new-mail-notify";
