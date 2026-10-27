import { NextResponse } from "next/server";
import { AttachmentError, getAttachment } from "@/server/attachments";
import { getAccount } from "@/server/db";
import { errorResponse } from "@/server/errors";

export const runtime = "nodejs";

type Context = { params: Promise<{ account: string; message: string; part: string }> };

/** Types Kite will show in the browser. Anything else (HTML, SVG, scripts, Office files) only downloads. */
const VIEWABLE = /^(image\/(png|jpeg|gif|webp|bmp|avif)|application\/pdf|text\/plain|text\/csv|audio\/[\w.+-]+|video\/(mp4|webm|ogg))$/;

function disposition(type: "inline" | "attachment", name: string) {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** Opens (or with ?download=1, saves) an attachment. Fetched from Gmail once, then served from the local copy. */
export async function GET(request: Request, { params }: Context) {
  const { account: accountId, message, part } = await params;
  const search = new URL(request.url).searchParams;
  const account = getAccount(accountId);
  if (!account) return NextResponse.json({ error: "Unknown account" }, { status: 404 });
  try {
    const file = await getAttachment(account, message, part, search.get("name") ?? undefined);
    const viewable = VIEWABLE.test(file.mimeType) && search.get("download") !== "1";
    const headers: Record<string, string> = {
      "content-type": viewable ? (file.mimeType.startsWith("text/") ? `${file.mimeType}; charset=utf-8` : file.mimeType) : "application/octet-stream",
      "content-disposition": disposition(viewable ? "inline" : "attachment", file.name),
      "content-length": String(file.data.length),
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
    };
    // Mail attachments are untrusted. Chrome's PDF viewer won't run inside a sandbox, and it never runs a PDF's scripts on Kite's origin.
    if (file.mimeType !== "application/pdf" || !viewable) {
      headers["content-security-policy"] = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox";
    }
    return new Response(new Uint8Array(file.data), { headers });
  } catch (error) {
    if (error instanceof AttachmentError) return NextResponse.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
