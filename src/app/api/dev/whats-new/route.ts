import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

/** Development only: the newest release's notes (docs/whats-new/<version>/notes.md), for `?update-demo`, its pictures through the route beside this one. */
export async function GET() {
  if (process.env.NODE_ENV === "production") return new NextResponse(null, { status: 404 });
  const folder = join(process.cwd(), "docs", "whats-new");
  const versions = (await readdir(folder)).filter((name) => /^\d+\.\d+\.\d+$/.test(name));
  const version = versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
  if (!version) return new NextResponse(null, { status: 404 });
  const notes = await readFile(join(folder, version, "notes.md"), "utf8");
  return NextResponse.json({ version, notes: notes.replace(/^media:\s*(\S+)\s*$/gim, `media: /api/dev/whats-new/${version}/$1`) });
}
