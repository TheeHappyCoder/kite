import { NextResponse } from "next/server";
import { SpacePatch } from "@/lib/spaces";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { deleteSpace, listSpaces, updateSpace } from "@/server/spaces";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Renames a space, changes its colour or note, or moves it inside another. */
export async function PATCH(request: Request, { params }: Context) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  try {
    const space = updateSpace(id, SpacePatch.parse(await request.json().catch(() => null)));
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
