import "server-only";

import { EMPTY_PROFILE, Profile } from "@/lib/pdf/profile";
import { getDb } from "./db";

// The Fill & sign profile, one JSON record in the settings table (key "profile"). Kept apart from
// preferences so it never rides along the settings event to the desktop shell. Never log it.

export function getProfile(): Profile {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = 'profile'").get() as { value: string } | undefined;
  if (!row) return EMPTY_PROFILE;
  try {
    return Profile.parse(JSON.parse(row.value));
  } catch {
    return EMPTY_PROFILE;
  }
}

export function saveProfile(profile: Profile): Profile {
  const next = Profile.parse(profile);
  getDb()
    .prepare("INSERT INTO settings (key, value) VALUES ('profile', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(next));
  return next;
}
