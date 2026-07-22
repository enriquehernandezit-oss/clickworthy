import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// HTTP Basic Auth gate for the internal admin area (/admin + /api/admin).
// Credentials come from ADMIN_USER / ADMIN_PASSWORD env. If they're unset, the
// admin area is locked entirely (fail closed) rather than left open.
export function proxy(request: NextRequest) {
  const user = process.env.ADMIN_USER;
  const password = process.env.ADMIN_PASSWORD;

  const unauthorized = () =>
    new NextResponse("Authentication required", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="Clickworthy Admin"' },
    });

  if (!user || !password) return unauthorized();

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return unauthorized();

  let decoded = "";
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return unauthorized();
  }
  const idx = decoded.indexOf(":");
  const givenUser = decoded.slice(0, idx);
  const givenPass = decoded.slice(idx + 1);

  if (givenUser !== user || givenPass !== password) return unauthorized();

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
