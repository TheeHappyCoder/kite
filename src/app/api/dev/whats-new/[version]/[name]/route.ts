import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const TYPES: Record<string, string> = { webp: "image/webp", gif: "image/gif", png: "image/png", jpg: "image/jpeg" };

/**
 * Development only: a release's What's new pictures from docs/whats-new/<version>/ (recorded by
 * scripts/whats-new-media.mjs), for `?update-demo`. A release links the website's copies instead.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ version: string; name: string }> }) {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
  const { version, name } = await params;
  const type = TYPES[name.split(".").pop() ?? ""];
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-z0-9-]+\.[a-z]+$/.test(name) || !type) return new NextResponse(null, { status: 404 });
  try {
    const data = await readFile(join(process.cwd(), "docs", "whats-new", version, name));
    return new NextResponse(new Uint8Array(data), { headers: { "content-type": type, "x-content-type-options": "nosniff" } });
  } catch {
    return new NextResponse(null, { status: 404 });
  }
}
