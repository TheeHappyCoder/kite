import * as z from "zod";

// Per-person choices that live only in Kite's database (never in Gmail): the VIP flag, a
// private note and "always load images". Keyed by lower-cased address. Kite never sets these by itself.

export type PersonPrefs = {
  /** Notify straight away (see lib/notify-rules.ts). */
  vip?: true;
  /** Private note, plain text. Never sent, never logged. */
  note?: string;
  /** Load remote images from this sender without asking (tracking pixels are still stripped). */
  images?: true;
};

export const NOTE_MAX = 1000;

/** One change to a person's local state. null clears the note. */
export const PersonPatch = z.object({
  email: z.email().max(320),
  vip: z.boolean().optional(),
  note: z.string().max(NOTE_MAX).nullable().optional(),
  images: z.boolean().optional(),
});
export type PersonPatch = z.infer<typeof PersonPatch>;

export const personKey = (email: string) => email.trim().toLowerCase();

/** The prefs after a patch, or null when nothing is left to keep. */
export function patchPerson(current: PersonPrefs | undefined, patch: Omit<PersonPatch, "email">): PersonPrefs | null {
  const next: PersonPrefs = { ...current };
  if (patch.vip !== undefined) {
    if (patch.vip) next.vip = true;
    else delete next.vip;
  }
  if (patch.note !== undefined) {
    if (patch.note?.trim()) next.note = patch.note;
    else delete next.note;
  }
  if (patch.images !== undefined) {
    if (patch.images) next.images = true;
    else delete next.images;
  }
  return Object.keys(next).length ? next : null;
}
