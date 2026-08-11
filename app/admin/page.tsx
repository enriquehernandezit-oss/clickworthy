import Link from "next/link";
import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { outreachJobs, magicLinks } from "@/db/schema";
import { KpiCard, ConsoleCard, Pill, money } from "./ui";
import { getRevenue, getNeedsAttention } from "@/lib/photoStats";

// Company overview — the venture switcher's home. Aggregate KPIs across every
// venture (only Photo is built, so it's the only contributor today), the product
// grid, and a cross-venture "Needs attention" list that links straight into the
// work. G6 adds dollars + the conversion funnel on the Photo overview.
export const dynamic = "force-dynamic";

async function getPhotoAggregate() {
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  // "Sent" = a Touch 1 that actually went out (sentAt set), regardless of what
  // it became afterward. Filtering on status='sent' would drop rows that later
  // moved to 'replied'/'bumped' — i.e. undercount exactly the successful ones.
  const [{ sent }] = await db
    .select({ sent: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), gte(outreachJobs.sentAt, monthAgo)));
  const [{ replied }] = await db
    .select({ replied: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(gte(outreachJobs.repliedAt, monthAgo));

  // "Active projects" = magic links currently mid-production: a sample being
  // edited, a paid package being finished, or paid-but-not-yet-delivered.
  const [{ active }] = await db
    .select({
      active: sql<number>`count(*) filter (where ${magicLinks.reviewStatus} = 'awaiting_edit'
        or ${magicLinks.packageStatus} = 'ready_for_review'
        or (${magicLinks.paidAt} is not null and ${magicLinks.deliveredAt} is null))::int`,
    })
    .from(magicLinks);

  const rate = (sent ?? 0) > 0 ? `${(((replied ?? 0) / (sent ?? 1)) * 100).toFixed(1)}%` : "—";
  return { sent: sent ?? 0, replied: replied ?? 0, rate, active: active ?? 0 };
}

type Product = { slug: string; name: string; desc: string; accent: string; accentSoft: string; live: boolean; icon: React.ReactNode };

export default async function CompanyOverview() {
  const [photo, attention, revenue] = await Promise.all([getPhotoAggregate(), getNeedsAttention(), getRevenue()]);

  const products: Product[] = [
    { slug: "photo", name: "Photo Enhancement", desc: "High-ticket AI photo enhancement for restaurants and SMEs.", accent: "#E3A83B", accentSoft: "#FBF0DA", live: true,
      icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="M4 8h3l1.5-2h7L17 8h3a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" /><circle cx="12" cy="13.5" r="3.5" /></svg>) },
    { slug: "hvac", name: "HVAC AI Appointment Setter", desc: "Rev-share on booked appointments for HVAC companies.", accent: "#2F7A6F", accentSoft: "#E1EEEB", live: false,
      icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="M12 2v20M2 12h20M5.5 5.5l13 13M18.5 5.5l-13 13" /></svg>) },
    { slug: "analytics", name: "AI SMB Analytics Dashboard", desc: "High-ticket entryway; cross-sells into the full suite.", accent: "#6B5CA5", accentSoft: "#EAE6F5", live: false,
      icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="M4 20V10M12 20V4M20 20v-7" /></svg>) },
    { slug: "realestate", name: "RE Broker Listing Videos", desc: "Mid-to-high ticket listing video production for brokers.", accent: "#C1583F", accentSoft: "#F6E4DF", live: false,
      icon: (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="h-5 w-5"><path d="M3 10l9-7 9 7v10a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V10z" /></svg>) },
  ];

  return (
    <div>
      <div className="mb-6">
        <div className="font-mono-label text-[11px] uppercase tracking-wider" style={{ color: "var(--c-text-muted)" }}>
          All products · Last 30 days
        </div>
        <h1 className="font-display text-[22px] font-bold tracking-tight" style={{ color: "var(--c-text)" }}>Business overview</h1>
        <p className="mt-1 max-w-xl text-sm" style={{ color: "var(--c-text-muted)" }}>
          Every ClickWorthy venture in one console. Only Photo Enhancement is built today — the rest contribute nothing to these totals yet.
        </p>
      </div>

      {/* Aggregate KPIs (Photo is the only contributor today) */}
      <div className="mb-6 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        <KpiCard label="Total revenue (all time)" value={money(revenue.totalCents)} />
        <KpiCard label="Outreach sent (30d)" value={photo.sent} />
        <KpiCard label="Blended response rate" value={photo.rate} />
        <KpiCard label="Active projects" value={photo.active} />
      </div>

      {/* Product grid */}
      <div className="mb-6 font-display text-sm font-semibold" style={{ color: "var(--c-text)" }}>Products</div>
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
        {products.map((p) => (
          <Link key={p.slug} href={`/admin/${p.slug}`} className="rounded-xl border p-5 transition-transform hover:-translate-y-0.5" style={{ background: "var(--card)", borderColor: "var(--line)" }}>
            <div className="flex items-start justify-between">
              <div>
                <div className="font-display text-[15px] font-bold" style={{ color: "var(--c-text)" }}>{p.name}</div>
                <div className="mt-1 text-xs" style={{ color: "var(--c-text-muted)" }}>{p.desc}</div>
              </div>
              <div className="flex h-[38px] w-[38px] items-center justify-center rounded-[10px]" style={{ background: p.accentSoft, color: p.accent }}>{p.icon}</div>
            </div>
            <div className="mt-4 flex items-center gap-6 border-t pt-3.5" style={{ borderColor: "var(--line)" }}>
              {p.live ? (
                <>
                  <MiniStat label="Sent (30d)" value={photo.sent} />
                  <MiniStat label="Replies (30d)" value={photo.replied} />
                  <MiniStat label="Active" value={photo.active} />
                </>
              ) : (
                <span className="rounded-md px-2 py-1 font-mono-label text-[10px] font-semibold uppercase tracking-wider" style={{ background: p.accentSoft, color: p.accent }}>Not built yet</span>
              )}
            </div>
          </Link>
        ))}
      </div>

      {/* Needs attention */}
      <ConsoleCard title="Needs attention" sub="Actionable items across every product">
        {attention.length === 0 ? (
          <p className="px-5 py-6 text-sm" style={{ color: "var(--c-text-muted)" }}>Nothing needs you right now — the queues are clear.</p>
        ) : (
          <div>
            {attention.map((a, i) => (
              <Link key={i} href={a.href} className="flex items-center gap-3 border-b px-5 py-3 transition-colors last:border-b-0 hover:bg-black/[0.02]" style={{ borderColor: "var(--line)" }}>
                <span className="h-[7px] w-[7px] flex-shrink-0 rounded-full" style={{ background: a.tone === "coral" ? "var(--coral)" : "var(--gold)" }} />
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold" style={{ color: "var(--c-text)" }}>{a.title}</div>
                  <div className="text-xs" style={{ color: "var(--c-text-muted)" }}>{a.sub}</div>
                </div>
                <Pill tone={a.tone}>{a.n}</Pill>
              </Link>
            ))}
          </div>
        )}
      </ConsoleCard>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="font-mono-label text-[10px] uppercase tracking-wider" style={{ color: "var(--c-text-muted)" }}>{label}</div>
      <div className="font-display text-base font-bold tabular-nums" style={{ color: "var(--c-text)" }}>{value}</div>
    </div>
  );
}
