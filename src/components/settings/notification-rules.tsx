"use client";

import { Add01Icon, Cancel01Icon, CrownIcon } from "@hugeicons/core-free-icons";
import type { PersonPrefs } from "@/lib/mail/person-prefs";
import { useShortcuts } from "@/lib/shortcuts";
import { cn } from "@/lib/utils";
import { Avatar } from "../mail/avatar";
import { Icon } from "../icon";
import { KeyCombo } from "../ui/kbd";
import { TimePicker } from "../ui/date-time-picker";
import { Tooltip } from "../ui/tooltip";

/** The batch delivery times as small pills (up to 6): a click opens the time list, + adds one. */
export function BatchTimes({ times, onChange }: { times: string[]; onChange: (times: string[]) => void }) {
  const save = (next: string[]) => onChange([...new Set(next.filter(Boolean))].sort());
  // + opens on the hour after the last batch (else 09:00), skipping times already there.
  const hours = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const last = times.length ? times[times.length - 1] : "08:00";
  const suggested = hours.find((h) => h > last && !times.includes(h)) ?? hours.find((h) => !times.includes(h)) ?? "09:00";
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {times.map((time, i) => (
        <span key={`${time}-${i}`} className="flex items-center gap-0.5 rounded-full border border-pane-border bg-pane-2 py-0.5 pl-1 pr-1 text-[12px]">
          <TimePicker
            label="Batch time"
            value={time}
            onChange={(next) => save(times.map((t, j) => (j === i ? next : t)))}
            trigger={(props) => (
              <button
                {...props}
                className={cn(
                  "rounded-full px-1.5 tabular-nums outline-none transition-colors duration-150 hover:text-accent focus-visible:text-accent",
                  props["aria-expanded"] && "text-accent",
                )}
              >
                {time}
              </button>
            )}
          />
          <Tooltip label="Remove this time">
            <button
              aria-label={`Remove ${time}`}
              onClick={() => save(times.filter((_, j) => j !== i))}
              className="grid size-5 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
            >
              <Icon icon={Cancel01Icon} size={11} />
            </button>
          </Tooltip>
        </span>
      ))}
      {times.length < 6 ? (
        <TimePicker
          label="Add a time"
          value={suggested}
          onChange={(time) => save([...times, time])}
          trigger={(props) => (
            <Tooltip label="Add a time">
              <button
                {...props}
                // Picking the time it opens on adds that time too.
                aria-label="Add a time"
                className={cn(
                  "grid size-6 place-items-center rounded-full border border-pane-border text-pane-muted hover:bg-pane-hover hover:text-pane-fg",
                  props["aria-expanded"] && "border-accent/60 text-pane-fg",
                )}
              >
                <Icon icon={Add01Icon} size={12} />
              </button>
            </Tooltip>
          )}
        />
      ) : null}
    </div>
  );
}

/** People marked VIP, with Remove. Marking happens in the People panel. */
export function VipList({ people, onRemove }: { people: Record<string, PersonPrefs>; onRemove: (email: string) => void }) {
  const { primary } = useShortcuts();
  const combo = primary("vip");
  const vips = Object.keys(people)
    .filter((email) => people[email].vip)
    .sort();
  return (
    <div data-setting="VIPs" className="flex flex-col gap-2 px-4 py-3.5">
      <p className="text-[13px] font-medium">VIPs</p>
      {vips.length ? (
        <ul className="flex flex-col gap-1">
          {vips.map((email) => (
            <li key={email} className="flex min-w-0 items-center gap-2.5 rounded-lg px-1 py-1" data-sensitive>
              <Avatar name={email} email={email} className="size-6 shrink-0 text-[10px]" />
              <span className="min-w-0 flex-1 truncate text-[12.5px]">{email}</span>
              <Icon icon={CrownIcon} size={13} className="shrink-0 fill-warning text-warning" />
              <Tooltip label="Remove from VIPs" className="shrink-0">
                <button
                  aria-label={`Remove ${email} from VIPs`}
                  onClick={() => onRemove(email)}
                  className="grid size-6 place-items-center rounded-full text-pane-muted hover:bg-pane-hover hover:text-pane-fg"
                >
                  <Icon icon={Cancel01Icon} size={12} />
                </button>
              </Tooltip>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] leading-snug text-pane-muted">
          No VIPs yet. Mark someone in the People panel
          {combo ? (
            <span className="ml-1 inline-flex items-center gap-1">
              (<KeyCombo combo={combo} keyClassName="bg-pane-2 text-pane-muted" />)
            </span>
          ) : null}
          .
        </p>
      )}
    </div>
  );
}
