import { NextResponse } from "next/server";
import { parseSearch } from "@/lib/mail/search";
import { inScope } from "@/lib/mail/scope";
import { errorResponse } from "@/server/errors";
import { mailAccounts } from "@/server/providers/registry";
import { threadsByIds } from "@/server/store";
import { searchRemote } from "@/server/sync";

export const runtime = "nodejs";

/**
 * "Search older mail": the same query on each provider's servers, for mail older than the local
 * copy. Found threads are added to the local store, so they stay searchable.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const terms = parseSearch(params.get("q") ?? "");
  if (!terms.length) return NextResponse.json({ error: "Type something to search for." }, { status: 400 });
  const accountId = params.get("account") || "all";
  const accounts = mailAccounts().filter((a) => inScope(accountId, a.id));
  if (!accounts.length) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  try {
    const ids = (await Promise.all(accounts.map((account) => searchRemote(account, terms)))).flat();
    return NextResponse.json({ threads: threadsByIds(ids) });
  } catch (error) {
    return errorResponse(error);
  }
}
