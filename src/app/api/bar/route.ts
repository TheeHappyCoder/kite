import { NextResponse } from "next/server";
import { BAR_API_VERSION, BAR_ICONS, BAR_TINTS, barSchema } from "@/lib/bar/spec";
import { rejectForeignHost } from "@/server/guard";
import { BAR_MAX_LIVE, BAR_RATE } from "@/server/bar/runtime";

export const runtime = "nodejs";

/**
 * The Kite bar API, describing itself: endpoints, rules and the activity's JSON Schema, so a
 * developer (or the AI assistant writing their integration) needs nothing else. docs/bar.md has
 * the same with examples. No token needed: nothing here is private.
 */
export async function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const origin = new URL(request.url).origin;
  return NextResponse.json({
    name: "Kite bar API",
    version: BAR_API_VERSION,
    about:
      "Show live activities from any app or script in the Kite bar, the strip of sky at the top of the screen in the Kite desktop app. Kite draws them in its own look from validated JSON (no HTML). Local only: requests must come from this computer.",
    auth: "Make a token in Kite → Settings → Kite bar → Add integration, then send `Authorization: Bearer <token>` with every request. Requests from web pages (with an Origin header) are refused.",
    endpoints: [
      { method: "POST", path: `${origin}/api/bar/activities`, body: "an activity (schema below)", returns: "{ id, key, expiresAt }", does: "Shows it, or updates the activity with the same key in place." },
      { method: "GET", path: `${origin}/api/bar/activities`, returns: "{ activities }", does: "Your activities still showing or waiting." },
      { method: "DELETE", path: `${origin}/api/bar/activities/{key}`, does: "Takes one away." },
      {
        method: "GET",
        path: `${origin}/api/bar/events`,
        returns: "text/event-stream of `data: {json}` lines",
        does: "What the user does: { type: 'action', key, action } for a callback button, { type: 'dismissed', key }, { type: 'expired', key }. Pings every 25 s.",
      },
    ],
    rules: [
      `Up to ${BAR_RATE} calls a minute and ${BAR_MAX_LIVE} live activities per integration. Update by key rather than sending new ones.`,
      "Activities live in memory: gone when they expire, are dismissed, or Kite restarts. Send again to bring one back.",
      "open_url takes https only and opens only when the user clicks. Nothing you send is ever run.",
      "priority passive arrives resting as one line; normal drops open for a moment; high also goes ahead of what's waiting. The user's quiet mode makes everything arrive resting.",
      "Long-lived activities (a build, a timer) take turns with whatever else is waiting, and come back.",
    ],
    icons: BAR_ICONS,
    tints: BAR_TINTS,
    schema: barSchema(),
    example: {
      key: "build-482",
      title: "Deploying kite-web",
      subtitle: "main · 3f2c1a9",
      icon: "deploy",
      value: { type: "progress", progress: 0.4, label: "Step 2 of 5" },
      actions: [
        { type: "open_url", label: "View logs", url: "https://ci.example.com/builds/482" },
        { type: "callback", label: "Cancel", id: "cancel" },
      ],
      duration: 900,
    },
  });
}
