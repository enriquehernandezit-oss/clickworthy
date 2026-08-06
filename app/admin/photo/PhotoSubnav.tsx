"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Subtab row for the Photo venture. Gold accent (the venture's --accent).
const TABS = [
  ["/admin/photo", "Overview"],
  ["/admin/photo/outreach", "Outreach"],
  ["/admin/photo/samples", "Samples"],
  ["/admin/photo/orders", "Orders"],
  ["/admin/photo/restaurants", "Leads"],
  ["/admin/photo/suppressions", "Suppressions"],
  ["/admin/photo/controls", "Controls"],
] as const;

export default function PhotoSubnav() {
  const pathname = usePathname();
  const active = (href: string) => (href === "/admin/photo" ? pathname === "/admin/photo" : pathname.startsWith(href));

  return (
    <nav className="flex gap-1 overflow-x-auto border-b" style={{ borderColor: "var(--line)" }}>
      {TABS.map(([href, label]) => {
        const on = active(href);
        return (
          <Link
            key={href}
            href={href}
            className="-mb-px whitespace-nowrap border-b-2 px-1 py-2.5 text-[13.5px] font-medium transition-colors"
            style={{
              borderColor: on ? "var(--accent)" : "transparent",
              color: on ? "var(--c-text)" : "var(--c-text-muted)",
              fontWeight: on ? 600 : 500,
              marginRight: "18px",
            }}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
