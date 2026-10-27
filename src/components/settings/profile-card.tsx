"use client";

import { useEffect, useState } from "react";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { EMPTY_PROFILE, type Dependant, type Profile } from "@/lib/pdf/profile";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { DateTimePicker } from "../ui/date-time-picker";
import { Tooltip } from "../ui/tooltip";
import { Spinner } from "../ui/spinner";

// Settings → Fill & sign → Profile: the details "Fill from my profile" can put on a form.
// Kept on this computer only (settings table), loaded and saved through /api/fill-sign/profile.

const inputClass =
  "h-8 w-full min-w-0 rounded-full border border-pane-border bg-pane px-3 text-[12.5px] outline-none transition-colors placeholder:text-pane-muted/60 focus:border-accent/60";

type Path = readonly [keyof Profile] | readonly [keyof Profile, string];
type FieldSpec = { path: Path; label: string; type?: "date" | "email" | "tel"; wide?: boolean; placeholder?: string };

const GROUPS: { title: string; fields: FieldSpec[] }[] = [
  {
    title: "You",
    fields: [
      { path: ["firstNames"], label: "First names" },
      { path: ["surname"], label: "Surname" },
      { path: ["idNumber"], label: "ID number" },
      { path: ["dateOfBirth"], label: "Date of birth", type: "date" },
      { path: ["phone"], label: "Phone", type: "tel" },
      { path: ["email"], label: "Email", type: "email" },
    ],
  },
  {
    title: "Address",
    fields: [
      { path: ["address", "street"], label: "Street", wide: true, placeholder: "12 Main Road" },
      { path: ["address", "suburb"], label: "Suburb" },
      { path: ["address", "city"], label: "City" },
      { path: ["address", "postalCode"], label: "Postal code" },
    ],
  },
  {
    title: "Medical aid",
    fields: [
      { path: ["medicalAid", "scheme"], label: "Medical aid" },
      { path: ["medicalAid", "plan"], label: "Plan or option" },
      { path: ["medicalAid", "number"], label: "Membership number" },
      { path: ["medicalAid", "mainMember"], label: "Main member" },
      { path: ["medicalAid", "mainMemberId"], label: "Main member ID number" },
    ],
  },
  {
    title: "Employer",
    fields: [
      { path: ["employer", "name"], label: "Employer" },
      { path: ["employer", "occupation"], label: "Occupation" },
      { path: ["employer", "phone"], label: "Work phone", type: "tel" },
    ],
  },
  {
    title: "Next of kin",
    fields: [
      { path: ["nextOfKin", "name"], label: "Name" },
      { path: ["nextOfKin", "relationship"], label: "Relationship" },
      { path: ["nextOfKin", "phone"], label: "Phone", type: "tel" },
    ],
  },
];

/** A date in the profile ("YYYY-MM-DD" or empty): the house picker sized like the other inputs, clearable. */
function DateField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <DateTimePicker
      label={label}
      dateOnly
      placeholder="Pick a date"
      value={{ date: value, start: "", end: "" }}
      onChange={(next) => onChange(next.date)}
      onClear={() => onChange("")}
      className="h-8 gap-2 bg-pane px-3 text-[12.5px]"
    />
  );
}

function read(profile: Profile, path: Path): string {
  const top = profile[path[0]];
  if (path.length === 1) return typeof top === "string" ? top : "";
  return (top as Record<string, string>)[path[1]] ?? "";
}

function write(profile: Profile, path: Path, value: string): Profile {
  if (path.length === 1) return { ...profile, [path[0]]: value };
  return { ...profile, [path[0]]: { ...(profile[path[0]] as Record<string, string>), [path[1]]: value } };
}

const grid = "grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(min(12rem,100%),1fr))]";

