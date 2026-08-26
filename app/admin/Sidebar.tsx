"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Dark console sidebar. Two modes, chosen by the current path:
//  - Console-level (/admin, /admin/financials, /admin/guide): brand + Console
//    group + the venture switcher (Products).
//  - Inside a venture (/admin/photo/*): brand + Console group + a back-link +
//    that venture's own grouped nav — WORK / PIPELINE / MONEY / SYSTEM,
//    ordered to match the documented daily loop (/admin/guide). This REPLACES
//    the old horizontal PhotoSubnav row (14 flat, equal-weight tabs) and the
//    venture switcher while inside the venture, so the sidebar never shows
//    both a 4-venture list and a 14-item list at once.
// Collapses to a slide-over under lg:. No deps — a hamburger in the topbar
// toggles `open`.

type Venture = { slug: string; label: string; accent: string; live: boolean; icon: React.ReactNode };

const APERTURE = (
  <svg viewBox="0 0 100 100" className="h-full w-full">
    {["50,50 50,8 68,14", "50,50 84,26 88,46", "50,50 88,60 76,84", "50,50 56,92 32,90", "50,50 16,80 8,60", "50,50 8,42 20,16"].map(
      (p, i) => (
        <polygon key={i} points={p} fill="var(--gold)" />
      )
    )}
  </svg>
);

const CONSOLE = { slug: "", label: "Overview", accent: "var(--gold)" };

const VENTURES: Venture[] = [
  {
    slug: "photo",
    label: "Photo Enhancement",
    accent: "var(--gold)",
    live: true,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
        <circle cx="12" cy="13.5" r="3.5" />
      </svg>
    ),
  },
  {
    slug: "hvac",
    label: "HVAC Appt. Setter",
    accent: "var(--teal)",
    live: false,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M12 2v20M2 12h20M5.5 5.5l13 13M18.5 5.5l-13 13" />
      </svg>
    ),
  },
  {
    slug: "analytics",
    label: "SMB Analytics",
    accent: "var(--plum)",
    live: false,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M4 20V10M12 20V4M20 20v-7" />
      </svg>
    ),
  },
  {
    slug: "realestate",
    label: "RE Listing Videos",
    accent: "var(--rust)",
    live: false,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10z" />
      </svg>
    ),
  },
];

// The Photo venture's IA — three groups ordered to match the documented daily
// loop (Approvals → Samples → Orders, per /admin/guide), then PIPELINE, MONEY,
// SYSTEM. `countKey` looks up a live badge from `workCounts`; only WORK items
// carry one — the delegate shouldn't have to click a tab to find it empty.
type PhotoLink = { href: string; label: string; countKey?: "approvals" | "samples" | "orders" };
type PhotoGroup = { title: string; links: PhotoLink[] };

const PHOTO_GROUPS: PhotoGroup[] = [
  {
    title: "Work",
    links: [
      { href: "/admin/photo/approvals", label: "Approvals", countKey: "approvals" },
      { href: "/admin/photo/samples", label: "Samples", countKey: "samples" },
      { href: "/admin/photo/orders", label: "Orders", countKey: "orders" },
    ],
  },
  {
    title: "Pipeline",
    links: [
      { href: "/admin/photo/restaurants", label: "Leads" },
      { href: "/admin/photo/call-list", label: "Call list" },
      { href: "/admin/photo/website-leads", label: "Website leads" },
      { href: "/admin/photo/outreach", label: "Outreach" },
      { href: "/admin/photo/suppressions", label: "Suppressions" },
    ],
  },
  {
    title: "Money",
    links: [
      { href: "/admin/photo/financials", label: "Financials" },
      { href: "/admin/photo/clients", label: "Clients" },
    ],
  },
  {
    title: "System",
    links: [
      { href: "/admin/photo/controls", label: "Controls" },
      { href: "/admin/photo/templates", label: "Templates" },
      { href: "/admin/photo/setup", label: "Setup" },
      { href: "/admin/guide", label: "Guide" },
    ],
  },
];

export type WorkCounts = { approvals: number; samples: number; orders: number };

