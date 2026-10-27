import "server-only";

import { NextResponse } from "next/server";

/**
 * Rejects state-changing requests that don't come from Kite itself.
 * Requiring a JSON body forces browsers into a CORS preflight, and the Origin
 * check stops other sites (and DNS-rebinding pages) from driving the API.
 */
export function rejectCrossSite(request: Request, { binary = false }: { binary?: boolean } = {}) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  const sameOrigin = origin != null && host != null && new URL(origin).host === host;
  const type = request.headers.get("content-type") ?? "";
  // File uploads send raw bytes as application/octet-stream, which also requires a preflight.
  const allowedType = type.startsWith("application/json") || (binary && type.startsWith("application/octet-stream"));
  if (!sameOrigin || (request.method !== "DELETE" && !allowedType)) {
    return NextResponse.json({ error: "Cross-site request rejected" }, { status: 403 });
  }
  return null;
}

/**
 * Rejects reads addressed to any host but Kite's own (127.0.0.1 / localhost), so a DNS-rebinding
 * page can't read sensitive streams like sign-in codes. Same-origin reads always pass.
 */
export function rejectForeignHost(request: Request) {
  const host = request.headers.get("host") ?? "";
  if (/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return null;
  return NextResponse.json({ error: "Unknown host" }, { status: 403 });
}
