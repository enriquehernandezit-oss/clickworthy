import type { Metadata } from "next";
import Sidebar, { type WorkCounts } from "./Sidebar";
import LogoutButton from "./LogoutButton";
import { getCurrentUser } from "@/lib/currentUser";
import { getNeedsAttention } from "@/lib/photoStats";

export const metadata: Metadata = {
  title: "ClickWorthy Console",
  robots: { index: false, follow: false },
};

// getNeedsAttention() items can share an href (e.g. 4 distinct order
// problems all point at /admin/photo/orders) — sum by href so the sidebar
// badge reflects the page's total work, not just its first cause.
function sumByHref(items: Awaited<ReturnType<typeof getNeedsAttention>>, href: string): number {
  return items.filter((i) => i.href === href).reduce((sum, i) => sum + i.n, 0);
}

// The console shell: dark sidebar (venture-aware nav) + a dark main column
// with a sticky topbar. `.console` scopes the design system so the public
// site is untouched. The login page renders its own fixed overlay on top.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const [user, attention] = await Promise.all([getCurrentUser(), getNeedsAttention()]);

  const workCounts: WorkCounts = {
    approvals: sumByHref(attention, "/admin/photo/approvals"),
    samples: sumByHref(attention, "/admin/photo/samples"),
    orders: sumByHref(attention, "/admin/photo/orders"),
  };

  return (
    <div className="console flex min-h-screen">
      <Sidebar
        userName={user?.name ?? "—"}
        userRole={user?.role === "owner" ? "Founder · Owner" : "Admin"}
        workCounts={workCounts}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="sticky top-0 z-10 flex h-16 items-center justify-between border-b px-7 pl-16 lg:pl-7"
          style={{ background: "var(--card)", borderColor: "var(--line)" }}
        >
          <div className="font-display text-base font-semibold text-[var(--c-text)]">ClickWorthy</div>
          {user && (
            <div className="flex items-center gap-3 text-sm text-[var(--c-text-muted)]">
              <span className="hidden sm:inline">{user.name}</span>
              <LogoutButton />
            </div>
          )}
        </header>

        <main className="flex-1 px-5 pb-16 pt-6 sm:px-7">{children}</main>
      </div>
    </div>
  );
}
