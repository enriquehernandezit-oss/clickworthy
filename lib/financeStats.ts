// Financial aggregates for /admin/photo/financials and /admin/financials. A
// sibling to lib/photoStats.ts, kept separate because everything here is
// date-range- and assumptions-parameterized (photoStats' functions take no args
// and feed three unrelated pages). Once the ledger is backfilled, photoStats
// getRevenue() is reimplemented on `payments` so the two can't disagree.
//
// SQL rules honored throughout (they will bite otherwise):
//  - jsonb_array_elements throws on non-array jsonb → every use is guarded by
//    `jsonb_typeof(col) = 'array'`.
//  - count()/sum() return bigint, which postgres.js hands back as a STRING → every
//    aggregate is cast `::int`.
//  - a Date interpolated into a sql`` template throws → range bounds are passed as
//    ISO strings cast `::timestamptz`.
//  - db.execute() returns a RowList that IS an array → iterated directly.

import { sql } from "drizzle-orm";
import { db } from "@/db";
import {
  apportionFixedCents,
  buildCostLines,
  sumBucket,
  sumCostLines,
  type CostAssumptions,
  type CostDrivers,
  type CostLine,
} from "@/lib/costs";

// ---------------------------------------------------------------------------
// Date range
// ---------------------------------------------------------------------------

export type RangeKey = "30d" | "90d" | "mtd" | "ytd" | "12m" | "all";

export const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "mtd", label: "Month to date" },
  { key: "ytd", label: "Year to date" },
  { key: "12m", label: "Last 12 months" },
  { key: "all", label: "All time" },
];

export type Range = {
  key: RangeKey;
  label: string;
  from: Date;
  to: Date;
  days: number;
  // Immediately-preceding equal-length window, for KPI deltas.
  prev: { from: Date; to: Date };
};

const DAY_MS = 86_400_000;
// Fixed floor for "all time" — comfortably before the first Clickworthy row.
const EPOCH = new Date("2020-01-01T00:00:00.000Z");

// Plain module function (NOT a component body) so Date.now()/new Date() are fine
// under the react-compiler purity rule. Pages call this from their async loader.
export function resolveRange(sp: Record<string, string | string[] | undefined>): Range {
  const raw = typeof sp.range === "string" ? sp.range : "30d";
  const key: RangeKey = RANGE_OPTIONS.some((o) => o.key === raw) ? (raw as RangeKey) : "30d";
  const now = new Date();
  const to = now;
  let from: Date;

  switch (key) {
    case "90d":
      from = new Date(now.getTime() - 90 * DAY_MS);
      break;
    case "mtd":
      from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      break;
    case "ytd":
      from = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      break;
    case "12m":
      from = new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
      break;
    case "all":
      from = EPOCH;
      break;
    case "30d":
    default:
      from = new Date(now.getTime() - 30 * DAY_MS);
      break;
  }

  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
  const label = RANGE_OPTIONS.find((o) => o.key === key)!.label;
  const prevTo = from;
  const prevFrom = new Date(from.getTime() - (to.getTime() - from.getTime()));
  return { key, label, from, to, days, prev: { from: prevFrom, to: prevTo } };
}

function bounds(from: Date, to: Date) {
  return { fromIso: from.toISOString(), toIso: to.toISOString() };
}

// ---------------------------------------------------------------------------
// Cost drivers (SQL-countable events in a window)
// ---------------------------------------------------------------------------

// Trusted constant list, inlined as a SQL literal (not a bound param) so it's a
// real IN list — interpolating a JS array here would render a tuple and break
// `any((...))`.
const ENRICHED_FILTER = sql`enrichment_status in ('queued', 'needs_manual_email', 'contacted', 'rejected')`;

