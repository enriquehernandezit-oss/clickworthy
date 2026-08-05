"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  ["/admin", "Overview"],
  ["/admin/restaurants", "Restaurants"],
  ["/admin/outreach", "Outreach"],
  ["/admin/samples", "Samples"],
  ["/admin/orders", "Orders"],
  ["/admin/suppressions", "Suppressions"],
  ["/admin/controls", "Controls"],
] as const;

export default function AdminNav() {
  const pathname = usePathname();

  return (
    <nav className="mt-5 flex flex-wrap gap-1 border-b border-stone-200">
      {TABS.map(([href, label]) => {
        // Overview must match exactly; the rest match their subtree.
        const active = href === "/admin" ? pathname === "/admin" : pathname.startsWith(href);
        return (
          <Link
            key={href}
            href={href}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? "border-orange-600 text-orange-700"
                : "border-transparent text-stone-500 hover:border-stone-300 hover:text-stone-800"
            }`}
          >
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
