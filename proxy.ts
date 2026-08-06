import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

// Session-cookie gate for the internal admin area (/admin + /api/admin).
// Signed-in users carry a valid `cw_admin_session` cookie (issued by
// /api/admin/auth, verified by SESSION_SECRET). Unauthenticated requests are
// redirected to /admin/login (pages) or 401'd (api). Fails closed.
//
// The login page + its auth endpoint are exempt so a signed-out user can reach
// them. Note: Next 16 proxy runs on the Node runtime, so node:crypto works here.
export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Public within the admin area: the login screen and the auth endpoint.
  if (pathname === "/admin/login" || pathname === "/api/admin/auth") {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (verifySessionToken(token) != null) {
    return NextResponse.next();
  }

  // Not signed in.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const loginUrl = new URL("/admin/login", request.url);
  // Remember where they were headed so login can bounce them back.
  if (pathname !== "/admin") loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
