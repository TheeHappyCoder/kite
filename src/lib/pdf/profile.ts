import * as z from "zod";

// Fill & sign profile: the details forms keep asking for. Kept only in the local database
// (settings table, key "profile"), never sent anywhere and never logged. Used only when the
// user presses "Fill from my profile" (matching rules in profile-rules.ts).

const Text = (max = 120) => z.string().trim().max(max).default("");
/** ISO yyyy-mm-dd, or "" when not set. */
const IsoDate = z
  .string()
  .trim()
  .regex(/^$|^\d{4}-\d{2}-\d{2}$/, "Use a date")
  .default("");

export const Dependant = z.object({
  id: z.string().min(1).max(64),
  name: Text(),
  relationship: Text(40),
  dateOfBirth: IsoDate,
  idNumber: Text(40),
});
export type Dependant = z.infer<typeof Dependant>;

export const Profile = z.object({
  firstNames: Text(),
  surname: Text(),
  idNumber: Text(40),
  dateOfBirth: IsoDate,
  phone: Text(40),
  email: z.string().trim().max(320).default(""),
  address: z
    .object({
      street: Text(200),
      suburb: Text(),
      city: Text(),
      postalCode: Text(20),
    })
    .default({ street: "", suburb: "", city: "", postalCode: "" }),
  medicalAid: z
    .object({
      scheme: Text(),
      plan: Text(),
      number: Text(60),
      mainMember: Text(),
      mainMemberId: Text(40),
    })
    .default({ scheme: "", plan: "", number: "", mainMember: "", mainMemberId: "" }),
  dependants: z.array(Dependant).max(20).default([]),
  employer: z
    .object({
      name: Text(),
      occupation: Text(),
      phone: Text(40),
    })
    .default({ name: "", occupation: "", phone: "" }),
  nextOfKin: z
    .object({
      name: Text(),
      relationship: Text(40),
      phone: Text(40),
    })
    .default({ name: "", relationship: "", phone: "" }),
});
export type Profile = z.infer<typeof Profile>;

export const EMPTY_PROFILE: Profile = Profile.parse({});

/** No detail filled in anywhere. */
export function isEmptyProfile(profile: Profile) {
  const strings = (value: unknown): string[] =>
    typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(strings) : value && typeof value === "object" ? Object.entries(value).flatMap(([k, v]) => (k === "id" ? [] : strings(v))) : [];
  return strings(profile).every((s) => !s.trim());
}
