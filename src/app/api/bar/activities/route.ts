import { NextResponse } from "next/server";
import { BarActivityInput } from "@/lib/bar/spec";
import { authorize } from "@/server/bar/integrations";
import { liveActivities, BarLimit, upsertActivity } from "@/server/bar/runtime";

export const runtime = "nodejs";

/** An integration shows an activity, or updates its own by key (docs/bar.md). */
export async function POST(request: Request) {
  const auth = authorize(request);
  if ("refused" in auth) return auth.refused;
  const body = await request.json().catch(() => undefined);
  if (body === undefined) return NextResponse.json({ error: "Send the activity as JSON (content-type: application/json)." }, { status: 400 });
  const parsed = BarActivityInput.safeParse(body);
  if (!parsed.success) {
    // Every problem, each with where it is: enough to fix the request without reading the docs.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".") || "activity"}: ${issue.message}`);
    return NextResponse.json({ error: problems[0], problems, docs: "/api/bar" }, { status: 400 });
  }
  try {
    const activity = upsertActivity({ id: auth.integration.id, name: auth.integration.name }, parsed.data);
    return NextResponse.json({ id: activity.id, key: activity.key, expiresAt: activity.expiresAt });
  } catch (error) {
    if (error instanceof BarLimit) return NextResponse.json({ error: error.message }, { status: 429 });
    throw error;
  }
}

/** The integration's activities still showing or waiting. */
export async function GET(request: Request) {
  const auth = authorize(request);
  if ("refused" in auth) return auth.refused;
  return NextResponse.json({ activities: liveActivities(auth.integration.id) });
}
