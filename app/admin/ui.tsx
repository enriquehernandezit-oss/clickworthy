import Link from "next/link";

// Shared presentational pieces for the admin area. Server-safe (no hooks) so
// every admin page can render them directly.

// ---- Console design-system primitives (from the mockup) -------------------
// Styled with the .console CSS variables. Used by the company overview + the
// venture panels; older pages keep the plain Card/StatChip above.

// A KPI tile: mono uppercase label, big display value, optional delta line.
export function KpiCard({
  label,
  value,
  delta,
  href,
}: {
  label: string;
  value: React.ReactNode;
  delta?: { text: string; dir: "up" | "down" | "flat"; ctx?: string };
  href?: string;
}) {
  const inner = (
    <div
      className="rounded-xl border p-[18px]"
      style={{ background: "var(--card)", borderColor: "var(--line)" }}
    >
      <div className="font-mono-label text-[10.5px] uppercase tracking-wider" style={{ color: "var(--c-text-muted)" }}>
        {label}
      </div>
      <div className="mt-2.5 font-display text-[28px] font-bold tracking-tight tabular-nums" style={{ color: "var(--c-text)" }}>
        {value}
      </div>
      {delta && (
        <div
          className="mt-2 flex items-center gap-1.5 text-xs font-semibold"
          style={{ color: delta.dir === "down" ? "var(--coral)" : delta.dir === "up" ? "var(--teal)" : "var(--c-text-faint)" }}
        >
          {delta.dir !== "flat" && <span>{delta.dir === "up" ? "▲" : "▼"}</span>}
          {delta.text}
          {delta.ctx && <span className="font-normal" style={{ color: "var(--c-text-faint)" }}>{delta.ctx}</span>}
        </div>
      )}
    </div>
  );
  return href ? (
    <Link href={href} className="block transition-transform hover:-translate-y-0.5">
      {inner}
    </Link>
  ) : (
    inner
  );
}

// Rounded status pill in the mockup's tone set.
export type PillTone = "gold" | "teal" | "rust" | "plum" | "coral" | "gray";
const PILL_TONES: Record<PillTone, { bg: string; fg: string }> = {
  gold: { bg: "var(--gold-soft)", fg: "#8A6112" },
  teal: { bg: "var(--teal-soft)", fg: "var(--teal)" },
  rust: { bg: "var(--rust-soft)", fg: "var(--rust)" },
  plum: { bg: "var(--plum-soft)", fg: "var(--plum)" },
  coral: { bg: "#FBE7E7", fg: "var(--coral)" },
  gray: { bg: "#EFEEEA", fg: "var(--c-text-muted)" },
};
export function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  const t = PILL_TONES[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: t.bg, color: t.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} />
      {children}
    </span>
  );
}

// Console card with an optional header (title + sub + right slot).
export function ConsoleCard({
  title,
  sub,
  right,
  children,
}: {
  title?: string;
  sub?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
      {(title || right) && (
        <div className="flex items-center justify-between border-b px-5 py-4" style={{ borderColor: "var(--line)" }}>
          <div>
            {title && <div className="font-display text-sm font-semibold" style={{ color: "var(--c-text)" }}>{title}</div>}
            {sub && <div className="mt-0.5 text-xs" style={{ color: "var(--c-text-muted)" }}>{sub}</div>}
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

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

// Relative time for the activity feed. `nowMs` is passed in (captured in the
// page's async data helper) so the component body stays free of Date.now().
export function relTime(d: Date | null, nowMs: number): string {
  if (!d) return "";
  const mins = Math.floor((nowMs - d.getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
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
