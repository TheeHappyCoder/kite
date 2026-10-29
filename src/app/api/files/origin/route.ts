import * as z from "zod";
import { NextResponse } from "next/server";
import { findOrigin, SHA } from "@/server/file-origin";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";

export const runtime = "nodejs";

const Body = z.object({
  // No fingerprint: a file too big to hash, looked up by name only.
  // `part`: a file in the Kite drive, which knows its email (src-tauri/src/drive.rs).
  files: z.array(z.object({
    sha: z.string().regex(SHA).optional(),
    name: z.string().max(500),
    part: z.object({ accountId: z.string().max(200), messageId: z.string().max(500), partId: z.string().max(200) }).optional(),
  })).min(1).max(20),
});

/** The emails files on this computer came from: by fingerprint (hashed by the caller, the file never comes here), else by name. Read-only. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request) ?? rejectForeignHost(request);
  if (rejected) return rejected;
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid files" }, { status: 400 });
  return NextResponse.json({ results: parsed.data.files.map((f) => findOrigin(f.sha ?? null, f.name, f.part)) });
}
