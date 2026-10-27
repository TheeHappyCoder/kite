import { senderAvatar } from "@/server/avatars";

export const runtime = "nodejs";

const EMAIL = /^[^\s@<>]+@[a-z0-9.-]+\.[a-z]{2,}$/i;

export async function GET(request: Request) {
  const email = new URL(request.url).searchParams.get("email")?.trim() ?? "";
  if (!EMAIL.test(email)) return new Response(null, { status: 400 });

  const avatar = await senderAvatar(email);
  if (!avatar) {
    // Misses are cached on disk, so asking again is cheap and picks up photos found later (e.g. contacts turned on).
    return new Response(null, { status: 404, headers: { "cache-control": "private, no-cache" } });
  }
  return new Response(new Uint8Array(avatar.body), {
    headers: {
      "content-type": avatar.contentType,
      "cache-control": "private, max-age=604800",
      // SVG logos come from third parties: never let one run as a document on Kite's origin.
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
