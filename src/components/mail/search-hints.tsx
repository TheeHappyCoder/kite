"use client";

import { Cancel01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { SEARCH_OPERATORS, type ContactToken } from "@/lib/mail/search";
import type { SavedSearch } from "@/lib/settings";
import { Icon } from "../icon";
import { Tooltip } from "../ui/tooltip";

import { FLUID_IGNORE, FLUID_ITEM, FluidList } from "../ui/fluid-hover";
import type { Recipient } from "@/lib/mail/compose";
import { Avatar } from "./avatar";

/**
 * Under the search field while a `from:` or `to:` is typed: people from your mail who match,
 * picked with the mouse or ↑ ↓ and Enter / Tab. Picking writes their address after the operator.
 */
export function ContactHints({
  token,
  people,
  active,
  onHover,
  onPick,
}: {
  token: ContactToken;
  /** Null while they're being looked up. */
  people: Recipient[] | null;
  active: number;
  onHover: (index: number) => void;
  onPick: (person: Recipient) => void;
}) {
  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      className="blur-fade-down absolute inset-x-0 top-full z-20 mt-1.5 rounded-2xl border border-pane-border bg-pane-raised p-2 shadow-xl"
    >
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">
        {token.role === "from" ? "People who write to you" : "People you write to"}
      </div>
      {!token.value ? (
        <p className="px-2 pb-1 pt-0.5 text-[12px] text-pane-muted">Type part of a name or address.</p>
      ) : people && !people.length ? (
        <p className="px-2 pb-1 pt-0.5 text-[12px] text-pane-muted">No one in your mail matches “{token.value}”.</p>
      ) : (
        <FluidList tone="pane" follow="[data-selected=true]" className="flex flex-col">
          {(people ?? []).map((person, i) => (
            <button
              key={person.email}
              {...FLUID_ITEM}
              data-selected={i === active}
              onPointerMove={() => i !== active && onHover(i)}
              onClick={() => onPick(person)}
              className="relative flex h-10 min-w-0 items-center gap-2.5 rounded-lg px-2 text-left touch:h-12"
            >
              <span data-sensitive className="flex shrink-0">
                <Avatar name={person.name ?? person.email} email={person.email} className="size-6 text-[9px]" />
              </span>
              <span data-sensitive className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">{person.name || person.email}</span>
                {person.name ? <span className="block truncate text-[11.5px] text-pane-muted">{person.email}</span> : null}
              </span>
            </button>
          ))}
        </FluidList>
      )}
    </div>
  );
}

/** Opens under the empty search field: saved searches, then the operators you can type. */
export function SearchHints({
  saved,
  onPick,
  onInsert,
  onRemove,
}: {
  saved: SavedSearch[];
  onPick: (query: string) => void;
  onInsert: (text: string) => void;
  onRemove: (id: string) => void;
}) {
  return (
    <div
      // Clicks here must not blur the search field (which closes this).
      onMouseDown={(e) => e.preventDefault()}
      className="blur-fade-down absolute inset-x-0 top-full z-20 mt-1.5 rounded-2xl border border-pane-border bg-pane-raised p-2 shadow-xl"
    >
      {saved.length ? (
        <>
          <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">Saved searches</div>
          <FluidList tone="pane" className="mb-1.5 flex flex-col">
            {saved.map((s) => (
              <div key={s.id} {...FLUID_ITEM} className="group relative flex h-8 items-center gap-2 rounded-lg px-2">
                <button onClick={() => onPick(s.query)} className="flex min-w-0 flex-1 items-center gap-2 text-left text-[13px]">
                  <Icon icon={Search01Icon} size={14} className="shrink-0 text-pane-muted" />
                  <span className="truncate">{s.name}</span>
                  {s.name !== s.query ? <span className="truncate tabular-nums text-[11.5px] text-pane-muted">{s.query}</span> : null}
                </button>
                <Tooltip label="Remove saved search">
                  <button
                    {...FLUID_IGNORE}
                    aria-label="Remove saved search"
                    onClick={() => onRemove(s.id)}
                    className="grid size-6 place-items-center rounded-full text-pane-muted opacity-0 hover:bg-pane-2 hover:text-pane-fg group-hover:opacity-100"
                  >
                    <Icon icon={Cancel01Icon} size={12} />
                  </button>
                </Tooltip>
              </div>
            ))}
          </FluidList>
        </>
      ) : null}
      <div className="px-2 pb-1 pt-0.5 text-[11px] font-medium uppercase tracking-[0.08em] text-pane-muted">Search with</div>
      <FluidList tone="pane" className="flex flex-col">
        {SEARCH_OPERATORS.map((op, i) => (
          <button
            key={op.insert}
            {...FLUID_ITEM}
            onClick={() => onInsert(op.insert)}
            style={{ "--i": i, "--blur-fade-step": "18ms" } as React.CSSProperties}
            className="blur-fade relative flex h-7 min-w-0 items-center justify-between gap-3 rounded-lg px-2 text-left text-[12.5px]"
          >
            <span className="truncate">{op.label}</span>
            <span className="truncate tabular-nums text-[11px] text-pane-muted">{op.example}</span>
          </button>
        ))}
      </FluidList>
      <p className="px-2 pb-0.5 pt-2 text-[11.5px] text-pane-muted">
        Put <span className="tabular-nums">-</span> in front to leave things out, and &quot;quotes&quot; for an exact phrase.
      </p>
    </div>
  );
}
