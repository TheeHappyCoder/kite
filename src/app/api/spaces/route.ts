import { NextResponse } from "next/server";
import * as z from "zod";
import { NewSpace } from "@/lib/spaces";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { createSpace, listSpaces, orderSpaces, restoreSpace } from "@/server/spaces";

export const runtime = "nodejs";

/** Every space and pocket (lib/spaces.ts), in their order. Local only. */
export async function GET() {
  return NextResponse.json({ spaces: listSpaces() });
}

const Saved = z.object({
  spaces: z.array(
    z.object({
      id: z.string().max(40),
      parent_id: z.string().max(40).nullable(),
      name: z.string().max(80),
      color: z.string().max(9),
      note: z.string().max(20_000).nullable(),
      position: z.number().int(),
      created_at: z.string().max(40),
    }),
  ).max(500),
  items: z.array(
    z.object({ space_id: z.string().max(40), kind: z.string().max(20), ref: z.string().max(300), account_id: z.string().max(200).nullable(), added_at: z.string().max(40) }),
  ).max(20_000),
});

/** Makes a space or a pocket inside one; `{ restore }` puts back a deleted one (Undo). */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const body = (await request.json().catch(() => null)) as { restore?: unknown } | null;
  try {
    if (body && "restore" in body) {
      restoreSpace(Saved.parse(body.restore));
      return NextResponse.json({ spaces: listSpaces() });
    }
    const space = createSpace(NewSpace.parse(body));
    return NextResponse.json({ space, spaces: listSpaces() });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Puts spaces (siblings) in this order. */
export async function PUT(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = z.object({ order: z.array(z.string().max(40)).max(500) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "That order didn't look right" }, { status: 400 });
  orderSpaces(parsed.data.order);
  return NextResponse.json({ spaces: listSpaces() });
}
