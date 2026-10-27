import { NextResponse } from "next/server";
import { automationExamples, automationRecipients, automationSenders } from "@/server/automation-examples";
import { rejectForeignHost } from "@/server/guard";

export const runtime = "nodejs";

/**
 * The automation wizard (local copy only, so only Kite's own pages read it): `?senders=1` lists who
 * writes to you; `?from=a@x,b@y&q=<search>` gives the newest emails from them as Read sees them.
 * With `&sent=1`, the same for mail you send: who you write to, and your own emails to them.
 */
export function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const params = new URL(request.url).searchParams;
  const sent = params.get("sent") === "1";
  if (params.get("senders") === "1") return NextResponse.json({ senders: sent ? automationRecipients() : automationSenders() });
  const senders = (params.get("from") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes("@"));
  return NextResponse.json({ examples: automationExamples({ senders, query: (params.get("q") ?? "").slice(0, 300), sent }) });
}
