import { NextResponse } from "next/server";
import { drivePreview, driveTree } from "@/server/drive";
import { rejectForeignHost } from "@/server/guard";
import { getPreferences } from "@/server/settings";

export const runtime = "nodejs";

/**
 * The Kite drive's whole tree for the desktop shell (src-tauri/src/drive.rs): `?since=<version>`
 * answers 204 when nothing changed. `?preview=1`: a small copy for Settings → Files, on or off. Read-only.
 */
export async function GET(request: Request) {
  // File names and people: only Kite's own host.
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const params = new URL(request.url).searchParams;
  const headers = { "cache-control": "no-store" };
  if (params.get("preview")) return NextResponse.json({ preview: drivePreview() }, { headers });
  if (!getPreferences().drive.on) return NextResponse.json({ on: false, version: "", entries: [] }, { headers });
  const tree = driveTree();
  if (params.get("since") === tree.version) return new NextResponse(null, { status: 204 });
  return NextResponse.json({ on: true, ...tree }, { headers });
}
