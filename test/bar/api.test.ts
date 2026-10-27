import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as describeApi } from "@/app/api/bar/route";
import { GET as listMine, POST as show } from "@/app/api/bar/activities/route";
import { DELETE as takeAway } from "@/app/api/bar/activities/[key]/route";
import { POST as userActs } from "@/app/api/bar/act/route";
import { PATCH as changeIntegration } from "@/app/api/bar/integrations/route";
import type { BarIntegrationEvent } from "@/lib/bar/spec";
import { createIntegration } from "@/server/bar/integrations";
import { liveActivities, BAR_RATE, barEvents, onIntegrationEvent, type BarChange } from "@/server/bar/runtime";
import { updatePreferences } from "@/server/settings";

// The Kite bar API end to end, through its route handlers: a token, an activity shown and updated
// by key, what the user does reaching the integration, and every refusal explained.

const ORIGIN = "http://127.0.0.1:3100";

const call = (path: string, init: { method?: string; token?: string; body?: unknown; origin?: string } = {}) =>
  new Request(`${ORIGIN}${path}`, {
    method: init.method ?? "POST",
    headers: {
      host: "127.0.0.1:3100",
      "content-type": "application/json",
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.origin ? { origin: init.origin } : {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

const params = (key: string) => ({ params: Promise.resolve({ key }) });

/** Every change the shell would hear while `run` runs. */
async function heard(run: () => Promise<unknown>) {
  const changes: BarChange[] = [];
  const listen = (change: BarChange) => changes.push(change);
  barEvents.on("bar", listen);
  try {
    await run();
  } finally {
    barEvents.off("bar", listen);
  }
  return changes;
}

afterEach(() => vi.useRealTimers());

describe("the Kite bar API", () => {
  it("describes itself with the activity's JSON Schema", async () => {
    const res = await describeApi(call("/api/bar", { method: "GET" }));
    const body = (await res.json()) as { schema: { properties: Record<string, unknown> }; endpoints: unknown[] };
    expect(res.status).toBe(200);
    expect(Object.keys(body.schema.properties)).toEqual(expect.arrayContaining(["key", "title", "value", "actions", "priority", "duration"]));
    expect(body.endpoints.length).toBeGreaterThanOrEqual(4);
  });

  it("shows an activity, updates it in place by key, and takes it away", async () => {
    const { integration, token } = createIntegration("CI");
    const first = await heard(async () => {
      const res = await show(call("/api/bar/activities", { token, body: { key: "build", title: "Building", value: { type: "progress", progress: 0.2 } } }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ id: `${integration.id}:build`, key: "build" });
    });
    expect(first).toEqual([expect.objectContaining({ op: "show", activity: expect.objectContaining({ title: "Building", source: { id: integration.id, name: "CI" } }) })]);

    const update = await heard(() => show(call("/api/bar/activities", { token, body: { key: "build", title: "Building", value: { type: "progress", progress: 0.9 } } })));
    expect(update).toEqual([expect.objectContaining({ op: "show", activity: expect.objectContaining({ id: `${integration.id}:build`, value: { type: "progress", progress: 0.9 } }) })]);
    expect(liveActivities(integration.id)).toHaveLength(1);

    const mine = (await (await listMine(call("/api/bar/activities", { method: "GET", token }))).json()) as { activities: unknown[] };
    expect(mine.activities).toHaveLength(1);

    const gone = await heard(() => takeAway(call("/api/bar/activities/build", { method: "DELETE", token }), params("build")));
    expect(gone).toEqual([{ op: "remove", id: `${integration.id}:build` }]);
    expect((await takeAway(call("/api/bar/activities/build", { method: "DELETE", token }), params("build"))).status).toBe(404);
  });

  it("tells the integration what the user did: a callback, then closing it", async () => {
    const { integration, token } = createIntegration("Deploys");
    await show(call("/api/bar/activities", { token, body: { key: "d1", title: "Deploy failed", actions: [{ type: "callback", label: "Retry", id: "retry" }] } }));
    const events: BarIntegrationEvent[] = [];
    const stop = onIntegrationEvent(integration.id, (event) => events.push(event));
    const id = `${integration.id}:d1`;

    expect((await userActs(call("/api/bar/act", { origin: ORIGIN, body: { id, action: "retry" } }))).status).toBe(200);
    // Only its own buttons: a made-up action is refused.
    expect((await userActs(call("/api/bar/act", { origin: ORIGIN, body: { id, action: "rm-rf" } }))).status).toBe(404);
    expect((await userActs(call("/api/bar/act", { origin: ORIGIN, body: { id, action: "dismiss" } }))).status).toBe(200);
    stop();
    expect(events).toEqual([
      { type: "action", key: "d1", action: "retry" },
      { type: "dismissed", key: "d1" },
    ]);
    expect(liveActivities(integration.id)).toHaveLength(0);
  });

  it("lets an activity expire, and says so", async () => {
    vi.useFakeTimers();
    const { integration, token } = createIntegration("Timer");
    await show(call("/api/bar/activities", { token, body: { key: "tea", title: "Tea", duration: 5 } }));
    const events: BarIntegrationEvent[] = [];
    const stop = onIntegrationEvent(integration.id, (event) => events.push(event));
    const changes = await heard(async () => vi.advanceTimersByTime(5_000));
    stop();
    expect(changes).toEqual([{ op: "remove", id: `${integration.id}:tea` }]);
    expect(events).toEqual([{ type: "expired", key: "tea" }]);
  });

  it("explains every problem in a request it can't show", async () => {
    const { token } = createIntegration("Sloppy");
    const res = await show(
      call("/api/bar/activities", {
        token,
        body: { title: "", icon: "skull", actions: [{ type: "open_url", label: "Go", url: "http://example.com" }], value: { type: "progress", progress: 2 } },
      }),
    );
    const body = (await res.json()) as { problems: string[] };
    expect(res.status).toBe(400);
    expect(body.problems.join("\n")).toMatch(/title/);
    expect(body.problems.join("\n")).toMatch(/icon/);
    expect(body.problems.join("\n")).toMatch(/actions\.0\.url: Use an https:\/\/ address/);
    expect(body.problems.join("\n")).toMatch(/value\.progress/);
  });

  it("refuses web pages, unknown tokens, paused integrations and integrations turned off", async () => {
    const { integration, token } = createIntegration("Guarded");
    const body = { title: "Hi" };
    expect((await show(call("/api/bar/activities", { token, body, origin: "https://evil.example" }))).status).toBe(403);
    expect((await show(call("/api/bar/activities", { body }))).status).toBe(401);
    expect((await show(call("/api/bar/activities", { token: "kite_bar_nope", body }))).status).toBe(401);

    await changeIntegration(call("/api/bar/integrations", { method: "PATCH", origin: ORIGIN, body: { id: integration.id, enabled: false } }));
    const paused = await show(call("/api/bar/activities", { token, body }));
    expect(paused.status).toBe(403);
    expect(((await paused.json()) as { error: string }).error).toMatch(/paused/);
    await changeIntegration(call("/api/bar/integrations", { method: "PATCH", origin: ORIGIN, body: { id: integration.id, enabled: true } }));

    updatePreferences({ bar: { integrations: false } });
    expect((await show(call("/api/bar/activities", { token, body }))).status).toBe(403);
    updatePreferences({ bar: { integrations: true } });
    expect((await show(call("/api/bar/activities", { token, body }))).status).toBe(200);
  });

  it("slows down an integration that sends too much", async () => {
    const { token } = createIntegration("Chatty");
    for (let i = 0; i < BAR_RATE; i++) await show(call("/api/bar/activities", { token, body: { key: "same", title: `Update ${i}` } }));
    const res = await show(call("/api/bar/activities", { token, body: { key: "same", title: "One too many" } }));
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toMatch(/Slow down/);
  });
});
