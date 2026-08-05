import Link from "next/link";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks, suppressions, enhancementOrders } from "@/db/schema";
import { Badge, SectionHeading, StatChip, relTime } from "./ui";

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

type Activity = {
  at: Date;
  kind: string; // -> Badge value
  text: string;
  href?: string;
};

// One merged, reverse-chronological feed across the pipeline. Eight small
// queries (each limited) merged + sorted in JS rather than a giant SQL UNION —
// simpler to read, and the row counts here are tiny.
async function getActivity(): Promise<{ items: Activity[]; nowMs: number }> {
  const FEED = 40;
  const nowMs = Date.now();
  const items: Activity[] = [];
  const restHref = (id: number | null) => (id == null ? undefined : `/admin/restaurants/${id}`);

  const sourced = await db
    .select({ id: restaurants.id, name: restaurants.name, at: restaurants.createdAt })
    .from(restaurants)
    .orderBy(desc(restaurants.createdAt))
    .limit(FEED);
  for (const r of sourced) if (r.at) items.push({ at: r.at, kind: "sourced", text: `Sourced ${r.name}`, href: restHref(r.id) });

  // Touch-1 drafts, sends, and bumps — joined once, split by which timestamp fires.
  const jobs = await db
    .select({
      id: outreachJobs.id,
      rid: outreachJobs.restaurantId,
      touchNumber: outreachJobs.touchNumber,
      status: outreachJobs.status,
      draftedAt: outreachJobs.draftedAt,
      sentAt: outreachJobs.sentAt,
      repliedAt: outreachJobs.repliedAt,
      replyBody: outreachJobs.replyBody,
      name: restaurants.name,
    })
    .from(outreachJobs)
    .leftJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .orderBy(sql`coalesce(${outreachJobs.repliedAt}, ${outreachJobs.sentAt}, ${outreachJobs.draftedAt}) desc nulls last`)
    .limit(FEED);
  for (const j of jobs) {
    const who = j.name ?? "(unknown)";
    if (j.draftedAt && !j.sentAt) items.push({ at: j.draftedAt, kind: "draft", text: `Drafted Touch 1 for ${who}`, href: restHref(j.rid) });
    if (j.sentAt) {
      const label = j.status === "bumped" ? "Sent bump to" : j.touchNumber === 2 ? "Sent sample to" : "Sent Touch 1 to";
      items.push({ at: j.sentAt, kind: j.status === "bumped" ? "bumped" : "sent", text: `${label} ${who}`, href: restHref(j.rid) });
    }
    if (j.repliedAt) {
      const snip = j.replyBody ? ` — “${j.replyBody.slice(0, 80)}${j.replyBody.length > 80 ? "…" : ""}”` : "";
      items.push({ at: j.repliedAt, kind: "replied", text: `${who} replied${snip}`, href: restHref(j.rid) });
    }
  }

  // Sample sent, paid, delivered — from magic links (touch-2 sends are the
  // sample-sent event here, so they're excluded from the jobs loop above by
  // living on magicLinks.touch2SentAt, not counted twice).
  const links = await db
    .select({
      rid: magicLinks.restaurantId,
      touch2SentAt: magicLinks.touch2SentAt,
      paidAt: magicLinks.paidAt,
      deliveredAt: magicLinks.deliveredAt,
      name: restaurants.name,
    })
    .from(magicLinks)
    .leftJoin(restaurants, eq(magicLinks.restaurantId, restaurants.id))
    .orderBy(desc(magicLinks.createdAt))
    .limit(FEED);
  for (const l of links) {
    const who = l.name ?? "(unknown)";
    if (l.touch2SentAt) items.push({ at: l.touch2SentAt, kind: "sent", text: `Sent sample to ${who}`, href: restHref(l.rid) });
    if (l.paidAt) items.push({ at: l.paidAt, kind: "completed", text: `💰 ${who} PAID`, href: restHref(l.rid) });
    if (l.deliveredAt) items.push({ at: l.deliveredAt, kind: "completed", text: `Delivered order to ${who}`, href: restHref(l.rid) });
  }

  const supp = await db
    .select({ email: suppressions.email, reason: suppressions.reason, at: suppressions.createdAt })
    .from(suppressions)
    .orderBy(desc(suppressions.createdAt))
    .limit(FEED);
  for (const s of supp) if (s.at) items.push({ at: s.at, kind: "rejected", text: `Suppressed ${s.email} (${s.reason})`, href: "/admin/suppressions" });

  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { items: items.slice(0, FEED), nowMs };
}

export default async function AdminOverviewPage() {
  const [pipeline, weekly, work, activity] = await Promise.all([getPipeline(), getWeekly(), getWork(), getActivity()]);

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

      <section className="mt-10">
        <SectionHeading>Recent activity</SectionHeading>
        {activity.items.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">Nothing yet — activity shows up here as the pipeline runs.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-1">
            {activity.items.map((a, i) => {
              const inner = (
                <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-stone-100">
                  <Badge value={a.kind} />
                  <span className="flex-1 text-sm text-stone-700">{a.text}</span>
                  <span className="whitespace-nowrap text-xs tabular-nums text-stone-400">{relTime(a.at, activity.nowMs)}</span>
                </div>
              );
              return (
                <li key={i}>
                  {a.href ? (
                    <Link href={a.href} className="block">
                      {inner}
                    </Link>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
