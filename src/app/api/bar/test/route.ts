import { NextResponse } from "next/server";
import { rejectCrossSite } from "@/server/guard";
import { upsertActivity } from "@/server/bar/runtime";

export const runtime = "nodejs";

/** Settings → Kite bar → "Send a test": what an integration's activity looks like, from Kite itself. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const activity = upsertActivity(
    { id: "kite", name: "Kite" },
    {
      key: "test",
      title: "This is an integration",
      subtitle: "Any app or script can show things here",
      body: "With a token from Settings → Kite bar, a build, a timer, a deploy or anything else can drop down like this. Point your AI assistant at /api/bar to make one.",
      icon: "sparkles",
      tint: "accent",
      value: { type: "progress", progress: 0.6, label: "Looks like this" },
      actions: [{ type: "callback", label: "Nice", id: "nice" }],
      priority: "normal",
      duration: 30,
    },
  );
  return NextResponse.json({ id: activity.id });
}
