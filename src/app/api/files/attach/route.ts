import { NextResponse } from "next/server";
import { EMAIL } from "@/lib/mail/compose";
import { REMOTE_ID, THREAD_KEY } from "@/lib/mail/threads";
import type { Attachment } from "@/lib/mail/types";
import { attachCandidates, rowsHolding } from "@/server/store";

export const runtime = "nodejs";

const KINDS: Attachment["kind"][] = ["pdf", "doc", "sheet", "image", "other"];

/**
 * Files to offer in compose ("Attach from your files"), grouped and ordered: this conversation
 * (`thread`, a Kite thread id, or `account` + `remote`, the Gmail thread a reopened draft
 * replies in), then files exchanged with `people`, then recent ones. Read-only.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const threadIds = new Set<string>();
  const thread = params.get("thread") ?? "";
  const split = thread.indexOf(":");
  if (split > 0 && THREAD_KEY.test(thread.slice(split + 1))) threadIds.add(thread);
  const account = params.get("account") ?? "";
  const remote = params.get("remote") ?? "";
  if (account && REMOTE_ID.test(remote)) {
    for (const { row } of rowsHolding(account, remote)) threadIds.add(row.id);
  }
  const people = (params.get("people") ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => EMAIL.test(e))
    .slice(0, 20);
  const kind = params.get("kind") as Attachment["kind"] | null;
  const files = attachCandidates({
    threadIds: [...threadIds],
    people,
    query: params.get("q")?.trim().slice(0, 200) ?? "",
    kind: kind && KINDS.includes(kind) ? kind : null,
  });
  return NextResponse.json(files);
}
