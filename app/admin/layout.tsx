import type { Metadata } from "next";
import AdminNav from "./AdminNav";
import LogoutButton from "./LogoutButton";
import { getCurrentUser } from "@/lib/currentUser";

// Internal tool — don't inherit the marketing title, and keep it out of search.
export const metadata: Metadata = {
  title: "Clickworthy Admin",
  robots: { index: false, follow: false },
};

// Chrome for the whole admin area. Deliberately does minimal DB work.
// Auth: proxy.ts gates /admin/:path* + /api/admin/:path* with a session cookie.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  return (
    <div className="min-h-screen bg-stone-50 px-6 py-10 text-stone-900">
      <div className="mx-auto max-w-6xl">
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-2xl font-bold tracking-tight">Clickworthy Admin</h1>
          {user && (
            <div className="flex items-center gap-3 text-sm text-stone-500">
              <span>{user.name}</span>
              <LogoutButton />
            </div>
          )}
        </div>
        <AdminNav />
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}
