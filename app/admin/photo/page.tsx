import Link from "next/link";
import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks, suppressions, enhancementOrders } from "@/db/schema";
import { Badge, Funnel, KpiCard, SectionHeading, StatChip, money, relTime } from "../ui";
import { getFunnel, getRevenue, getByCity } from "@/lib/photoStats";

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
  // Matches getNeedsAttention()'s scope in lib/photoStats.ts — every kind that
  // queues a draft awaiting a human decision (touch1/bump/reply/payment_confirmation).
  const [{ drafts }] = await db
    .select({
      drafts: sql<number>`count(*) filter (where ${outreachJobs.status} = 'draft' and ${outreachJobs.kind} in ('touch1','bump','reply','payment_confirmation'))::int`,
    })
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
  const restHref = (id: number | null) => (id == null ? undefined : `/admin/photo/restaurants/${id}`);

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
      jobKind: outreachJobs.kind,
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
    const isBump = j.jobKind === "bump" || j.status === "bumped"; // legacy rows predate `kind`

    if (j.draftedAt && !j.sentAt) {
      const label =
        isBump ? "Drafted a bump for"
        : j.jobKind === "reply" ? "Drafted a reply for"
        : j.jobKind === "payment_confirmation" ? "Drafted a payment confirmation for"
        : "Drafted Touch 1 for";
      items.push({ at: j.draftedAt, kind: "draft", text: `${label} ${who}`, href: restHref(j.rid) });
    }
    // touch2/delivery sends are excluded here — they're already represented in
    // the magicLinks loop below (touch2SentAt / deliveredAt), same event.
    if (j.sentAt && j.jobKind !== "touch2" && j.jobKind !== "delivery") {
      const label =
        isBump ? "Sent bump to"
        : j.jobKind === "reply" ? "Replied to"
        : j.jobKind === "payment_confirmation" ? "Sent payment confirmation to"
        : j.touchNumber === 2 ? "Sent sample to"
        : "Sent Touch 1 to";
      items.push({ at: j.sentAt, kind: isBump ? "bumped" : "sent", text: `${label} ${who}`, href: restHref(j.rid) });
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
  for (const s of supp) if (s.at) items.push({ at: s.at, kind: "rejected", text: `Suppressed ${s.email} (${s.reason})`, href: "/admin/photo/suppressions" });

  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return { items: items.slice(0, FEED), nowMs };
}

export default async function AdminOverviewPage() {
  const [pipeline, weekly, work, activity, funnel, revenue, byCity] = await Promise.all([
    getPipeline(),
    getWeekly(),
    getWork(),
    getActivity(),
    getFunnel(),
    getRevenue(),
    getByCity(),
  ]);

  return (
    <>
      <section>
        <SectionHeading>Needs your attention</SectionHeading>
        <div className="mt-3 flex flex-wrap gap-3">
          <StatChip value={work.drafts} label="awaiting approval" href="/admin/photo/approvals" />
          <StatChip value={work.awaitingEdit} label="replies to edit" href="/admin/photo/samples" />
          <StatChip value={work.readyForReview} label="orders to finish" href="/admin/photo/orders" />
        </div>
      </section>

      <section className="mt-10">
        <SectionHeading>Last 7 days</SectionHeading>
        <div className="mt-3 flex flex-wrap gap-3">
          <StatChip value={weekly.sent} label="touch 1 sent" href="/admin/photo/outreach" />
          <StatChip value={weekly.replied} label="replies" href="/admin/photo/outreach?status=replied" />
          <StatChip value={weekly.replyRate} label="reply rate" />
          <StatChip value={weekly.supp} label="new suppressions" href="/admin/photo/suppressions" />
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
              href={s.status ? `/admin/photo/restaurants?status=${encodeURIComponent(s.status)}` : "/admin/photo/restaurants"}
            />
          ))}
        </div>
      </section>

      <section className="mt-10">
        <SectionHeading>Revenue (all time)</SectionHeading>
        <div className="mt-3 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
          <KpiCard label="Total revenue" value={money(revenue.totalCents)} />
          <KpiCard label="Package sales" value={money(revenue.packageCents)} delta={{ text: `${revenue.packagePaid} paid`, dir: "flat" }} href="/admin/photo/orders" />
          <KpiCard label="Self-serve" value={money(revenue.selfServeCents)} delta={{ text: `${revenue.selfServeCompleted} completed · abandoned checkouts excluded`, dir: "flat" }} href="/admin/photo/orders" />
          <KpiCard label="Reply rate (7d)" value={weekly.replyRate} />
        </div>
      </section>

      {/* Funnel — last 30 days */}
      <section className="mt-10">
        <SectionHeading>Funnel (last 30 days)</SectionHeading>
        {funnel.sentCount === 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--c-text-muted)" }}>
            No Touch 1 sent in the last 30 days — funnel shows up once real outreach starts.
          </p>
        ) : (
          <div className="mt-3">
            <Funnel steps={funnel.steps} />
          </div>
        )}
      </section>

      {/* Per-city breakdown */}
      <section className="mt-10">
        <SectionHeading>By city</SectionHeading>
        {byCity.length === 0 ? (
          <p className="mt-3 text-sm" style={{ color: "var(--c-text-muted)" }}>No restaurants sourced yet.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide" style={{ borderColor: "var(--line)", color: "var(--c-text-muted)" }}>
                  <th scope="col" className="px-3 py-2 font-semibold">City</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Total</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Queued</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Contacted</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Needs email</th>
                  <th scope="col" className="px-3 py-2 font-semibold">Rejected</th>
                </tr>
              </thead>
              <tbody>
                {byCity.map((c) => (
                  <tr key={c.city ?? "unknown"} className="border-b" style={{ borderColor: "var(--line)" }}>
                    <td className="px-3 py-2 font-medium">{c.city ?? "(no city)"}</td>
                    <td className="px-3 py-2 tabular-nums">{c.total}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{c.queued}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{c.contacted}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{c.needsManual}</td>
                    <td className="px-3 py-2 tabular-nums text-stone-600">{c.rejected}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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
