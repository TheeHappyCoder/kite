import { NextResponse } from "next/server";
import { ATTACHMENT_LIMIT_BYTES, attachmentLimitError } from "@/lib/mail/compose";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { removeUploads, saveUpload } from "@/server/uploads";

export const runtime = "nodejs";

/** Stores a file for an outgoing message. Raw bytes in the body; name and type in headers. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request, { binary: true });
  if (rejected) return rejected;
  let name = "attachment";
  try {
    name = decodeURIComponent(request.headers.get("x-file-name") ?? "attachment");
  } catch {}
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > ATTACHMENT_LIMIT_BYTES + 1024) {
    return NextResponse.json({ error: attachmentLimitError(name, declared, 0) }, { status: 413 });
  }
  try {
    const data = Buffer.from(await request.arrayBuffer());
    const tooBig = attachmentLimitError(name, data.length, 0);
    if (tooBig) return NextResponse.json({ error: tooBig }, { status: 413 });
    const upload = await saveUpload(name, request.headers.get("x-file-type") ?? "", data);
    return NextResponse.json({ upload });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Removes a file taken off a message before it was sent. */
export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const id = new URL(request.url).searchParams.get("id") ?? "";
  await removeUploads([id]);
  return NextResponse.json({ ok: true });
}
