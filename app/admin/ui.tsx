import Link from "next/link";

// Shared presentational pieces for the admin area. Server-safe (no hooks) so
// every admin page can render them directly. Interactive primitives that need
// hooks (Button/ConfirmDialog/Toast) live in ./primitives and are re-exported
// at the bottom of this file so callers keep one import path.
export * from "./primitives";

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
      <div className="font-mono-label mt-2.5 text-[28px] font-semibold tracking-tight tabular-nums" style={{ color: "var(--c-text)" }}>
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

// Rounded status pill / badge — one tone map, one implementation. Two entry
// points onto it: `tone` for an explicit tone (financials verdicts, setup
// checklist), `value` for a status string looked up in STATUS_TONE (job/lead
// statuses). Both render identically; `Pill` is kept as an alias so pages
// that already pass `tone` don't need to change.
export type PillTone = "gold" | "teal" | "rust" | "plum" | "coral" | "gray";
const TONE_VARS: Record<PillTone, { bg: string; fg: string }> = {
  gold: { bg: "var(--gold-soft)", fg: "var(--gold)" },
  teal: { bg: "var(--teal-soft)", fg: "var(--teal)" },
  rust: { bg: "var(--rust-soft)", fg: "var(--rust)" },
  plum: { bg: "var(--plum-soft)", fg: "var(--plum)" },
  coral: { bg: "var(--coral-soft)", fg: "var(--coral)" },
  gray: { bg: "var(--gray-soft)", fg: "var(--c-text-muted)" },
};

// Every enrichment/job/review status string this app writes, mapped to a
// tone. Unrecognized values fall back to "gray" rather than throwing, since
// this renders directly from DB columns with no enum constraint.
const STATUS_TONE: Record<string, PillTone> = {
  queued: "gold",
  sourced: "gray",
  contacted: "teal",
  sent: "teal",
  replied: "gold",
  bumped: "gold",
  draft: "gold",
  cancelled: "gray",
  approved: "teal",
  completed: "teal",
  awaiting_edit: "gold",
  ready_for_review: "gold",
  processing: "gold",
  pending: "gray",
  needs_manual_email: "gold",
  call_list: "plum",
  rejected: "coral",
  failed: "coral",
  denied: "coral",
  unknown: "gray",
};

function ToneChip({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  const t = TONE_VARS[tone];
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold"
      style={{ background: t.bg, color: t.fg }}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: "currentColor" }} />
      {children}
    </span>
  );
}

export function Pill({ tone, children }: { tone: PillTone; children: React.ReactNode }) {
  return <ToneChip tone={tone}>{children}</ToneChip>;
}

export function Badge({ value }: { value: string | null }) {
  const v = value ?? "unknown";
  return <ToneChip tone={STATUS_TONE[v] ?? "gray"}>{v}</ToneChip>;
}

