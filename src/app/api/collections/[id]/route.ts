import { NextResponse } from "next/server";
import * as z from "zod";
import { CollectionError, deleteCollection, getCollection, listCollections, removeRow, renameCollection } from "@/server/collections";
import { rejectCrossSite, rejectForeignHost } from "@/server/guard";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

const fail = (error: unknown) => {
  if (error instanceof CollectionError) return NextResponse.json({ error: error.message }, { status: 404 });
  throw error;
};

/** One collection with its rows (values read from your mail, so only Kite's own pages read it). */
export async function GET(request: Request, { params }: Params) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  try {
    return NextResponse.json({ collection: getCollection((await params).id) });
  } catch (error) {
    return fail(error);
  }
}

/** Renames it ({ name }). */
export async function PATCH(request: Request, { params }: Params) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = z.object({ name: z.string().max(200) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Give the collection a name." }, { status: 400 });
  try {
    renameCollection((await params).id, parsed.data.name);
    return NextResponse.json({ collections: listCollections() });
  } catch (error) {
    if (error instanceof CollectionError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}

/** Deletes the collection and its rows, or one row (`?row=`). Your mail is untouched. */
export async function DELETE(request: Request, { params }: Params) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const id = (await params).id;
  const row = new URL(request.url).searchParams.get("row");
  if (row) removeRow(row);
  else deleteCollection(id);
  return NextResponse.json({ collections: listCollections() });
}
