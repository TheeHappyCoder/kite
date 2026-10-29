import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Development only: a release's What's new pictures from docs/whats-new/<version>/ (recorded by
 * scripts/whats-new-media.mjs), for `?update-demo`. A release links the website's copies instead.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ version: string; name: string }> }) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
  const { version, name } = await params;
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-z0-9-]+\.webp$/.test(name)) return new NextResponse(null, { status: 404 });
  try {
    const data = await readFile(join(process.cwd(), "docs", "whats-new", version, name));
    return new NextResponse(new Uint8Array(data), { headers: { "content-type": "image/webp", "x-content-type-options": "nosniff" } });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
