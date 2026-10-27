import { NextResponse } from "next/server";
import { rejectCrossSite } from "@/server/guard";
import { deleteTemplate } from "@/server/mail-designs";

export const runtime = "nodejs";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const { id } = await params;
  if (!deleteTemplate(id)) return NextResponse.json({ error: "That template is already gone" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
