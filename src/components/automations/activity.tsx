"use client";

import { useState } from "react";
import { format } from "date-fns";
import { type RuleRunView } from "@/lib/rules/spec";
import { cn } from "@/lib/utils";
import { buttonClass } from "./builder-ui";

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

type Group = { key: string; ruleName: string; at: string; done: string[]; runs: RuleRunView[]; existing: boolean };

function groupRuns(runs: RuleRunView[]): Group[] {
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const key = run.batchId ?? `${run.ruleId}:${run.at.slice(0, 10)}`;
    const group = groups.get(key) ?? { key, ruleName: run.ruleName, at: run.at, done: [], runs: [], existing: run.trigger === "existing" };
    group.runs.push(run);
    run.done.forEach((d) => !group.done.includes(d) && group.done.push(d));
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function Activity({ runs, onUndo }: { runs: RuleRunView[]; onUndo: (ids: string[]) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  const groups = groupRuns(runs).slice(0, 30);
  return (
    <div className="mt-3 flex flex-col gap-2">
      <p className="text-[13px] font-medium">Activity</p>
      {groups.length ? (
        <div className="flex flex-col divide-y divide-pane-border rounded-xl border border-pane-border">
          {groups.map((g) => {
            const pending = g.runs.filter((r) => r.undoable && !r.undoneAt);
            const failed = g.runs.some((r) => r.failed);
            return (
              <div key={g.key} className="flex min-w-0 flex-col px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-3">
                  <button onClick={() => setOpen(open === g.key ? null : g.key)} className="min-w-0 flex-1 text-left">
                    <span className="block truncate text-[12.5px]">
                      <span className="font-medium">{g.ruleName}</span> {g.done.join(", ") || (failed ? "couldn't change" : "ran on")} {g.runs.length} conversation
                      {g.runs.length === 1 ? "" : "s"}
                      {g.existing ? " (existing mail)" : ""}
                    </span>
                    <span className={cn("block text-[11.5px]", failed ? "text-warning" : "text-pane-muted")}>
                      {format(new Date(g.at), "d MMM, HH:mm")}
                      {g.runs.some((r) => r.inGmail) ? " · Gmail's filter did it before Kite saw the mail" : ""}
                      {failed ? " · Gmail didn't accept some changes" : ""}
                    </span>
                  </button>
                  {pending.length ? (
                    <button onClick={() => onUndo(pending.map((r) => r.id))} className={buttonClass}>
                      Undo
                    </button>
                  ) : g.runs.some((r) => r.undoneAt) ? (
                    <span className="shrink-0 text-[12px] text-pane-muted">Undone</span>
                  ) : null}
                </div>
                {open === g.key ? (
                  <ul data-sensitive className="blur-fade mt-1.5 flex flex-col gap-0.5">
                    {g.runs.map((r) => (
                      <li key={r.id} className="truncate text-[12px] text-pane-muted">
                        {r.subject}
                        {r.undoneAt ? " (undone)" : ""}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[12px] text-pane-muted">Nothing yet. When an automation changes mail, it shows here with Undo.</p>
      )}
    </div>
  );
}