export async function getCostDrivers(from: Date, to: Date): Promise<CostDrivers> {
  const { fromIso, toIso } = bounds(from, to);

  const [leads] = (await db.execute(sql`
    select
      count(*)::int as sourced,
      count(*) filter (where ${ENRICHED_FILTER})::int as enriched,
      coalesce(sum(coalesce(photo_count, 0)), 0)::int as scored
    from restaurants
    where created_at >= ${fromIso}::timestamptz and created_at < ${toIso}::timestamptz
  `)) as unknown as { sourced: number; enriched: number; scored: number }[];

  const [emails] = (await db.execute(sql`
    select count(*)::int as sent
    from outreach_jobs
    where sent_at >= ${fromIso}::timestamptz and sent_at < ${toIso}::timestamptz
  `)) as unknown as { sent: number }[];

  const [samples] = (await db.execute(sql`
    select count(*)::int as n
    from magic_links
    where created_at >= ${fromIso}::timestamptz and created_at < ${toIso}::timestamptz
  `)) as unknown as { n: number }[];

  const [photos] = (await db.execute(sql`
    with pkg as (
      select
        count(*) filter (where e->>'enhancedUrl' is not null)::int as ok,
        count(*) filter (where e->>'enhancedUrl' is null)::int as failed
      from magic_links ml
      cross join lateral jsonb_array_elements(ml.package_results) e
      where jsonb_typeof(ml.package_results) = 'array'
        and ml.delivered_at >= ${fromIso}::timestamptz and ml.delivered_at < ${toIso}::timestamptz
    ),
    ss as (
      select
        count(*) filter (where e->>'enhancedUrl' is not null)::int as ok,
        count(*) filter (where e->>'enhancedUrl' is null)::int as failed
      from enhancement_orders o
      cross join lateral jsonb_array_elements(o.results) e
      where jsonb_typeof(o.results) = 'array'
        and o.completed_at >= ${fromIso}::timestamptz and o.completed_at < ${toIso}::timestamptz
    )
    select
      (coalesce(pkg.ok,0) + coalesce(ss.ok,0)) as delivered,
      (coalesce(pkg.failed,0) + coalesce(ss.failed,0)) as failed
    from pkg, ss
  `)) as unknown as { delivered: number; failed: number }[];

  return {
    leadsSourced: leads?.sourced ?? 0,
    leadsEnriched: leads?.enriched ?? 0,
    photosScored: leads?.scored ?? 0,
    emailsSent: emails?.sent ?? 0,
    samplesCreated: samples?.n ?? 0,
    photosDelivered: photos?.delivered ?? 0,
    photosFailed: photos?.failed ?? 0,
  };
}

// ---------------------------------------------------------------------------
// P&L for a window
// ---------------------------------------------------------------------------

type RevenueRow = {
  gross: number;
  fee: number;
  refunded: number;
  net: number;
  pkg_gross: number;
  ss_gross: number;
  n: number;
  stripe_fee: number;
  stripe_gross: number;
};

async function getRevenueRow(from: Date, to: Date): Promise<RevenueRow> {
  const { fromIso, toIso } = bounds(from, to);
  const [row] = (await db.execute(sql`
    select
      coalesce(sum(gross_cents), 0)::int as gross,
      coalesce(sum(fee_cents), 0)::int as fee,
      coalesce(sum(refunded_cents), 0)::int as refunded,
      coalesce(sum(net_cents), 0)::int as net,
      coalesce(sum(gross_cents) filter (where line = 'package'), 0)::int as pkg_gross,
      coalesce(sum(gross_cents) filter (where line = 'self_serve'), 0)::int as ss_gross,
      count(*)::int as n,
      coalesce(sum(fee_cents) filter (where fee_source = 'stripe'), 0)::int as stripe_fee,
      coalesce(sum(gross_cents) filter (where fee_source = 'stripe'), 0)::int as stripe_gross
    from payments
    where paid_at >= ${fromIso}::timestamptz and paid_at < ${toIso}::timestamptz
  `)) as unknown as RevenueRow[];
  return row ?? { gross: 0, fee: 0, refunded: 0, net: 0, pkg_gross: 0, ss_gross: 0, n: 0, stripe_fee: 0, stripe_gross: 0 };
}

export type Pnl = {
  grossCents: number;
  packageGrossCents: number;
  selfServeGrossCents: number;
  feeCents: number;
  refundedCents: number;
  netRevenueCents: number; // net - refunded (money actually kept)
  costLines: CostLine[];
  variableCostCents: number;
  acquireCents: number;
  serveCents: number;
  fixedOpexCents: number;
  contributionCents: number; // net revenue - variable cost (excludes fixed opex)
  estimatedProfitCents: number; // contribution - fixed opex
  payments: number;
  actualFeeRate: number | null; // stripe_fee / stripe_gross — reality-check on the estimate
  // Deltas vs the immediately-preceding equal window.
  prev: { grossCents: number; netRevenueCents: number; estimatedProfitCents: number };
};

