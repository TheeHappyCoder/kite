import { formatAcrobatDate } from "./fill";
import type { Profile } from "./profile";

// Which form labels mean which profile detail, as typed data: a key, the plain label shown to the
// user, the normalised phrases that count as a confident match, and how the value is written.
// The matcher only accepts an exact phrase (after normalising and one "patient"/"your" prefix),
// so "Customer name", "Doctor's phone" or "Describe your symptoms" never match. An AI layer can
// later add rules or propose matches without changing the editor.

export type ProfileKey =
  | "fullName"
  | "firstNames"
  | "surname"
  | "initials"
  | "idNumber"
  | "dateOfBirth"
  | "address"
  | "street"
  | "suburb"
  | "city"
  | "postalCode"
  | "phone"
  | "email"
  | "medicalAid"
  | "medicalAidPlan"
  | "medicalAidNumber"
  | "mainMember"
  | "mainMemberId"
  | "employer"
  | "occupation"
  | "employerPhone"
  | "nextOfKin"
  | "nextOfKinRelationship"
  | "nextOfKinPhone"
  | "dependantName"
  | "dependantRelationship"
  | "dependantDateOfBirth"
  | "dependantIdNumber";

type ValueFormat = "text" | "date" | "digits";

type ProfileRule = {
  key: ProfileKey;
  /** Shown to the user ("ID number"). */
  label: string;
  /** Normalised phrases (see normalizeLabel). Indexed rules use `{n}` for the dependant's number. */
  synonyms: string[];
  format: ValueFormat;
  /** May fill a multi-line field (free-text fields are otherwise always the user's). */
  multiline?: boolean;
  /** One per dependant: the label carries the number ("Dependant 2 name"). */
  indexed?: boolean;
};

const PHONE = ["phone", "phone number", "telephone", "telephone number", "tel", "tel number", "cell", "cell number", "cellphone", "cellphone number", "cell phone", "cell phone number", "mobile", "mobile number", "mobile phone", "contact number"];

