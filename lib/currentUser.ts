import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { adminUsers } from "@/db/schema";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/auth";

export type CurrentUser = { id: number; name: string; email: string; role: string };

// Resolves the signed-in admin from the session cookie, for server components
// (the sidebar user chip, attribution). Returns null if not signed in — but the
// proxy already gates every admin route, so inside /admin this is effectively
// always present. `cookies()` is async in Next 16.
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const store = await cookies();
  const userId = verifySessionToken(store.get(SESSION_COOKIE)?.value);
  if (userId == null) return null;
  const [u] = await db
    .select({ id: adminUsers.id, name: adminUsers.name, email: adminUsers.email, role: adminUsers.role })
    .from(adminUsers)
    .where(eq(adminUsers.id, userId))
    .limit(1);
  return u ?? null;
}
