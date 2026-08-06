// Shared photo-venture aggregates. Both the company overview (/admin) and the
// photo overview (/admin/photo) call these so their numbers can't disagree.
// All in one file so a schema/pricing change touches one place.

import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders, magicLinks, outreachJobs, restaurants, suppressions } from "@/db/schema";
import { PACKAGES, isPackageId } from "@/lib/packages";
import { DELIVERABILITY } from "@/worker/jobs/sendOutreach";

export type FunnelStep = { label: string; value: number };
export type Revenue = { packageCents: number; selfServeCents: number; totalCents: number; packagePaid: number; selfServeCompleted: number };
export type Deliverability = { sends: number; suppressions: number; rate: number | null; healthy: boolean; sampleReached: boolean };

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

// Actual dollar revenue — package sale cents (from lib/packages.ts) + self-serve
// order totals. Excludes abandoned self-serve checkouts (status='pending' rows
// are inserted BEFORE the Stripe redirect) so the number reflects real income.
export async function getRevenue(): Promise<Revenue> {
  const paidPkgs = await db
    .select({ pkg: magicLinks.packageSelected })
    .from(magicLinks)
    .where(and(isNotNull(magicLinks.paidAt), isNotNull(magicLinks.packageSelected)));
  let packageCents = 0;
  for (const { pkg } of paidPkgs) if (isPackageId(pkg)) packageCents += PACKAGES[pkg].priceCents;

  const [{ selfServeCents, selfServeCompleted }] = await db
    .select({
      // Only completed / processing orders count — pending = the customer never
      // finished checkout, and Stripe never charged them.
      selfServeCents: sql<number>`coalesce(sum(${enhancementOrders.totalCents}) filter (where ${enhancementOrders.status} in ('completed','processing')), 0)::int`,
      selfServeCompleted: sql<number>`count(*) filter (where ${enhancementOrders.status} = 'completed')::int`,
    })
    .from(enhancementOrders);

  return {
    packageCents,
    selfServeCents: selfServeCents ?? 0,
    totalCents: packageCents + (selfServeCents ?? 0),
    packagePaid: paidPkgs.length,
    selfServeCompleted: selfServeCompleted ?? 0,
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