export default function Sidebar({
  userName,
  userRole,
  workCounts,
}: {
  userName: string;
  userRole: string;
  workCounts: WorkCounts;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (slug: string) =>
    slug === "" ? pathname === "/admin" : pathname === `/admin/${slug}` || pathname.startsWith(`/admin/${slug}/`);
  const isPhotoLinkActive = (href: string) => (href === "/admin/photo" ? pathname === href : pathname.startsWith(href));

  const inPhoto = pathname.startsWith("/admin/photo");

  const initials =
    userName
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  const nav = (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-2.5 px-2.5 pb-5 pt-1">
        <div className="h-6 w-6">{APERTURE}</div>
        <span className="font-display text-[15px] font-bold tracking-tight text-white">ClickWorthy</span>
      </div>

      <GroupLabel>Console</GroupLabel>
      <SideLink href="/admin" active={isActive(CONSOLE.slug)} accent={CONSOLE.accent} onNav={() => setOpen(false)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[17px] w-[17px] opacity-85">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
        Overview
      </SideLink>
      <SideLink href="/admin/financials" active={isActive("financials")} accent={CONSOLE.accent} onNav={() => setOpen(false)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[17px] w-[17px] opacity-85">
          <path d="M12 2v20M6 9h9a3 3 0 0 1 0 6H6M6 6h11M6 18h11" />
        </svg>
        Financials
      </SideLink>
      {!inPhoto && (
        <SideLink href="/admin/guide" active={isActive("guide")} accent={CONSOLE.accent} onNav={() => setOpen(false)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[17px] w-[17px] opacity-85">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V4a2 2 0 0 0-2-2H6.5A2.5 2.5 0 0 0 4 4.5v15z" />
          </svg>
          Guide
        </SideLink>
      )}

      {inPhoto ? (
        <>
          <Link
            href="/admin"
            onClick={() => setOpen(false)}
            className="mt-3.5 flex items-center gap-1.5 px-3 py-1 text-xs text-white/55 transition-colors hover:text-white/75"
          >
            <span aria-hidden="true">←</span> Ventures
          </Link>
          <div className="mb-1 mt-2 flex items-center gap-2 px-3">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--gold)" }} />
            <span className="font-mono-label text-[11px] font-semibold uppercase tracking-wider text-white/90">
              Photo Enhancement
            </span>
          </div>
          {PHOTO_GROUPS.map((g) => (
            <div key={g.title}>
              <GroupLabel>{g.title}</GroupLabel>
              {g.links.map((l) => (
                <SideLink
                  key={l.href}
                  href={l.href}
                  active={isPhotoLinkActive(l.href)}
                  accent="var(--gold)"
                  onNav={() => setOpen(false)}
                  count={l.countKey ? workCounts[l.countKey] : undefined}
                >
                  {l.label}
                </SideLink>
              ))}
            </div>
          ))}
        </>
      ) : (
        <>
          <GroupLabel>Products</GroupLabel>
          {VENTURES.map((v) => (
            <SideLink
              key={v.slug}
              href={`/admin/${v.slug}`}
              active={isActive(v.slug)}
              accent={v.accent}
              onNav={() => setOpen(false)}
            >
              <span className="h-[17px] w-[17px] opacity-85">{v.icon}</span>
              <span className="flex-1">{v.label}</span>
              <span
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                style={{ background: v.live ? v.accent : "rgba(255,255,255,0.25)" }}
                title={v.live ? "Live" : "Not built yet"}
              />
            </SideLink>
          ))}
        </>
      )}

      <div className="mt-auto border-t border-white/10 pt-3">
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <div
            className="font-display flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full text-xs font-bold"
            style={{ background: "var(--gold)", color: "var(--paper)" }}
          >
            {initials}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[12.5px] font-semibold text-white">{userName}</div>
            <div className="truncate text-[11px] text-white/55">{userRole}</div>
          </div>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Mobile hamburger — sits in the top-left on small screens */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed left-3 top-3 z-40 flex h-10 w-10 items-center justify-center rounded-lg border border-line bg-surface text-muted lg:hidden"
        aria-label="Open navigation"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Desktop: static sidebar */}
      <aside
        className="sticky top-0 hidden h-screen w-[248px] flex-shrink-0 flex-col p-3.5 lg:flex"
        style={{ background: "var(--card)" }}
      >
        {nav}
      </aside>

      {/* Mobile: slide-over */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-[248px] p-3.5" style={{ background: "var(--card)" }}>
            {nav}
          </aside>
        </div>
      )}
    </>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <div className="px-3 pb-2 pt-3.5 font-mono-label text-[10.5px] uppercase tracking-wider text-white/35">{children}</div>;
}

// Active state is a filled tint, never a side-stripe border — a colored
// border-left/right as a "you are here" accent reads as a dated UI tell, and
// scans worse on a dense 20-item list than a full-row tint does.
function SideLink({
  href,
  active,
  accent,
  onNav,
  count,
  children,
}: {
  href: string;
  active: boolean;
  accent: string;
  onNav: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNav}
      className={`mb-0.5 flex items-center gap-3 rounded-lg px-3 py-2.5 text-[13.5px] font-medium transition-colors ${
        active ? "text-white" : "text-white/[0.68] hover:bg-white/[0.06] hover:text-white"
      }`}
      style={active ? { background: `color-mix(in oklch, ${accent} 16%, transparent)` } : undefined}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span
          className="font-mono-label ml-auto flex-shrink-0 rounded-full px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums"
          style={{ background: accent, color: "var(--paper)" }}
        >
          {count}
        </span>
      )}
    </Link>
  );
}