// Bare revenue+cost math for one window, no `prev` (used for the prev window too).
async function pnlCore(from: Date, to: Date, days: number, a: CostAssumptions) {
  const [rev, drivers] = await Promise.all([getRevenueRow(from, to), getCostDrivers(from, to)]);
  const costLines = buildCostLines(drivers, a);
  const variableCostCents = sumCostLines(costLines);
  const acquireCents = sumBucket(costLines, "acquire");
  const serveCents = sumBucket(costLines, "serve");
  const fixedOpexCents = apportionFixedCents(a, days);
  const netRevenueCents = rev.net - rev.refunded;
  const contributionCents = netRevenueCents - variableCostCents;
  const estimatedProfitCents = contributionCents - fixedOpexCents;
  return {
    rev,
    costLines,
    variableCostCents,
    acquireCents,
    serveCents,
    fixedOpexCents,
    netRevenueCents,
    contributionCents,
    estimatedProfitCents,
  };
}

export async function getPnl(range: Range, a: CostAssumptions): Promise<Pnl> {
  const prevDays = Math.max(1, Math.round((range.prev.to.getTime() - range.prev.from.getTime()) / DAY_MS));
  const [cur, prev] = await Promise.all([
    pnlCore(range.from, range.to, range.days, a),
    pnlCore(range.prev.from, range.prev.to, prevDays, a),
  ]);
  return {
    grossCents: cur.rev.gross,
    packageGrossCents: cur.rev.pkg_gross,
    selfServeGrossCents: cur.rev.ss_gross,
    feeCents: cur.rev.fee,
    refundedCents: cur.rev.refunded,
    netRevenueCents: cur.netRevenueCents,
    costLines: cur.costLines,
    variableCostCents: cur.variableCostCents,
    acquireCents: cur.acquireCents,
    serveCents: cur.serveCents,
    fixedOpexCents: cur.fixedOpexCents,
    contributionCents: cur.contributionCents,
    estimatedProfitCents: cur.estimatedProfitCents,
    payments: cur.rev.n,
    actualFeeRate: cur.rev.stripe_gross > 0 ? cur.rev.stripe_fee / cur.rev.stripe_gross : null,
    prev: {
      grossCents: prev.rev.gross,
      netRevenueCents: prev.netRevenueCents,
      estimatedProfitCents: prev.estimatedProfitCents,
    },
  };
}

// ---------------------------------------------------------------------------
// Monthly series (revenue vs modelled cost)
// ---------------------------------------------------------------------------

