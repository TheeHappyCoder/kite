import { NextResponse } from "next/server";
import * as z from "zod";
import { AssetError, listAssets, MAX_ASSET_BYTES, saveAsset } from "@/server/assets";
import { rejectCrossSite } from "@/server/guard";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ assets: await listAssets() });
}

const Upload = z.object({
  name: z.string().max(200),
  /** Base64 file contents (JSON keeps uploads behind the same-origin guard). */
  data: z.string().max(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 8),
  width: z.number().positive().max(10_000),
  height: z.number().positive().max(10_000),
  /** A Fill & sign signature: kept out of design image lists. */
  private: z.boolean().optional(),
});

export async function POST(request: Request) {
  const rejected = rejectCrossSite(request);
  if (rejected) return rejected;
  const parsed = Upload.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: `Images can be up to ${MAX_ASSET_BYTES / 1024} KB, because they travel inside every email.` }, { status: 400 });
  }
  try {
    const asset = await saveAsset(Buffer.from(parsed.data.data, "base64"), parsed.data);
    return NextResponse.json({ asset });
  } catch (error) {
    if (error instanceof AssetError) return NextResponse.json({ error: error.message }, { status: 400 });
    throw error;
  }
}
