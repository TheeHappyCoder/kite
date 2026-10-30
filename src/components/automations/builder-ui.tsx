"use client";

import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { fetchJson } from "@/lib/fetch-json";
import { TRIGGER_VERBS, VERBS, type Trigger } from "@/lib/rules/spec";
import { cn } from "@/lib/utils";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";

export const buttonClass =
  "inline-flex h-8 items-center gap-1.5 rounded-full border border-pane-border px-3.5 text-[12.5px] font-medium transition-colors hover:bg-pane-hover disabled:opacity-40";

export const inputClass = "h-8 min-w-0 rounded-full border border-pane-border bg-transparent px-3 text-[12.5px] outline-none placeholder:text-pane-muted focus:border-accent/60";

export type Blank = { key: string; label: string };

export const request = <T,>(url: string, method: string, body?: unknown) => fetchJson<T>(url, method, body, "That didn't work. Try again.");

export const verbOptions = (trigger: Trigger) => TRIGGER_VERBS[trigger].map((v) => ({ value: v, label: VERBS[v].label }));

/** One step of a rule: a numbered dot on a rail that runs down to the next step. */
export function Step({ n, title, note, last, children }: { n: number; title: string; note?: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-3">
      <div className="flex shrink-0 flex-col items-center">
        <span className="grid size-6 place-items-center rounded-full bg-accent-soft text-[11.5px] font-semibold text-accent">{n}</span>
        {last ? null : <span className="my-1 w-px flex-1 bg-pane-border" />}
      </div>
      <div className={cn("flex min-w-0 flex-1 flex-col gap-2.5", !last && "pb-5")}>
        <div className="pt-0.5">
          <p className="text-[13.5px] font-semibold tracking-tight">{title}</p>
          {note ? <p className="text-[11.5px] text-pane-muted">{note}</p> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

export function AddButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="flex items-center gap-1 self-start rounded-full py-0.5 text-[12px] font-medium text-accent transition-opacity hover:opacity-80">
      <Icon icon={Add01Icon} size={12} />
      {children}
    </button>
  );
}

export function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip label={label}>
      <button aria-label={label} onClick={onClick} className="grid size-7 shrink-0 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg">
        <Icon icon={Cancel01Icon} size={12} />
      </button>
    </Tooltip>
  );
}
