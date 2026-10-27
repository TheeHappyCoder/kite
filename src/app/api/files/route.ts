import { getAccount } from "@/server/db";
import { getAttachment } from "@/server/attachments";
import { searchableDocument, indexDocument } from "@/server/document-text";
import { rejectCrossSite } from "@/server/guard";
import * as z from "zod";
import { NextResponse } from "next/server";
import type { Attachment } from "@/lib/mail/types";
import { listFiles } from "@/server/store";

export const runtime = "nodejs";

const KINDS: Attachment["kind"][] = ["pdf", "doc", "sheet", "image", "other"];

/** Attachments across the local copy of the mail, newest first. Inline images are left out. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const kind = params.get("kind") as Attachment["kind"] | null;
  const files = listFiles({
    accountId: params.get("account") || "all",
    query: params.get("q")?.trim() ?? "",
    kind: kind && KINDS.includes(kind) ? kind : null,
  });
  return NextResponse.json({ files });
}

/** Explicit local extraction; downloads only the requested account scope from its own provider. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = z.object({ account: z.string().max(2000), offset: z.number().int().min(0).max(1000000).default(0) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid file scope" }, { status: 400 });
  const files = listFiles({ accountId: parsed.data.account, query: "", kind: null, limit: 11, offset: parsed.data.offset });
  let indexed = 0, failed = 0;
  for (const file of files.slice(0, 10)) {
    if (!file.messageId || !file.partId || !searchableDocument(file.name)) continue;
    const account = getAccount(file.accountId);
    if (!account) continue;
    try { const bytes = await getAttachment(account, file.messageId, file.partId, file.name); await indexDocument(account.id, file.messageId, file.partId, bytes); indexed++; }
    catch { failed++; }
  }
  return NextResponse.json({ indexed, failed, next: files.length > 10 ? parsed.data.offset + 10 : null });
}
