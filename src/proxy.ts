import { NextResponse, type NextRequest } from "next/server";

/**
 * Every request must be addressed to Kite itself (127.0.0.1 / localhost / [::1]). Without this a
 * page on any website could DNS-rebind its own name to 127.0.0.1 and read the mail API through the
 * user's browser. State-changing routes also check the Origin (`rejectCrossSite` in server/guard.ts).
 */
export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  if (/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(host)) return NextResponse.next();
  return new NextResponse("Unknown host", { status: 403 });
}

export const config = {
  matcher: "/:path*",
};
