import type { Metadata } from "next";
import AdminNav from "./AdminNav";

// Internal tool — don't inherit the marketing title, and keep it out of search.
export const metadata: Metadata = {
  title: "Clickworthy Admin",
  robots: { index: false, follow: false },
};

// Chrome for the whole admin area. Deliberately does no DB work so switching
// tabs never pays for queries the page itself will run.
// Auth: proxy.ts gates /admin/:path* + /api/admin/:path* with Basic Auth.
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-stone-50 px-6 py-10 text-stone-900">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-bold tracking-tight">Clickworthy Admin</h1>
        <AdminNav />
        <div className="mt-8">{children}</div>
      </div>
    </div>
  );
}