const PROFILE_RULES: ProfileRule[] = [
  { key: "fullName", label: "Name", format: "text", synonyms: ["name", "full name", "name and surname", "name surname", "first name and surname", "full name and surname", "names and surname", "full names and surname"] },
  { key: "firstNames", label: "First names", format: "text", synonyms: ["first name", "first names", "forename", "forenames", "given name", "given names", "christian name", "christian names"] },
  { key: "surname", label: "Surname", format: "text", synonyms: ["surname", "last name", "family name"] },
  { key: "initials", label: "Initials", format: "text", synonyms: ["initials"] },
  {
    key: "idNumber",
    label: "ID number",
    format: "digits",
    synonyms: ["id", "id number", "identity number", "identity document number", "id document number", "sa id", "sa id number", "rsa id", "rsa id number", "south african id number", "identification number", "id passport", "id passport number", "id or passport number"],
  },
  { key: "dateOfBirth", label: "Date of birth", format: "date", synonyms: ["date of birth", "dob", "birth date", "birthdate"] },
  { key: "address", label: "Address", format: "text", multiline: true, synonyms: ["address", "home address", "residential address", "physical address", "street address"] },
  { key: "street", label: "Street", format: "text", synonyms: ["street", "street name", "address line 1"] },
  { key: "suburb", label: "Suburb", format: "text", synonyms: ["suburb", "address line 2"] },
  { key: "city", label: "City", format: "text", synonyms: ["city", "town", "city town", "town city"] },
  { key: "postalCode", label: "Postal code", format: "text", synonyms: ["postal code", "postcode", "post code", "zip", "zip code"] },
  { key: "phone", label: "Phone", format: "text", synonyms: PHONE },
  { key: "email", label: "Email", format: "text", synonyms: ["email", "email address"] },
  { key: "medicalAid", label: "Medical aid", format: "text", synonyms: ["medical aid", "medical aid name", "name of medical aid", "medical aid scheme", "medical scheme", "medical aid fund", "scheme name"] },
  { key: "medicalAidPlan", label: "Medical aid plan", format: "text", synonyms: ["medical aid plan", "medical aid option", "medical plan", "plan option", "benefit option", "scheme option"] },
  {
    key: "medicalAidNumber",
    label: "Medical aid number",
    format: "text",
    synonyms: ["medical aid number", "medical aid membership number", "medical aid member number", "membership number", "member number", "medical scheme number", "scheme number"],
  },
  { key: "mainMember", label: "Main member", format: "text", synonyms: ["main member", "main member name", "main member full name", "name of main member", "principal member", "principal member name"] },
  { key: "mainMemberId", label: "Main member ID", format: "digits", synonyms: ["main member id", "main member id number", "principal member id", "principal member id number"] },
  { key: "employer", label: "Employer", format: "text", synonyms: ["employer", "employer name", "name of employer"] },
  { key: "occupation", label: "Occupation", format: "text", synonyms: ["occupation", "job title", "profession"] },
  {
    key: "employerPhone",
    label: "Work phone",
    format: "text",
    synonyms: ["employer phone", "employer tel", "employer telephone", "employer contact number", "work phone", "work number", "work telephone", "tel work", "tel w", "telephone work", "business phone"],
  },
  {
    key: "nextOfKin",
    label: "Next of kin",
    format: "text",
    synonyms: ["next of kin", "next of kin name", "next of kin full name", "name of next of kin", "nok", "nok name", "emergency contact", "emergency contact name", "emergency contact person", "nearest relative"],
  },
  {
    key: "nextOfKinRelationship",
    label: "Next of kin relationship",
    format: "text",
    synonyms: ["next of kin relationship", "relationship of next of kin", "nok relationship", "emergency contact relationship"],
  },
  {
    key: "nextOfKinPhone",
    label: "Next of kin phone",
    format: "text",
    synonyms: [
      "next of kin phone",
      "next of kin contact number",
      "next of kin number",
      "next of kin tel",
      "next of kin cell",
      "nok phone",
      "nok contact number",
      "nok tel",
      "nok cell",
      "emergency contact number",
      "emergency number",
      "emergency contact phone",
      "emergency contact tel",
      "emergency contact cell",
    ],
  },
  { key: "dependantName", label: "Dependant", format: "text", indexed: true, synonyms: ["dependant {n}", "dependant {n} name", "dependant {n} full name", "dependant name {n}", "name of dependant {n}"] },
  { key: "dependantRelationship", label: "Dependant relationship", format: "text", indexed: true, synonyms: ["dependant {n} relationship", "dependant relationship {n}"] },
  {
    key: "dependantDateOfBirth",
    label: "Dependant date of birth",
    format: "date",
    indexed: true,
    synonyms: ["dependant {n} date of birth", "dependant {n} dob", "dependant {n} birth date", "dependant dob {n}", "dependant date of birth {n}"],
  },
  { key: "dependantIdNumber", label: "Dependant ID number", format: "digits", indexed: true, synonyms: ["dependant {n} id", "dependant {n} id number", "dependant id {n}", "dependant id number {n}"] },
];

const RULES = new Map(PROFILE_RULES.map((r) => [r.key, r]));
const PHRASES = new Map<string, ProfileKey>();
for (const rule of PROFILE_RULES) for (const s of rule.synonyms) PHRASES.set(s, rule.key);

export const ruleFor = (key: ProfileKey) => RULES.get(key)!;

/** Words that say the label is about the person filling the form ("Patient name", "Your ID"). */
const SELF = new Set(["patient", "applicant", "employee", "your", "my"]);
/** Path parts of generated field names ("form1[0].Page1[0].Surname[0]") and widget prefixes. */
const NOISE_SEGMENT = /^(?:topmost ?subform|subform|form|page|section|part|txt|fld|tb)\d*$/;

const WORD_MAP: Record<string, string> = {
  no: "number",
  nr: "number",
  num: "number",
  nbr: "number",
  dependent: "dependant",
  dependents: "dependant",
  dependants: "dependant",
  surnames: "surname",
};

/** "Patient_IDNumber[0]" -> "patient id number"; "E-mail:" -> "email"; "I.D. No." -> "id number". */
function normalizeLabel(raw: string) {
  const words = raw
    .normalize("NFKC")
    // Format hints aren't part of the label: "Date of birth (dd/mm/yyyy)", "Email (optional)".
    .replace(/\([^)]*\b(?:dd|mm|yy|yyyy|optional)\b[^)]*\)/gi, " ")
    .replace(/\[\d+\]/g, "")
    .split(".")
    .filter((s) => !NOISE_SEGMENT.test(s.trim().toLowerCase()))
    .join(" ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])(\d)/g, "$1 $2")
    .replace(/(\d)([A-Za-z])/g, "$1 $2")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/#/g, " number ")
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\be mail\b/g, "email")
    .replace(/\bd o b\b/g, "dob")
    .replace(/\bi d\b/g, "id")
    .replace(/\bcell phone\b/g, "cellphone")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((w) => WORD_MAP[w] ?? w);
  while (words.length && NOISE_SEGMENT.test(words[0])) words.shift();
  return words.join(" ");
}

