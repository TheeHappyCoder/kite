import { NextResponse } from "next/server";
import * as z from "zod";
import { getAccount } from "@/server/db";
import { errorResponse } from "@/server/errors";
import { rejectCrossSite } from "@/server/guard";
import { LabelError } from "@/server/mail/errors";
import { createLabel, deleteLabel, listStoredLabels, renameLabel } from "@/server/labels";

export const runtime = "nodejs";

/** The user's own labels/folders per account, with counts from the local copy. */
export async function GET(request: Request) {
  const account = new URL(request.url).searchParams.get("account") || "all";
  return NextResponse.json({ labels: listStoredLabels(account) });
}

const Create = z.object({ account: z.string().min(1), name: z.string().max(400), kind: z.enum(["tag", "folder"]) });
const Rename = z.object({ account: z.string().min(1), id: z.string().min(1), name: z.string().max(400) });

function accountOf(id: string) {
  const account = getAccount(id);
  if (!account) throw new LabelError("That account isn't connected any more.");
  return account;
}

/** Makes a label/folder in the account's provider (POST { account, name, kind }). */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const body = Create.parse(await request.json().catch(() => null));
    return NextResponse.json({ label: await createLabel(accountOf(body.account), body) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Renames one (PATCH { account, id, name }); nested ones under it move along. */
export async function PATCH(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const body = Rename.parse(await request.json().catch(() => null));
    return NextResponse.json({ label: await renameLabel(accountOf(body.account), body.id, body.name) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** Deletes one (DELETE ?account=&id=): the label goes, the mail stays (a provider may refuse a folder that holds mail). */
export async function DELETE(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  try {
    const params = new URL(request.url).searchParams;
    await deleteLabel(accountOf(params.get("account") ?? ""), params.get("id") ?? "");
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
