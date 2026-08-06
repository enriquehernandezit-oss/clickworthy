"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

// Dark console sidebar: brand, Console group, Products (ventures) with per-venture
// accent dots, and the user chip + logout at the bottom. Collapses to a slide-over
// under lg:. No deps — a hamburger in the topbar toggles `open`.

type Venture = { slug: string; label: string; accent: string; live: boolean; icon: React.ReactNode };

const APERTURE = (
  <svg viewBox="0 0 100 100" className="h-full w-full">
    {["50,50 50,8 68,14", "50,50 84,26 88,46", "50,50 88,60 76,84", "50,50 56,92 32,90", "50,50 16,80 8,60", "50,50 8,42 20,16"].map(
      (p, i) => (
        <polygon key={i} points={p} fill="#E3A83B" />
      )
    )}
  </svg>
);

const CONSOLE = { slug: "", label: "Overview", accent: "#E3A83B" };

const VENTURES: Venture[] = [
  {
    slug: "photo",
    label: "Photo Enhancement",
    accent: "#E3A83B",
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
    accent: "#2F7A6F",
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
    accent: "#6B5CA5",
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
    accent: "#C1583F",
    live: false,
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
        <path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10z" />
      </svg>
    ),
  },
];

export default function Sidebar({ userName, userRole }: { userName: string; userRole: string }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const isActive = (slug: string) =>
    slug === "" ? pathname === "/admin" : pathname === `/admin/${slug}` || pathname.startsWith(`/admin/${slug}/`);

  const initials =
    userName
      .split(" ")
      .map((p) => p[0])
      .slice(0, 2)
      .join("")
      .toUpperCase() || "?";

  const nav = (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2.5 px-2.5 pb-5 pt-1">
        <div className="h-6 w-6">{APERTURE}</div>
        <span className="font-display text-[15px] font-bold tracking-tight text-white">ClickWorthy</span>
      </div>

      <div className="px-3 pb-2 pt-3.5 font-mono-label text-[10.5px] uppercase tracking-wider text-white/35">Console</div>
      <SideLink href="/admin" active={isActive(CONSOLE.slug)} accent={CONSOLE.accent} onNav={() => setOpen(false)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-[17px] w-[17px] opacity-85">
          <rect x="3" y="3" width="7" height="7" rx="1.5" />
          <rect x="14" y="3" width="7" height="7" rx="1.5" />
          <rect x="3" y="14" width="7" height="7" rx="1.5" />
          <rect x="14" y="14" width="7" height="7" rx="1.5" />
        </svg>
        Overview
      </SideLink>

      <div className="px-3 pb-2 pt-3.5 font-mono-label text-[10.5px] uppercase tracking-wider text-white/35">Products</div>
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

      <div className="mt-auto border-t border-white/10 pt-3">
        <div className="flex items-center gap-2.5 px-2.5 py-2">
          <div
            className="flex h-[30px] w-[30px] flex-shrink-0 items-center justify-center rounded-full font-display text-xs font-bold text-[#14171c]"
            style={{ background: "#E3A83B" }}
          >
            {initials}
          </div>
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[12.5px] font-semibold text-white">{userName}</div>
            <div className="truncate text-[11px] text-white/45">{userRole}</div>
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
        className="fixed left-3 top-3 z-40 flex h-10 w-10 items-center justify-center rounded-lg border border-[#E4E2DB] bg-white text-[#6B7280] shadow-sm lg:hidden"
        aria-label="Open navigation"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-5 w-5">
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Desktop: static sidebar */}
      <aside
        className="sticky top-0 hidden h-screen w-[248px] flex-shrink-0 flex-col p-3.5 lg:flex"
        style={{ background: "#14171C" }}
      >
        {nav}
      </aside>

      {/* Mobile: slide-over */}
      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="absolute left-0 top-0 h-full w-[248px] p-3.5" style={{ background: "#14171C" }}>
            {nav}
          </aside>
        </div>
      )}
    </>
  );
}

function SideLink({
  href,
  active,
  accent,
  onNav,
  children,
}: {
  href: string;
  active: boolean;
  accent: string;
  onNav: () => void;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      onClick={onNav}
      className={`mb-0.5 flex items-center gap-3 rounded-lg border-l-2 px-3 py-2.5 text-[13.5px] font-medium transition-colors ${
        active ? "bg-white/[0.08] text-white" : "border-transparent text-white/[0.68] hover:bg-white/[0.06] hover:text-white"
      }`}
      style={active ? { borderLeftColor: accent } : undefined}
    >
      {children}
    </Link>
  );
}
