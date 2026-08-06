import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { adminUsers } from "@/db/schema";
import { SESSION_COOKIE, SESSION_TTL_SECONDS, createSessionToken, verifyPassword } from "@/lib/auth";

// Login / logout for the admin console. This route is exempt from the proxy's
// auth check (see proxy.ts) so a signed-out user can reach it.
//   login  — verify email+password, set the signed session cookie
//   logout — clear the cookie

export async function POST(request: NextRequest) {
  const form = await request.formData();
  const action = String(form.get("action") ?? "login");

  if (action === "logout") {
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  if (!process.env.SESSION_SECRET) {
    return NextResponse.json({ error: "Auth is not configured (SESSION_SECRET unset)." }, { status: 500 });
  }

  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return NextResponse.json({ error: "Email and password required." }, { status: 400 });

  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
  // Same generic message + a real verify pass whether or not the user exists,
  // so timing/response don't reveal which emails are registered.
  const dummySalt = "0".repeat(32);
  const ok = user
    ? verifyPassword(password, user.passwordHash, user.passwordSalt)
    : (verifyPassword(password, "0".repeat(128), dummySalt), false);

  if (!user || !ok) {
    return NextResponse.json({ error: "Wrong email or password." }, { status: 401 });
  }

  const token = createSessionToken(user.id);
  if (!token) return NextResponse.json({ error: "Auth is not configured." }, { status: 500 });

  await db.update(adminUsers).set({ lastLoginAt: new Date() }).where(eq(adminUsers.id, user.id));

  const res = NextResponse.json({ ok: true, name: user.name });
  res.cookies.set(SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
