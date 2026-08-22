"use client";

import { useRouter } from "next/navigation";
import type { SortValue } from "./sortOptions";
import { SORT_OPTIONS } from "./sortOptions";

// Plain <select> that navigates on change — same FormData-free, no-extra-click
// pattern as the rest of the admin's client controls (DraftActions etc.), just
// for a query param instead of a mutation.
export default function SortSelect({ value }: { value: SortValue }) {
  const router = useRouter();
  return (
    <select
      id="sort"
      value={value}
      onChange={(e) => router.push(`/admin/photo/approvals?sort=${e.target.value}`)}
      className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-800"
    >
      {SORT_OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
