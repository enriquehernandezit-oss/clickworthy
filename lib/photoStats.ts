// Shared photo-venture aggregates. Both the company overview (/admin) and the
// photo overview (/admin/photo) call these so their numbers can't disagree.
// All in one file so a schema/pricing change touches one place.

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, outreachJobs, restaurants, suppressions, payments, enhancementOrders } from "@/db/schema";
import { DELIVERABILITY } from "@/worker/jobs/sendOutreach";

export type FunnelStep = { label: string; value: number };
export type Revenue = { packageCents: number; selfServeCents: number; totalCents: number; packagePaid: number; selfServeCompleted: number };
export type Deliverability = { sends: number; suppressions: number; rate: number | null; healthy: boolean; sampleReached: boolean };
export type AttentionItem = { title: string; sub: string; href: string; n: number; tone: "coral" | "gold" };

// Conversion funnel over the last 30 days. Each step counts rows that HAVE
// reached it — not net conversions between steps. Sent uses sentAt (regardless
// of later status). Paid/delivered use paidAt/deliveredAt.
export async function getFunnel(): Promise<{ steps: FunnelStep[]; sentCount: number }> {
  const monthAgo = new Date(Date.now() - 30 * 86_400_000);

  const [{ sent }] = await db
    .select({ sent: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), gte(outreachJobs.sentAt, monthAgo)));
  const [{ replied }] = await db
    .select({ replied: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(gte(outreachJobs.repliedAt, monthAgo));
  // "Sample sent" — Touch 2 fired against a magic link.
  const [{ sampleSent }] = await db
    .select({ sampleSent: sql<number>`count(*)::int` })
    .from(magicLinks)
    .where(gte(magicLinks.touch2SentAt, monthAgo));
  const [{ viewed }] = await db
    .select({ viewed: sql<number>`count(*)::int` })
    .from(magicLinks)
    .where(gte(magicLinks.viewedAt, monthAgo));
  const [{ paid }] = await db
    .select({ paid: sql<number>`count(*)::int` })
    .from(magicLinks)
    .where(gte(magicLinks.paidAt, monthAgo));

  return {
    sentCount: sent ?? 0,
    steps: [
      { label: "Sent", value: sent ?? 0 },
      { label: "Replied", value: replied ?? 0 },
      { label: "Sample sent", value: sampleSent ?? 0 },
      { label: "Viewed funnel", value: viewed ?? 0 },
      { label: "Paid", value: paid ?? 0 },
    ],
  };
}

// Actual dollar revenue, read from the payments ledger (the single source of
// truth since the backfill). Package revenue is the amount ACTUALLY PAID,
// snapshotted per row — not re-derived from magicLinks.packageSelected, which
// over-counts when a paid customer later clicks a different tier. selfServeCompleted
// now counts recorded self-serve payments rather than 'completed' order rows.
export async function getRevenue(): Promise<Revenue> {
  const [row] = await db
    .select({
      packageCents: sql<number>`coalesce(sum(${payments.grossCents}) filter (where ${payments.line} = 'package'), 0)::int`,
      selfServeCents: sql<number>`coalesce(sum(${payments.grossCents}) filter (where ${payments.line} = 'self_serve'), 0)::int`,
      totalCents: sql<number>`coalesce(sum(${payments.grossCents}), 0)::int`,
      packagePaid: sql<number>`count(*) filter (where ${payments.line} = 'package')::int`,
      selfServeCompleted: sql<number>`count(*) filter (where ${payments.line} = 'self_serve')::int`,
    })
    .from(payments);

  return {
    packageCents: row?.packageCents ?? 0,
    selfServeCents: row?.selfServeCents ?? 0,
    totalCents: row?.totalCents ?? 0,
    packagePaid: row?.packagePaid ?? 0,
    selfServeCompleted: row?.selfServeCompleted ?? 0,
  };
}

// Per-city breakdown of the pipeline. City is a free text field on `restaurants`;
// this groups by exact match, so seed data with "Miami, FL" and "Miami,FL" would
// show as two rows — deliberate, since it surfaces the inconsistency.
export async function getByCity() {
  return db
    .select({
      city: restaurants.city,
      total: sql<number>`count(*)::int`,
      queued: sql<number>`count(*) filter (where ${restaurants.enrichmentStatus} = 'queued')::int`,
      contacted: sql<number>`count(*) filter (where ${restaurants.enrichmentStatus} = 'contacted')::int`,
      rejected: sql<number>`count(*) filter (where ${restaurants.enrichmentStatus} = 'rejected')::int`,
      needsManual: sql<number>`count(*) filter (where ${restaurants.enrichmentStatus} = 'needs_manual_email')::int`,
    })
    .from(restaurants)
    .groupBy(restaurants.city)
    .orderBy(sql`count(*) desc`);
}

// Deliverability guard status — same 7-day-rate + 8%-threshold rule the send
// job uses. Surfaced on Controls so a silent auto-pause is visible.
export async function getDeliverability(): Promise<Deliverability> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [{ sends }] = await db
    .select({ sends: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), gte(outreachJobs.sentAt, weekAgo)));
  const [{ supp }] = await db
    .select({ supp: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(gte(suppressions.createdAt, weekAgo));

  const s = sends ?? 0;
  const sup = supp ?? 0;
  const sampleReached = s >= DELIVERABILITY.sampleMin;
  const rate = s > 0 ? sup / s : null;
  const healthy = !sampleReached || rate === null || rate <= DELIVERABILITY.rateMax;
  return { sends: s, suppressions: sup, rate, healthy, sampleReached };
}

// The cross-venture "needs a human" work list. Shared by /admin (the Needs
// Attention card) and /admin/guide (the daily-loop checklist) so the two can't
// silently disagree about what's outstanding — same principle as the rest of
// this file: one query, every consumer reads it the same way.
export async function getNeedsAttention(): Promise<AttentionItem[]> {
  // Every kind that queues a draft awaiting a human decision — Touch 1, the
  // bump, a reply, and a payment confirmation. Touch 2 and delivery aren't
  // counted here: both are reviewed and sent in one screen the moment they're
  // triggered (Samples / Orders), so there's never a queued draft for them.
  const [{ drafts }] = await db
    .select({
      drafts: sql<number>`count(*) filter (where ${outreachJobs.status} = 'draft' and ${outreachJobs.kind} in ('touch1','bump','reply','payment_confirmation'))::int`,
    })
    .from(outreachJobs);
  const [{ replies }] = await db
    .select({ replies: sql<number>`count(*) filter (where ${magicLinks.reviewStatus} = 'awaiting_edit')::int` })
    .from(magicLinks);
  const [{ orders }] = await db
    .select({ orders: sql<number>`count(*) filter (where ${magicLinks.packageStatus} = 'ready_for_review')::int` })
    .from(magicLinks);
  // Excludes 'failed' — that gets its own more specific bucket below (a
  // generic "not yet delivered" undersells a paid order that's actually
  // broken and needs a Retry click, not just more waiting).
  //
  // The `package_status is null` disjunct is load-bearing, not redundant:
  // `NULL not in (...)` evaluates to NULL (not true) in SQL, and `filter (where
  // NULL)` drops the row. packageStatus is exactly NULL in the paid→uploaded
  // window — the most common post-sale state and the one this counter names
  // ("awaiting upload or delivery"). Without the disjunct, a paid customer who
  // hasn't uploaded yet is invisible in every work list.
  const [{ undelivered }] = await db
    .select({
      undelivered: sql<number>`count(*) filter (where ${magicLinks.paidAt} is not null and ${magicLinks.deliveredAt} is null and (${magicLinks.packageStatus} is null or ${magicLinks.packageStatus} not in ('ready_for_review', 'failed')))::int`,
    })
    .from(magicLinks);
  const [{ failedPackages }] = await db
    .select({ failedPackages: sql<number>`count(*) filter (where ${magicLinks.packageStatus} = 'failed')::int` })
    .from(magicLinks);
  const [{ failedOrders }] = await db
    .select({ failedOrders: sql<number>`count(*) filter (where ${enhancementOrders.status} = 'failed')::int` })
    .from(enhancementOrders);

  // Same 1h threshold worker/jobs/processEnhancementOrders.ts uses to attempt
  // auto-recovery — this count is a display-only backstop for anything that
  // recovery couldn't fix (still unpaid in Stripe, or Stripe isn't configured).
  const stuckCutoff = new Date(Date.now() - 3_600_000);
  const [{ stuckPending }] = await db
    .select({ stuckPending: sql<number>`count(*)::int` })
    .from(enhancementOrders)
    .where(and(eq(enhancementOrders.status, "pending"), lt(enhancementOrders.createdAt, stuckCutoff)));

  // Orders marked delivered whose customer email FAILED to send (Resend down,
  // no email on file). The order still completed — so it's invisible in every
  // other queue — but the customer was never told their photos are ready. We
  // count magic links whose MOST RECENT delivery attempt is 'cancelled', so a
  // successful resend (which writes a newer 'sent' row) clears it.
  const failedDeliveryRows = (await db.execute(sql`
    select count(*)::int as n from (
      select distinct on (magic_link_id) status
      from outreach_jobs
      where kind = 'delivery' and magic_link_id is not null
      order by magic_link_id, drafted_at desc
    ) latest
    where status = 'cancelled'
  `)) as unknown as { n: number }[];
  const failedDelivery = failedDeliveryRows[0]?.n ?? 0;

  const items: AttentionItem[] = [];
  if (drafts) items.push({ title: `${drafts} email${drafts > 1 ? "s" : ""} awaiting your approval`, sub: "Photo Enhancement · nothing sends until you approve or send it", href: "/admin/photo/approvals", n: drafts, tone: "gold" });
  if (replies) items.push({ title: `${replies} repl${replies > 1 ? "ies" : "y"} to edit`, sub: "Photo Enhancement · edit + approve the free sample", href: "/admin/photo/samples", n: replies, tone: "coral" });
  if (orders) items.push({ title: `${orders} paid order${orders > 1 ? "s" : ""} to finish`, sub: "Photo Enhancement · finish + deliver", href: "/admin/photo/orders", n: orders, tone: "coral" });
  if (undelivered) items.push({ title: `${undelivered} paid, not yet delivered`, sub: "Photo Enhancement · awaiting upload or delivery", href: "/admin/photo/orders", n: undelivered, tone: "gold" });
  if (failedPackages) items.push({ title: `${failedPackages} paid package${failedPackages > 1 ? "s" : ""} failed`, sub: "Photo Enhancement · every photo errored — retry from the order row", href: "/admin/photo/orders", n: failedPackages, tone: "coral" });
  if (failedOrders) items.push({ title: `${failedOrders} self-serve order${failedOrders > 1 ? "s" : ""} failed`, sub: "Photo Enhancement · retry or refund", href: "/admin/photo/orders", n: failedOrders, tone: "coral" });
  if (stuckPending) items.push({ title: `${stuckPending} self-serve order${stuckPending > 1 ? "s" : ""} stuck pending >1h`, sub: "Photo Enhancement · may be a Stripe webhook problem — check Setup", href: "/admin/photo/orders", n: stuckPending, tone: "coral" });
  if (failedDelivery) items.push({ title: `${failedDelivery} delivery email${failedDelivery > 1 ? "s" : ""} failed to send`, sub: "Photo Enhancement · order delivered but the customer wasn't emailed — resend from the order row", href: "/admin/photo/orders", n: failedDelivery, tone: "coral" });
  return items;
}