export type MonthRow = { month: string; grossCents: number; netRevenueCents: number; costCents: number };

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function daysInMonthKey(key: string): number {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export async function getMonthlySeries(range: Range, a: CostAssumptions): Promise<MonthRow[]> {
  const { fromIso, toIso } = bounds(range.from, range.to);

  // Build the ordered list of month buckets in range (cap at 24 so "all" on a
  // long-lived DB stays a readable chart).
  const months: string[] = [];
  const cursor = new Date(Date.UTC(range.from.getUTCFullYear(), range.from.getUTCMonth(), 1));
  const end = new Date(Date.UTC(range.to.getUTCFullYear(), range.to.getUTCMonth(), 1));
  while (cursor <= end && months.length < 24) {
    months.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  const inRange = (k: string) => months.includes(k);

  const rev = (await db.execute(sql`
    select to_char(date_trunc('month', paid_at), 'YYYY-MM') as month,
           coalesce(sum(gross_cents), 0)::int as gross,
           coalesce(sum(net_cents - refunded_cents), 0)::int as net
    from payments
    where paid_at >= ${fromIso}::timestamptz and paid_at < ${toIso}::timestamptz
    group by 1
  `)) as unknown as { month: string; gross: number; net: number }[];

  const leadsByMonth = (await db.execute(sql`
    select to_char(date_trunc('month', created_at), 'YYYY-MM') as month,
           count(*)::int as sourced,
           count(*) filter (where ${ENRICHED_FILTER})::int as enriched,
           coalesce(sum(coalesce(photo_count, 0)), 0)::int as scored
    from restaurants
    where created_at >= ${fromIso}::timestamptz and created_at < ${toIso}::timestamptz
    group by 1
  `)) as unknown as { month: string; sourced: number; enriched: number; scored: number }[];

  const emailsByMonth = (await db.execute(sql`
    select to_char(date_trunc('month', sent_at), 'YYYY-MM') as month, count(*)::int as sent
    from outreach_jobs
    where sent_at >= ${fromIso}::timestamptz and sent_at < ${toIso}::timestamptz
    group by 1
  `)) as unknown as { month: string; sent: number }[];

  const samplesByMonth = (await db.execute(sql`
    select to_char(date_trunc('month', created_at), 'YYYY-MM') as month, count(*)::int as n
    from magic_links
    where created_at >= ${fromIso}::timestamptz and created_at < ${toIso}::timestamptz
    group by 1
  `)) as unknown as { month: string; n: number }[];

  const photosByMonth = (await db.execute(sql`
    with pkg as (
      select to_char(date_trunc('month', ml.delivered_at), 'YYYY-MM') as month,
             count(*) filter (where e->>'enhancedUrl' is not null)::int as ok,
             count(*) filter (where e->>'enhancedUrl' is null)::int as failed
      from magic_links ml
      cross join lateral jsonb_array_elements(ml.package_results) e
      where jsonb_typeof(ml.package_results) = 'array'
        and ml.delivered_at >= ${fromIso}::timestamptz and ml.delivered_at < ${toIso}::timestamptz
      group by 1
    ),
    ss as (
      select to_char(date_trunc('month', o.completed_at), 'YYYY-MM') as month,
             count(*) filter (where e->>'enhancedUrl' is not null)::int as ok,
             count(*) filter (where e->>'enhancedUrl' is null)::int as failed
      from enhancement_orders o
      cross join lateral jsonb_array_elements(o.results) e
      where jsonb_typeof(o.results) = 'array'
        and o.completed_at >= ${fromIso}::timestamptz and o.completed_at < ${toIso}::timestamptz
      group by 1
    )
    select month, sum(ok)::int as ok, sum(failed)::int as failed from (
      select month, ok, failed from pkg
      union all
      select month, ok, failed from ss
    ) u group by month
  `)) as unknown as { month: string; ok: number; failed: number }[];

  const revMap = new Map(rev.filter((r) => inRange(r.month)).map((r) => [r.month, r]));
  const leadMap = new Map(leadsByMonth.map((r) => [r.month, r]));
  const emailMap = new Map(emailsByMonth.map((r) => [r.month, r]));
  const sampleMap = new Map(samplesByMonth.map((r) => [r.month, r]));
  const photoMap = new Map(photosByMonth.map((r) => [r.month, r]));

  return months.map((m) => {
    const r = revMap.get(m);
    const l = leadMap.get(m);
    const drivers: CostDrivers = {
      leadsSourced: l?.sourced ?? 0,
      leadsEnriched: l?.enriched ?? 0,
      photosScored: l?.scored ?? 0,
      emailsSent: emailMap.get(m)?.sent ?? 0,
      samplesCreated: sampleMap.get(m)?.n ?? 0,
      photosDelivered: photoMap.get(m)?.ok ?? 0,
      photosFailed: photoMap.get(m)?.failed ?? 0,
    };
    const variable = sumCostLines(buildCostLines(drivers, a));
    const fixed = apportionFixedCents(a, daysInMonthKey(m));
    return { month: m, grossCents: r?.gross ?? 0, netRevenueCents: r?.net ?? 0, costCents: variable + fixed };
  });
}

// ---------------------------------------------------------------------------
// Per-client economics (lifetime — "is this client worth it")
// ---------------------------------------------------------------------------

export type ClientVerdict = "worth_it" | "thin" | "underwater";

export type ClientRow = {
  id: number;
  name: string;
  city: string | null;
  isNewOpening: boolean;
  packages: string | null;
  nPayments: number;
  grossCents: number;
  netRevenueCents: number;
  acquireCents: number;
  serveCents: number;
  contributionCents: number;
  marginPct: number | null;
  returnMultiple: number | null;
  verdict: ClientVerdict;
  firstPaid: Date | null;
  lastPaid: Date | null;
};

type ClientSqlRow = {
  id: number;
  name: string;
  city: string | null;
  is_new_opening: boolean | null;
  photo_count: number;
  gross: number;
  refunded: number;
  net: number;
  n_payments: number;
  packages: string | null;
  first_paid: string | null;
  last_paid: string | null;
  sends: number;
  n_links: number;
  photos_ok: number;
  photos_failed: number;
};

// One set-based query, no per-restaurant loop. Lifetime on BOTH sides: "worth it"
// is a lifetime question — you can't un-spend the acquisition cost.
export async function getClientEconomics(a: CostAssumptions): Promise<ClientRow[]> {
  const rows = (await db.execute(sql`
    with pay as (
      select restaurant_id,
             sum(gross_cents)::int as gross,
             sum(refunded_cents)::int as refunded,
             sum(net_cents - refunded_cents)::int as net,
             count(*)::int as n_payments,
             string_agg(distinct package_id, ', ') as packages,
             min(paid_at) as first_paid,
             max(paid_at) as last_paid
      from payments
      where restaurant_id is not null
      group by restaurant_id
    ),
    sends as (
      select restaurant_id, count(*)::int as n
      from outreach_jobs where sent_at is not null group by restaurant_id
    ),
    links as (
      select restaurant_id, count(*)::int as n_links
      from magic_links group by restaurant_id
    ),
    served as (
      select ml.restaurant_id,
             count(*) filter (where e->>'enhancedUrl' is not null)::int as photos_ok,
             count(*) filter (where e->>'enhancedUrl' is null)::int as photos_failed
      from magic_links ml
      cross join lateral jsonb_array_elements(ml.package_results) e
      where jsonb_typeof(ml.package_results) = 'array'
      group by ml.restaurant_id
    )
    select r.id, r.name, r.city, r.is_new_opening,
           coalesce(r.photo_count, 0) as photo_count,
           coalesce(pay.gross, 0) as gross,
           coalesce(pay.refunded, 0) as refunded,
           coalesce(pay.net, 0) as net,
           coalesce(pay.n_payments, 0) as n_payments,
           pay.packages, pay.first_paid, pay.last_paid,
           coalesce(sends.n, 0) as sends,
           coalesce(links.n_links, 0) as n_links,
           coalesce(served.photos_ok, 0) as photos_ok,
           coalesce(served.photos_failed, 0) as photos_failed
    from restaurants r
    join pay on pay.restaurant_id = r.id
    left join sends on sends.restaurant_id = r.id
    left join links on links.restaurant_id = r.id
    left join served on served.restaurant_id = r.id
    order by coalesce(pay.net, 0) desc
  `)) as unknown as ClientSqlRow[];

  return rows.map((r) => clientRowFrom(r, a));
}

function clientRowFrom(r: ClientSqlRow, a: CostAssumptions): ClientRow {
  // Per-client drivers: one lead sourced + enriched, its scored photos, its
  // sends, its samples (magic links), and its served photos.
  const lines = buildCostLines(
    {
      leadsSourced: 1,
      leadsEnriched: 1,
      photosScored: r.photo_count,
      emailsSent: r.sends,
      samplesCreated: r.n_links,
      photosDelivered: r.photos_ok,
      photosFailed: r.photos_failed,
    },
    a
  );
  const acquireCents = sumBucket(lines, "acquire");
  const serveCents = sumBucket(lines, "serve");
  const netRevenueCents = r.net;
  const contributionCents = netRevenueCents - acquireCents - serveCents;
  const spend = acquireCents + serveCents;
  const returnMultiple = spend > 0 ? netRevenueCents / spend : null;
  const marginPct = r.gross > 0 ? contributionCents / r.gross : null;
  const verdict: ClientVerdict =
    contributionCents > 0 && returnMultiple != null && returnMultiple >= 3
      ? "worth_it"
      : contributionCents > 0
        ? "thin"
        : "underwater";
  return {
    id: r.id,
    name: r.name,
    city: r.city,
    isNewOpening: Boolean(r.is_new_opening),
    packages: r.packages,
    nPayments: r.n_payments,
    grossCents: r.gross,
    netRevenueCents,
    acquireCents,
    serveCents,
    contributionCents,
    marginPct,
    returnMultiple,
    verdict,
    firstPaid: r.first_paid ? new Date(r.first_paid) : null,
    lastPaid: r.last_paid ? new Date(r.last_paid) : null,
  };
}

// ---------------------------------------------------------------------------
// Segments (pure rollups over the client rows) + blended CAC
// ---------------------------------------------------------------------------

export type SegmentRow = {
  label: string;
  clients: number;
  grossCents: number;
  netRevenueCents: number;
  acquireCents: number;
  serveCents: number;
  contributionCents: number;
  marginPct: number | null;
};

export type Segments = { byPackage: SegmentRow[]; byOpening: SegmentRow[]; byRepeat: SegmentRow[] };

function aggregate(label: string, rows: ClientRow[]): SegmentRow {
  const gross = rows.reduce((s, r) => s + r.grossCents, 0);
  const contribution = rows.reduce((s, r) => s + r.contributionCents, 0);
  return {
    label,
    clients: rows.length,
    grossCents: gross,
    netRevenueCents: rows.reduce((s, r) => s + r.netRevenueCents, 0),
    acquireCents: rows.reduce((s, r) => s + r.acquireCents, 0),
    serveCents: rows.reduce((s, r) => s + r.serveCents, 0),
    contributionCents: contribution,
    marginPct: gross > 0 ? contribution / gross : null,
  };
}

export function rollUpSegments(rows: ClientRow[]): Segments {
  const byPackageMap = new Map<string, ClientRow[]>();
  for (const r of rows) {
    // A client can span packages; attribute to each distinct package they bought.
    const pkgs = (r.packages ?? "—").split(", ").map((p) => p.trim() || "—");
    for (const p of new Set(pkgs)) {
      if (!byPackageMap.has(p)) byPackageMap.set(p, []);
      byPackageMap.get(p)!.push(r);
    }
  }
  const byPackage = [...byPackageMap.entries()]
    .map(([label, rs]) => aggregate(label, rs))
    .sort((a, b) => b.contributionCents - a.contributionCents);

  const byOpening = [
    aggregate("New opening", rows.filter((r) => r.isNewOpening)),
    aggregate("Established", rows.filter((r) => !r.isNewOpening)),
  ];

  const byRepeat = [
    aggregate("Repeat (2+ payments)", rows.filter((r) => r.nPayments >= 2)),
    aggregate("One-time", rows.filter((r) => r.nPayments < 2)),
  ];

  return { byPackage, byOpening, byRepeat };
}

// ---------------------------------------------------------------------------
// City economics — includes cities where nobody paid (the actionable view)
// ---------------------------------------------------------------------------

export type CityRow = {
  city: string;
  leads: number;
  payers: number;
  acquireCents: number; // modelled spend chasing every lead in the city
  grossCents: number;
  netRevenueCents: number;
};

export async function getCityEconomics(a: CostAssumptions): Promise<CityRow[]> {
  const rows = (await db.execute(sql`
    with pay as (
      select restaurant_id, sum(gross_cents)::int as gross, sum(net_cents - refunded_cents)::int as net
      from payments where restaurant_id is not null group by restaurant_id
    ),
    sends as (
      select restaurant_id, count(*)::int as n from outreach_jobs where sent_at is not null group by restaurant_id
    ),
    links as (
      select restaurant_id, count(*)::int as n from magic_links group by restaurant_id
    )
    select coalesce(r.city, '—') as city,
           count(*)::int as leads,
           count(pay.restaurant_id)::int as payers,
           coalesce(sum(coalesce(r.photo_count, 0)), 0)::int as scored,
           coalesce(sum(coalesce(sends.n, 0)), 0)::int as sends,
           coalesce(sum(coalesce(links.n, 0)), 0)::int as n_links,
           coalesce(sum(coalesce(pay.gross, 0)), 0)::int as gross,
           coalesce(sum(coalesce(pay.net, 0)), 0)::int as net
    from restaurants r
    left join pay on pay.restaurant_id = r.id
    left join sends on sends.restaurant_id = r.id
    left join links on links.restaurant_id = r.id
    group by coalesce(r.city, '—')
    order by gross desc, leads desc
  `)) as unknown as {
    city: string;
    leads: number;
    payers: number;
    scored: number;
    sends: number;
    n_links: number;
    gross: number;
    net: number;
  }[];

  return rows.map((r) => {
    // Acquisition spend chasing the whole city (every lead sourced+enriched+scored,
    // every send, every sample), regardless of whether they bought.
    const lines = buildCostLines(
      {
        leadsSourced: r.leads,
        leadsEnriched: r.leads,
        photosScored: r.scored,
        emailsSent: r.sends,
        samplesCreated: r.n_links,
        photosDelivered: 0,
        photosFailed: 0,
      },
      a
    );
    return {
      city: r.city,
      leads: r.leads,
      payers: r.payers,
      acquireCents: sumBucket(lines, "acquire"),
      grossCents: r.gross,
      netRevenueCents: r.net,
    };
  });
}

// ---------------------------------------------------------------------------
// Self-serve (unattributed) — grouped by customer email
// ---------------------------------------------------------------------------

export type SelfServeRow = {
  email: string | null;
  orders: number;
  grossCents: number;
  netRevenueCents: number;
  lastPaid: Date | null;
  repeat: boolean;
  inferredRestaurant: string | null; // a known lead with the same email
};

export async function getUnattributed(range: Range): Promise<SelfServeRow[]> {
  const { fromIso, toIso } = bounds(range.from, range.to);
  const rows = (await db.execute(sql`
    select p.customer_email as email,
           count(*)::int as orders,
           sum(p.gross_cents)::int as gross,
           sum(p.net_cents - p.refunded_cents)::int as net,
           max(p.paid_at) as last_paid,
           (select r.name from restaurants r
             where p.customer_email is not null and lower(r.email) = lower(p.customer_email)
             limit 1) as inferred
    from payments p
    where p.line = 'self_serve'
      and p.paid_at >= ${fromIso}::timestamptz and p.paid_at < ${toIso}::timestamptz
    group by p.customer_email
    order by gross desc
    limit 100
  `)) as unknown as {
    email: string | null;
    orders: number;
    gross: number;
    net: number;
    last_paid: string | null;
    inferred: string | null;
  }[];

  return rows.map((r) => ({
    email: r.email,
    orders: r.orders,
    grossCents: r.gross,
    netRevenueCents: r.net,
    lastPaid: r.last_paid ? new Date(r.last_paid) : null,
    repeat: r.orders >= 2,
    inferredRestaurant: r.inferred,
  }));
}

// Distinct paying clients in a window (a restaurant, or a self-serve email).
export async function getPayingClientCount(from: Date, to: Date): Promise<number> {
  const { fromIso, toIso } = bounds(from, to);
  const [row] = (await db.execute(sql`
    select count(distinct coalesce(restaurant_id::text, 'email:' || lower(customer_email)))::int as n
    from payments
    where paid_at >= ${fromIso}::timestamptz and paid_at < ${toIso}::timestamptz
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Venture summary — the reusable shape the company roll-up composes
// ---------------------------------------------------------------------------

export type VentureFinancials = {
  slug: string;
  name: string;
  accent: string;
  live: boolean;
  grossCents: number;
  feeCents: number;
  refundedCents: number;
  netRevenueCents: number;
  variableCostCents: number;
  contributionCents: number;
  payingClients: number;
  costLines: CostLine[];
};

export async function getVentureSummary(range: Range, a: CostAssumptions): Promise<VentureFinancials> {
  const [pnl, payingClients] = await Promise.all([getPnl(range, a), getPayingClientCount(range.from, range.to)]);
  return {
    slug: "photo",
    name: "Photo Enhancement",
    accent: "#E3A83B",
    live: true,
    grossCents: pnl.grossCents,
    feeCents: pnl.feeCents,
    refundedCents: pnl.refundedCents,
    netRevenueCents: pnl.netRevenueCents,
    variableCostCents: pnl.variableCostCents,
    contributionCents: pnl.contributionCents,
    payingClients,
    costLines: pnl.costLines,
  };
}
