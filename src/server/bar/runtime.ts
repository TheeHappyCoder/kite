import "server-only";

import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { BarActivity, BarActivitySpec, BarIntegrationEvent } from "@/lib/bar/spec";

// The Kite bar's live activities from integrations (docs/bar.md): kept in memory only, gone when they
// expire, are dismissed, or Kite restarts. Each change goes out on `barEvents` ("bar"), which
// sync.ts re-emits on /api/events for the desktop shell; what the user does with an activity goes
// back to its integration ("integration:<id>", read by GET /api/bar/events). Never imports sync.ts.

/** What the shell hears (src-tauri/src/bar.rs): show (new or updated in place) or remove. */
export type BarChange = { op: "show"; activity: BarActivity } | { op: "remove"; id: string };

/** Calls per integration per minute, and activities one integration may have live at once. */
export const BAR_RATE = 60;
export const BAR_MAX_LIVE = 20;

type Source = { id: string; name: string };
type State = {
  live: Map<string, BarActivity>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
  calls: Map<string, number[]>;
  events: EventEmitter;
};

const g = globalThis as typeof globalThis & { __kiteBarRuntime?: State };
const state: State = (g.__kiteBarRuntime ??= { live: new Map(), timers: new Map(), calls: new Map(), events: new EventEmitter().setMaxListeners(0) });

export const barEvents = state.events;

/** Refused for being too much at once; the message says what to do. */
export class BarLimit extends Error {}

const tell = (sourceId: string, event: BarIntegrationEvent) => state.events.emit(`integration:${sourceId}`, event);

function forget(id: string) {
  clearTimeout(state.timers.get(id));
  state.timers.delete(id);
  return state.live.delete(id);
}

/** Shows an activity, or updates the one with the same key in place. */
export function upsertActivity(source: Source, spec: BarActivitySpec, now = Date.now()): BarActivity {
  const recent = (state.calls.get(source.id) ?? []).filter((at) => now - at < 60_000);
  if (recent.length >= BAR_RATE) throw new BarLimit(`Slow down: up to ${BAR_RATE} calls a minute per integration. Update one activity by its key instead of sending new ones.`);
  recent.push(now);
  state.calls.set(source.id, recent);

  const key = spec.key ?? randomUUID().slice(0, 8);
  const id = `${source.id}:${key}`;
  if (!state.live.has(id) && [...state.live.values()].filter((a) => a.source.id === source.id).length >= BAR_MAX_LIVE) {
    throw new BarLimit(`Up to ${BAR_MAX_LIVE} activities at once per integration. Remove finished ones (DELETE /api/bar/activities/<key>) or reuse a key.`);
  }
  const activity: BarActivity = {
    ...spec,
    key,
    id,
    source,
    updatedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + spec.duration * 1000).toISOString(),
  };
  forget(id);
  state.live.set(id, activity);
  state.timers.set(
    id,
    setTimeout(() => {
      if (!forget(id)) return;
      state.events.emit("bar", { op: "remove", id } satisfies BarChange);
      tell(source.id, { type: "expired", key });
    }, spec.duration * 1000),
  );
  state.events.emit("bar", { op: "show", activity } satisfies BarChange);
  return activity;
}

/** The integration took its activity away. */
export function removeActivity(sourceId: string, key: string) {
  const id = `${sourceId}:${key}`;
  if (!forget(id)) return false;
  state.events.emit("bar", { op: "remove", id } satisfies BarChange);
  return true;
}

/** Every activity of an integration, gone (it was paused or removed). */
export function removeSource(sourceId: string) {
  for (const activity of [...state.live.values()]) if (activity.source.id === sourceId) removeActivity(sourceId, activity.key);
  state.calls.delete(sourceId);
}

/** The user closed it in the Kite bar: its integration hears so. */
export function dismissActivity(id: string) {
  const activity = state.live.get(id);
  if (!activity || !forget(id)) return false;
  tell(activity.source.id, { type: "dismissed", key: activity.key });
  return true;
}

/** The user clicked one of its callback actions: its integration hears which. */
export function actOn(id: string, actionId: string) {
  const activity = state.live.get(id);
  if (!activity?.actions.some((a) => a.type === "callback" && a.id === actionId)) return false;
  tell(activity.source.id, { type: "action", key: activity.key, action: actionId });
  return true;
}

export function liveActivities(sourceId?: string) {
  return [...state.live.values()].filter((a) => !sourceId || a.source.id === sourceId);
}

/** Follows what the user does with one integration's activities (GET /api/bar/events). */
export function onIntegrationEvent(sourceId: string, listener: (event: BarIntegrationEvent) => void) {
  state.events.on(`integration:${sourceId}`, listener);
  return () => void state.events.off(`integration:${sourceId}`, listener);
}
