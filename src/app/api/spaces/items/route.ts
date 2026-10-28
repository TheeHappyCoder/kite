import { NextResponse } from "next/server";
import { SpaceItems } from "@/lib/spaces";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { listRules } from "@/server/rules";
import { listSpaces, moveItems, senderToSuggest } from "@/server/spaces";

export const runtime = "nodejs";

/**
 * Puts conversations in a space (`to`), takes them out of others (`from`), or both. Mail at the
 * provider is untouched. `suggest`: a sender whose mail keeps landing here and no automation of
 * yours puts there yet ("Always put their mail here?"); only an offer, nothing is made.
 */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const items = SpaceItems.parse(await request.json().catch(() => null));
    const memberships = moveItems(items);
    let suggest = items.to ? senderToSuggest(items.to, items.threads) : null;
    if (suggest && items.to) {
      const to = items.to;
      const email = suggest.email;
      const covered = listRules().some(
        (r) => r.actions.some((a) => a.verb === "space" && a.space === to) && r.conditions.some((c) => c.kind === "senders" && !c.negate && c.emails.some((e) => e.toLowerCase() === email)),
      );
      if (covered) suggest = null;
    }
    return NextResponse.json({ memberships, spaces: listSpaces(), suggest });
  } catch (error) {
    return errorResponse(error);
  }
}
