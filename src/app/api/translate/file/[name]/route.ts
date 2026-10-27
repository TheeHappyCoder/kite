import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { rejectForeignHost } from "@/server/guard";
import { translationFile } from "@/server/translate";

export const runtime = "nodejs";

/** A downloaded engine or model file, for the translation worker (lib/translate/worker.ts). Never cached elsewhere. */
export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const foreign = rejectForeignHost(request);
  if (foreign) return foreign;
  const file = translationFile((await params).name);
  if (!file) return NextResponse.json({ error: "Not downloaded" }, { status: 404 });
  const bytes = await readFile(file);
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "content-type": file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream",
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}