export type LabelMatch = { key: ProfileKey; index?: number };

function lookup(phrase: string): LabelMatch | null {
  const key = PHRASES.get(phrase);
  if (key && !ruleFor(key).indexed) return { key };
  const n = phrase.match(/\b(\d{1,2})\b/);
  if (!n) return null;
  const indexed = PHRASES.get(phrase.replace(/\b\d{1,2}\b/, "{n}"));
  const index = Number(n[1]);
  return indexed && index >= 1 ? { key: indexed, index } : null;
}

/** The profile detail a label asks for, only when it's an exact known phrase. Questions never match. */
export function matchLabel(raw: string): LabelMatch | null {
  if (raw.includes("?")) return null;
  const phrase = normalizeLabel(raw);
  const words = phrase.split(" ");
  if (!phrase || words.length > 8) return null;
  return lookup(phrase) ?? (words.length > 1 && SELF.has(words[0]) ? lookup(words.slice(1).join(" ")) : null);
}

function isoToDate(iso: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00`) : null;
}

/** The value a profile holds for a key, written the way the rule says ("" when there's none). */
export function profileValue(profile: Profile, match: LabelMatch, { dateFormat, multiline }: { dateFormat?: string; multiline?: boolean } = {}) {
  const rule = ruleFor(match.key);
  const dependant = rule.indexed ? profile.dependants[(match.index ?? 0) - 1] : undefined;
  const a = profile.address;
  const raw = (() => {
    switch (match.key) {
      case "fullName":
        return [profile.firstNames, profile.surname].filter(Boolean).join(" ");
      case "firstNames":
        return profile.firstNames;
      case "surname":
        return profile.surname;
      case "initials":
        return profile.firstNames
          .split(/\s+/)
          .filter(Boolean)
          .map((w) => w[0].toUpperCase())
          .join("");
      case "idNumber":
        return profile.idNumber;
      case "dateOfBirth":
        return profile.dateOfBirth;
      case "address":
        return [a.street, a.suburb, a.city, a.postalCode].filter(Boolean).join(multiline ? "\n" : ", ");
      case "street":
        return a.street;
      case "suburb":
        return a.suburb;
      case "city":
        return a.city;
      case "postalCode":
        return a.postalCode;
      case "phone":
        return profile.phone;
      case "email":
        return profile.email;
      case "medicalAid":
        return profile.medicalAid.scheme;
      case "medicalAidPlan":
        return profile.medicalAid.plan;
      case "medicalAidNumber":
        return profile.medicalAid.number;
      case "mainMember":
        return profile.medicalAid.mainMember;
      case "mainMemberId":
        return profile.medicalAid.mainMemberId;
      case "employer":
        return profile.employer.name;
      case "occupation":
        return profile.employer.occupation;
      case "employerPhone":
        return profile.employer.phone;
      case "nextOfKin":
        return profile.nextOfKin.name;
      case "nextOfKinRelationship":
        return profile.nextOfKin.relationship;
      case "nextOfKinPhone":
        return profile.nextOfKin.phone;
      case "dependantName":
        return dependant?.name ?? "";
      case "dependantRelationship":
        return dependant?.relationship ?? "";
      case "dependantDateOfBirth":
        return dependant?.dateOfBirth ?? "";
      case "dependantIdNumber":
        return dependant?.idNumber ?? "";
    }
  })().trim();
  if (!raw) return "";
  if (rule.format === "date") {
    const date = isoToDate(raw);
    return date ? formatAcrobatDate(date, dateFormat ?? "dd/mm/yyyy") : "";
  }
  if (rule.format === "digits") return raw.replace(/\s+/g, "");
  return raw;
}

/** "ID number", or "Dependant 2 date of birth". */
export function matchLabelText(match: LabelMatch) {
  const label = ruleFor(match.key).label;
  return match.index ? label.replace(/^Dependant/, `Dependant ${match.index}`) : label;
}
