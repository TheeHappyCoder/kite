import { NextResponse } from "next/server";
import { TemplateInput } from "@/lib/design/brand";
import { rejectCrossSite } from "@/server/guard";
import { getBrand, listTemplates, saveTemplate } from "@/server/mail-designs";

export const runtime = "nodejs";

/** Email templates and the brand kit (local only). */
export async function GET() {
  return NextResponse.json({ templates: listTemplates(), brand: getBrand() });
}

/** Saves a designed email as a new template. */
export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = TemplateInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const message = issue?.path[0] === "name" || issue?.path[0] === "subject" ? issue.message : "That design isn't complete yet";
    return NextResponse.json({ error: message }, { status: 400 });
  }
  try {
    return NextResponse.json({ template: saveTemplate(parsed.data) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "That didn't save" }, { status: 409 });
  }
}
