import { NextResponse } from "next/server";
import { listContacts, searchContacts } from "@/server/contacts";
import { rejectForeignHost } from "@/server/guard";

export const runtime = "nodejs";

/**
 * Address suggestions from the local copy of your mail; `role=from|to` for a search's `from:` / `to:`.
 * `all=1`: everyone, for the Contacts view (only Kite's own pages may read the whole list).
 */
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("all") === "1") {
    const rejected = rejectForeignHost(request);
    if (rejected) return rejected;
    return NextResponse.json({ contacts: listContacts() });
  }
  const q = params.get("q") ?? "";
  const role = params.get("role");
  return NextResponse.json({ contacts: searchContacts(q.slice(0, 100), 8, role === "from" || role === "to" ? role : undefined) });
}
