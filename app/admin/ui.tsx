import Link from "next/link";

// Shared presentational pieces for the admin area. Server-safe (no hooks) so
// every admin page can render them directly.

export function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold uppercase tracking-wide text-stone-500">{children}</h2>;
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-stone-200 bg-white p-5 shadow-sm ${className}`}>{children}</div>;
}

// A single number + label. `href` turns it into a link to the page that shows
// the underlying rows.
export function StatChip({ value, label, href }: { value: number | string; label: string; href?: string }) {
  const inner = (
    <>
      <div className="text-xl font-bold tabular-nums">{value}</div>
      <div className="text-xs text-stone-500">{label}</div>
    </>
  );
  const base = "rounded-lg border border-stone-200 bg-white px-4 py-3";
  if (!href) return <div className={base}>{inner}</div>;
  return (
    <Link href={href} className={`${base} btn-press block transition-colors hover:border-orange-300 hover:bg-orange-50`}>
      {inner}
    </Link>
  );
}

const BADGE_TONES: Record<string, string> = {
  // enrichment / job / review states, grouped by what they mean for us
  queued: "bg-blue-50 text-blue-700 ring-blue-200",
  sourced: "bg-stone-100 text-stone-600 ring-stone-200",
  contacted: "bg-green-50 text-green-700 ring-green-200",
  sent: "bg-green-50 text-green-700 ring-green-200",
  replied: "bg-orange-50 text-orange-700 ring-orange-200",
  bumped: "bg-amber-50 text-amber-700 ring-amber-200",
  draft: "bg-blue-50 text-blue-700 ring-blue-200",
  cancelled: "bg-stone-100 text-stone-500 ring-stone-200",
  approved: "bg-green-50 text-green-700 ring-green-200",
  completed: "bg-green-50 text-green-700 ring-green-200",
  awaiting_edit: "bg-orange-50 text-orange-700 ring-orange-200",
  ready_for_review: "bg-orange-50 text-orange-700 ring-orange-200",
  processing: "bg-blue-50 text-blue-700 ring-blue-200",
  pending: "bg-stone-100 text-stone-600 ring-stone-200",
  needs_manual_email: "bg-amber-50 text-amber-700 ring-amber-200",
  rejected: "bg-red-50 text-red-700 ring-red-200",
  failed: "bg-red-50 text-red-700 ring-red-200",
};

export function Badge({ value }: { value: string | null }) {
  const v = value ?? "unknown";
  const tone = BADGE_TONES[v] ?? "bg-stone-100 text-stone-600 ring-stone-200";
  return (
    <span className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>
      {v}
    </span>
  );
}

// Labelled image with an explicit empty state, so a missing photo reads as
// "not done yet" rather than a broken layout.
export function Figure({ label, src }: { label: string; src: string | null }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-xs font-medium text-stone-500">{label}</figcaption>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} className="aspect-square w-full rounded-lg border border-stone-200 object-cover" />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-stone-200 text-xs text-stone-400">
          —
        </div>
      )}
    </figure>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm text-stone-500">{children}</p>;
}

// Formats a nullable timestamp for dense table cells. Formatting an existing
// Date is fine under the react-compiler purity rules (we never construct one).
export function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// Prev/Next pager that preserves the page's existing filters. `params` is the
// resolved searchParams minus this pager's own page key. `pageParam` lets one
// route host two independently-paged tables (see /admin/orders).
export function Pager({
  base,
  page,
  hasNext,
  params = {},
  pageParam = "page",
}: {
  base: string;
  page: number;
  hasNext: boolean;
  params?: Record<string, string | undefined>;
  pageParam?: string;
}) {
  const href = (p: number) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    if (p > 1) qs.set(pageParam, String(p));
    const q = qs.toString();
    return q ? `${base}?${q}` : base;
  };

  if (page === 1 && !hasNext) return null;

  const linkClass =
    "btn-press rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100";
  const disabledClass = "rounded-lg border border-stone-200 px-3 py-1.5 text-sm font-medium text-stone-400";

  return (
    <div className="mt-6 flex items-center justify-between">
      {page > 1 ? (
        <Link href={href(page - 1)} className={linkClass}>
          ← Previous
        </Link>
      ) : (
        <span className={disabledClass}>← Previous</span>
      )}
      <span className="text-sm text-stone-500">Page {page}</span>
      {hasNext ? (
        <Link href={href(page + 1)} className={linkClass}>
          Next →
        </Link>
      ) : (
        <span className={disabledClass}>Next →</span>
      )}
    </div>
  );
}
