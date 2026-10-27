import { NextResponse } from "next/server";
import * as z from "zod";
import { CollectionError, createCollection, listCollections } from "@/server/collections";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";

export const runtime = "nodejs";

/** Your collections (automations fill them), with how many rows each holds. */
export function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  return NextResponse.json({ collections: listCollections() });
}

/** Makes a collection ({ name }). */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = z.object({ name: z.string().max(200) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Give the collection a name." }, { status: 400 });
  try {
    return NextResponse.json({ collection: createCollection(parsed.data.name), collections: listCollections() });
  } catch (error) {
    if (error instanceof CollectionError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