// Stepped funnel, proportional: each step's width encodes its value against
// the first (largest) step, so a collapsing funnel actually looks collapsed
// instead of five equal-width blocks with different numbers in them. Values
// and the % drop between steps stay as text — never color/width alone.
export function Funnel({ steps }: { steps: { label: string; value: number }[] }) {
  const max = Math.max(1, ...steps.map((s) => s.value));
  return (
    <div className="flex items-stretch gap-1.5">
      {steps.map((s, i) => {
        const last = i === steps.length - 1;
        const prev = i > 0 ? steps[i - 1].value : null;
        const dropPct = prev && prev > 0 ? Math.round(((prev - s.value) / prev) * 100) : null;
        const widthPct = Math.max(12, Math.round((s.value / max) * 100));
        return (
          <div key={s.label} className="flex flex-1 items-stretch gap-1.5">
            <div className="flex flex-1 flex-col justify-end" style={{ minWidth: 0 }}>
              <div
                className="rounded-lg px-4 py-3.5"
                style={{
                  width: `${widthPct}%`,
                  minWidth: "100%",
                  background: last ? "var(--accent)" : "var(--accent-soft)",
                  color: last ? "#0F1216" : "var(--c-text)",
                }}
              >
                <div className="font-mono-label text-[10.5px] uppercase tracking-wider" style={{ opacity: last ? 0.85 : 0.75 }}>
                  {s.label}
                </div>
                <div className="font-mono-label text-[20px] font-semibold tabular-nums">{s.value}</div>
              </div>
            </div>
            {!last && (
              <div className="flex flex-col items-center justify-center px-1 text-xs" style={{ color: "var(--c-text-faint)" }}>
                <span>→</span>
                {dropPct !== null && dropPct > 0 && <span className="mt-0.5 tabular-nums">-{dropPct}%</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Whole-dollar cents formatter for the console (mockup style).
export function money(cents: number): string {
  const dollars = cents / 100;
  if (Math.abs(dollars) >= 1000) return `$${dollars.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  return `$${dollars.toFixed(dollars % 1 === 0 ? 0 : 2)}`;
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
  return <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">{children}</h2>;
}

export function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-surface p-5 ${className}`}>{children}</div>;
}

// A single number + label. `href` turns it into a link to the page that shows
// the underlying rows.
export function StatChip({ value, label, href }: { value: number | string; label: string; href?: string }) {
  const inner = (
    <>
      <div className="font-mono-label text-xl font-semibold tabular-nums text-text">{value}</div>
      <div className="text-xs text-muted">{label}</div>
    </>
  );
  const base = "rounded-lg border border-line bg-surface px-4 py-3";
  if (!href) return <div className={base}>{inner}</div>;
  return (
    <Link href={href} className={`${base} btn-press block transition-colors hover:border-gold/40 hover:bg-surface-2`}>
      {inner}
    </Link>
  );
}

// Labelled image with an explicit empty state, so a missing photo reads as
// "not done yet" rather than a broken layout.
export function Figure({ label, src }: { label: string; src: string | null }) {
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="text-xs font-medium text-muted">{label}</figcaption>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={label} className="aspect-square w-full rounded-lg border border-line object-cover" />
      ) : (
        <div className="flex aspect-square w-full items-center justify-center rounded-lg border border-dashed border-line text-xs text-faint">
          —
        </div>
      )}
    </figure>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-sm text-muted">{children}</p>;
}

// These pages are Next.js Server Components — they format Dates on the
// server, not in the viewer's browser. Railway's container runs UTC (no TZ
// env var), so without an explicit IANA zone, toLocaleString silently prints
// the server's UTC clock while looking like local time — every timestamp in
// the admin panel read 4h ahead of Enrique's actual time (AST/UTC-4), which
// surfaced as "it says done at 2:23pm but it's only 2:20pm" (2026-08-22:
// today's Touch-1 batch really drafted at 10:23am AST — 14:23 UTC — the page
// just relabeled the UTC hour as if it were local). Hardcoded, not derived
// from the visitor: this is an internal single-operator admin tool, not a
// public page serving viewers in different zones.
const ADMIN_TZ = "America/Puerto_Rico"; // AST, UTC-4 year-round (no DST)

// Formats a nullable timestamp for dense table cells. Formatting an existing
// Date is fine under the react-compiler purity rules (we never construct one).
export function fmtDate(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: ADMIN_TZ });
}

export function fmtDateTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: ADMIN_TZ });
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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: ADMIN_TZ });
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
    "btn-press rounded-lg border border-line bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-2";
  const disabledClass = "rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-faint";

  return (
    <div className="mt-6 flex items-center justify-between">
      {page > 1 ? (
        <Link href={href(page - 1)} className={linkClass}>
          ← Previous
        </Link>
      ) : (
        <span className={disabledClass}>← Previous</span>
      )}
      <span className="text-sm text-muted">Page {page}</span>
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

// Click-to-call. Phones are stored formatted ("(305) 301-3128"); tel: needs digits.
export function telHref(phone: string): string {
  const d = phone.replace(/\D/g, "");
  return `tel:${d.length === 10 ? `+1${d}` : `+${d}`}`;
}

// A phone number rendered as a click-to-call link (falls back to muted text).
export function PhoneLink({ phone, className = "" }: { phone: string | null | undefined; className?: string }) {
  if (!phone) return <span className="text-faint">—</span>;
  return (
    <a href={telHref(phone)} className={`tabular-nums text-gold hover:underline ${className}`}>
      {phone}
    </a>
  );
}

// A restaurant's own website, opened in a new tab. Used on every page that
// lists restaurants so the site is always one click away.
export function WebsiteLink({ website, className = "" }: { website: string | null | undefined; className?: string }) {
  if (!website) return <span className="text-faint">—</span>;
  return (
    <a href={website} target="_blank" rel="noopener noreferrer" className={`text-gold hover:underline ${className}`}>
      site ↗
    </a>
  );
}

// ---- DataTable -------------------------------------------------------
// Replaces repeated <table> + class-string boilerplate across ~9 pages.
// Server-safe (no hooks) — sorting/filtering stay page-level via searchParams
// links, matching the rest of the console's URL-driven filter pattern.
// `overflow-x-auto` wraps the table, never the page, so wide tables scroll
// in place at narrow viewports instead of blowing out the layout.

export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: "left" | "right";
  className?: string;
};

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  emptyMessage = "Nothing here yet.",
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => React.Key;
  emptyMessage?: string;
}) {
  if (rows.length === 0) return <EmptyState>{emptyMessage}</EmptyState>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line bg-surface-2 text-left text-xs uppercase tracking-wide text-faint">
            {columns.map((c) => (
              <th key={c.key} className={`px-3 py-2.5 font-medium ${c.align === "right" ? "text-right" : "text-left"}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)} className="border-b border-line align-top last:border-0 hover:bg-surface-2">
              {columns.map((c) => (
                <td key={c.key} className={`px-3 py-3 text-text ${c.align === "right" ? "text-right" : ""} ${c.className ?? ""}`}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Field -------------------------------------------------------------
// Replaces local `inputCls`/`field` string constants scattered per-component.
// Placeholder is never the label — label is always a real <label>.

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-medium uppercase tracking-wide text-faint">
        {label}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-xs text-faint">{hint}</p>}
      {error && (
        <p role="alert" className="mt-1 text-xs text-coral">
          {error}
        </p>
      )}
    </div>
  );
}

export const fieldInputClass =
  "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm text-text placeholder:text-faint outline-none focus:border-gold";
