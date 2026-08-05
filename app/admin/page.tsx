import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks, suppressions, enhancementOrders } from "@/db/schema";
import { SectionHeading, StatChip } from "./ui";

// Live internal dashboard — always render fresh (never statically prerender,
// which would try to hit the DB at build time).
export const dynamic = "force-dynamic";

async function getPipeline() {
  const byStatus = await db
    .select({ status: restaurants.enrichmentStatus, n: sql<number>`count(*)::int` })
    .from(restaurants)
    .groupBy(restaurants.enrichmentStatus);
  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(restaurants);
  return { byStatus, total: total ?? 0 };
}

// Last-7-days numbers. Mirrors worker/jobs/weeklyStats.ts so the dashboard and
// the weekly email never disagree. `weekAgo` is built here, not in the
// component body, to stay clear of the react-compiler purity rule.
async function getWeekly() {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const [{ sent }] = await db
    .select({ sent: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), gte(outreachJobs.sentAt, weekAgo)));

  // Use gte() rather than interpolating the Date into a raw sql`` template —
  // the template passes the Date object straight to the driver, which throws.
  const [{ replied }] = await db
    .select({ replied: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(gte(outreachJobs.repliedAt, weekAgo));

  const [{ supp }] = await db
    .select({ supp: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(gte(suppressions.createdAt, weekAgo));

  const replyRate = (sent ?? 0) > 0 ? `${(((replied ?? 0) / (sent ?? 1)) * 100).toFixed(1)}%` : "n/a";
  return { sent: sent ?? 0, replied: replied ?? 0, replyRate, supp: supp ?? 0 };
}

async function getWork() {
  const [{ drafts }] = await db
    .select({ drafts: sql<number>`count(*) filter (where ${outreachJobs.status} = 'draft')::int` })
    .from(outreachJobs);
  const [{ awaitingEdit }] = await db
    .select({ awaitingEdit: sql<number>`count(*) filter (where ${magicLinks.reviewStatus} = 'awaiting_edit')::int` })
    .from(magicLinks);
  const [{ readyForReview }] = await db
    .select({ readyForReview: sql<number>`count(*) filter (where ${magicLinks.packageStatus} = 'ready_for_review')::int` })
    .from(magicLinks);
  const [{ paid }] = await db
    .select({ paid: sql<number>`count(*) filter (where ${magicLinks.paidAt} is not null)::int` })
    .from(magicLinks);
  const [{ selfServe }] = await db
    .select({ selfServe: sql<number>`count(*)::int` })
    .from(enhancementOrders)
    .where(isNotNull(enhancementOrders.id));

  return {
    drafts: drafts ?? 0,
    awaitingEdit: awaitingEdit ?? 0,
    readyForReview: readyForReview ?? 0,
    paid: paid ?? 0,
    selfServe: selfServe ?? 0,
  };
}

export default async function AdminOverviewPage() {
  const [pipeline, weekly, work] = await Promise.all([getPipeline(), getWeekly(), getWork()]);

  return (
    <>
      <section>
        <SectionHeading>Needs your attention</SectionHeading>
        <div className="mt-3 flex flex-wrap gap-3">
          <StatChip value={work.drafts} label="drafts to review" href="/admin/outreach?status=draft" />
          <StatChip value={work.awaitingEdit} label="replies to edit" href="/admin/samples" />
          <StatChip value={work.readyForReview} label="orders to finish" href="/admin/orders" />
        </div>
      </section>

      <section className="mt-10">
        <SectionHeading>Last 7 days</SectionHeading>
        <div className="mt-3 flex flex-wrap gap-3">
          <StatChip value={weekly.sent} label="touch 1 sent" href="/admin/outreach" />
          <StatChip value={weekly.replied} label="replies" href="/admin/outreach?status=replied" />
          <StatChip value={weekly.replyRate} label="reply rate" />
          <StatChip value={weekly.supp} label="new suppressions" href="/admin/suppressions" />
        </div>
      </section>

      <section className="mt-10">
        <SectionHeading>Pipeline ({pipeline.total} restaurants)</SectionHeading>
        <div className="mt-3 flex flex-wrap gap-3">
          {pipeline.byStatus.map((s) => (
            <StatChip
              key={s.status ?? "unknown"}
              value={s.n}
              label={s.status ?? "unknown"}
              href={s.status ? `/admin/restaurants?status=${encodeURIComponent(s.status)}` : "/admin/restaurants"}
            />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <SectionHeading>Revenue</SectionHeading>
        <div className="mt-3 flex flex-wrap gap-3">
          <StatChip value={work.paid} label="packages paid (all time)" href="/admin/orders" />
          <StatChip value={work.selfServe} label="self-serve orders" href="/admin/orders" />
        </div>
      </section>
    </>
  );
}
