import { NextResponse } from "next/server";
import { rejectForeignHost } from "@/server/guard";
import { countSent } from "@/server/privacy-log";

export const runtime = "nodejs";

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 10_000;

/** Addresses on this computer or the local network: never fetched for an email's picture. */
function privateHost(host: string) {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return true;
  if (/^(?:127|10|0)\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(h)) return true;
  return h.includes(":") && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80"));
}

/**
 * A remote picture in an email, for a screenshot (components/mail/screenshot): the browser can't
 * draw another site's image into a saved file, so Kite fetches it once more. The client asks only for
 * pictures already showing (the user loaded them); counted in the privacy log per site.
 */
export async function GET(request: Request) {
  const rejected = rejectForeignHost(request);
  if (rejected) return rejected;
  const raw = new URL(request.url).searchParams.get("url") ?? "";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return NextResponse.json({ error: "Not a picture address" }, { status: 400 });
  }
  if (!/^https?:$/.test(url.protocol) || privateHost(url.hostname)) {
    return NextResponse.json({ error: "Not a picture address" }, { status: 400 });
  }
  countSent("picture", url.hostname);
  try {
    const res = await fetch(url, { redirect: "follow", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !type.startsWith("image/") || Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
      return NextResponse.json({ error: "Couldn't get that picture" }, { status: 502 });
    }
    const bytes = await res.arrayBuffer();
    if (bytes.byteLength > MAX_BYTES) return NextResponse.json({ error: "Couldn't get that picture" }, { status: 502 });
    return new NextResponse(bytes, {
      headers: {
        "content-type": type.split(";")[0],
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, max-age=600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Couldn't get that picture" }, { status: 502 });
  }
}
