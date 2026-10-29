import { NextResponse } from "next/server";
import { SpacePatch } from "@/lib/spaces";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { removeAsset } from "@/server/assets";
import { deleteSpace, listSpaces, logoInUse, updateSpace } from "@/server/spaces";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Renames a space, changes its colour, logo or note, or moves it inside another. A logo nothing wears any more is deleted. */
export async function PATCH(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const before = listSpaces().find((s) => s.id === id)?.logo ?? null;
    const space = updateSpace(id, SpacePatch.parse(await request.json().catch(() => null)));
    if (before && before !== space.logo && !logoInUse(before)) await removeAsset(before);
    return NextResponse.json({ space, spaces: listSpaces() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Deletes a space and its pockets; the mail stays where it is. Returns what Undo sends back. */
export async function DELETE(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  const saved = deleteSpace(id);
  return NextResponse.json({ saved, spaces: listSpaces() });
}
