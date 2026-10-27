import { NextResponse } from "next/server";
import { scopeIds } from "@/lib/mail/scope";
import { freshCodes } from "@/server/codes";
import { listAccounts } from "@/server/db";
import { rejectForeignHost } from "@/server/guard";
import { collectHome } from "@/server/home";
import { collectReplies } from "@/server/replies";

export const runtime = "nodejs";

/** Home: people (To reply, Waiting on), machine mail as facts, the reading shelf, and fresh codes. Read-only, from the local copy. */
export async function GET(request: Request) {
  // Fresh codes ride along, so only Kite's own pages may read this.
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const scope = new URL(request.url).searchParams.get("account") || "all";
  const ids = new Set(scopeIds(scope) ?? listAccounts().map((a) => a.id));
  const now = Date.now();
  const people = collectReplies(ids, now);
  const codes = freshCodes(3).filter((c) => !c.threadId || [...ids].some((id) => c.threadId.startsWith(`${id}:`)));
  return NextResponse.json({ people, ...collectHome(ids, people, now), codes });
}