export function ProfileCard({ onToast }: { onToast: (message: string) => void }) {
  const [saved, setSaved] = useState<Profile | null>(null);
  const [draft, setDraft] = useState<Profile>(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/fill-sign/profile", { signal: controller.signal })
      .then((res) => res.json())
      .then((data: { profile: Profile }) => {
        setSaved(data.profile);
        setDraft(data.profile);
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  const changed = !!saved && JSON.stringify(saved) !== JSON.stringify(draft);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/fill-sign/profile", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      const body = (await res.json().catch(() => ({}))) as { profile?: Profile; error?: string };
      if (!res.ok || !body.profile) throw new Error(body.error ?? "Kite couldn't save your profile. Try again.");
      setSaved(body.profile);
      setDraft(body.profile);
      onToast("Profile saved");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Kite couldn't save your profile. Try again.");
    } finally {
      setSaving(false);
    }
  };

  const setDependant = (id: string, patch: Partial<Dependant>) =>
    setDraft((p) => ({ ...p, dependants: p.dependants.map((d) => (d.id === id ? { ...d, ...patch } : d)) }));

  if (!saved) return <div className="h-40 animate-pulse rounded-xl bg-pane-2" />;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-pane-border px-4 py-3">
      <div>
        <p className="text-[13px] font-medium">Profile</p>
        <p className="mt-0.5 text-[12px] leading-snug text-pane-muted">
          Used only when you press Fill from my profile in a PDF, to fill fields Kite is sure about. Kept on this computer only.
        </p>
      </div>

      {GROUPS.map((group) => (
        <fieldset key={group.title} className="flex min-w-0 flex-col gap-1.5">
          <legend className="mb-1.5 text-[12px] font-medium text-pane-muted">{group.title}</legend>
          <div className={grid}>
            {group.fields.map((f) => (
              <label key={f.path.join(".")} className={cn("flex min-w-0 flex-col gap-1", f.wide && "col-span-full")}>
                <span className="px-3 text-[11.5px] text-pane-muted">{f.label}</span>
                {f.type === "date" ? (
                  <DateField label={f.label} value={read(draft, f.path)} onChange={(value) => setDraft((p) => write(p, f.path, value))} />
                ) : (
                  <input
                    type={f.type ?? "text"}
                    value={read(draft, f.path)}
                    placeholder={f.placeholder}
                    onChange={(e) => setDraft((p) => write(p, f.path, e.target.value))}
                    className={inputClass}
                  />
                )}
              </label>
            ))}
          </div>
        </fieldset>
      ))}

      <fieldset className="flex min-w-0 flex-col gap-1.5">
        <legend className="mb-1.5 text-[12px] font-medium text-pane-muted">Dependants</legend>
        {draft.dependants.map((d, i) => (
          <div key={d.id} className="blur-fade flex min-w-0 items-end gap-2" style={{ "--i": i } as React.CSSProperties}>
            <div className={cn(grid, "min-w-0 flex-1")}>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="px-3 text-[11.5px] text-pane-muted">Dependant {i + 1}</span>
                <input value={d.name} placeholder="Name" onChange={(e) => setDependant(d.id, { name: e.target.value })} className={inputClass} />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="px-3 text-[11.5px] text-pane-muted">Relationship</span>
                <input value={d.relationship} placeholder="Child" onChange={(e) => setDependant(d.id, { relationship: e.target.value })} className={inputClass} />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="px-3 text-[11.5px] text-pane-muted">Date of birth</span>
                <DateField label={`Dependant ${i + 1}: date of birth`} value={d.dateOfBirth} onChange={(dateOfBirth) => setDependant(d.id, { dateOfBirth })} />
              </label>
              <label className="flex min-w-0 flex-col gap-1">
                <span className="px-3 text-[11.5px] text-pane-muted">ID number</span>
                <input value={d.idNumber} onChange={(e) => setDependant(d.id, { idNumber: e.target.value })} className={inputClass} />
              </label>
            </div>
            <Tooltip label="Remove dependant">
              <button
                onClick={() => setDraft((p) => ({ ...p, dependants: p.dependants.filter((x) => x.id !== d.id) }))}
                aria-label={`Remove dependant ${i + 1}`}
                className="grid size-8 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
              >
                <Icon icon={Delete02Icon} size={15} />
              </button>
            </Tooltip>
          </div>
        ))}
        {draft.dependants.length < 20 ? (
          <button
            onClick={() =>
              setDraft((p) => ({
                ...p,
                dependants: [...p.dependants, { id: crypto.randomUUID().replace(/-/g, "").slice(0, 16), name: "", relationship: "", dateOfBirth: "", idNumber: "" }],
              }))
            }
            className="inline-flex h-8 items-center gap-1.5 self-start rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors hover:bg-pane-hover"
          >
            <Icon icon={Add01Icon} size={13} /> Add dependant
          </button>
        ) : null}
      </fieldset>

      {error ? <p className="text-[12.5px] text-warning">{error}</p> : null}
      {changed ? (
        <div className="blur-fade flex flex-wrap items-center justify-end gap-2">
          <button
            onClick={() => {
              setDraft(saved);
              setError(null);
            }}
            className="h-8 rounded-full px-3 text-[12.5px] text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
          >
            Discard
          </button>
          <button
            onClick={() => void save()}
            disabled={saving}
            className="flex h-8 items-center gap-1.5 rounded-full bg-pane-fg px-4 text-[12.5px] font-medium text-pane hover:opacity-90 disabled:opacity-40"
          >
            {saving ? <Spinner /> : null}
            {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
