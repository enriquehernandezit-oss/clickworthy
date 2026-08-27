import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks, suppressions } from "@/db/schema";
import { Badge, Funnel, SectionHeading, relTime } from "../ui";
import { getNeedsAttention, type AttentionItem } from "@/lib/photoStats";
import {
  getRunHealth,
  getEmailReadyTrend,
  avgEmailReady,
  getLastSourcingNight,
  getNightFunnel,
  getRejectionBuckets,
  getEmailYield,
  getAnomalies,
  EMAIL_READY_TARGET,
  type TrendRow,
} from "@/lib/pipelineHealth";

// The morning briefing: "did anything break overnight, and did the pipeline
// hit its number?" Ported from scripts/nightly-analysis.ts §1/2/4/5/8 via the
// shared lib/pipelineHealth queries, so the dashboard and the CLI can't
// disagree. Revenue / the 30-day funnel / spend moved to Financials, which
// owns the range picker — this page is health, not money.
//
// Live internal dashboard — always render fresh (never statically prerender,
// which would try to hit the DB at build time).
export const dynamic = "force-dynamic";


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

// Vertical bar chart of email-ready per night against the target. CSS/flex,
// no chart lib — the repo hand-rolls its bars (see financials MonthlyBars).
// Value is printed on every bar (never encoded by height alone), and the
// target shows as a dashed reference line so "are we hitting 20?" is one look.
function NightBars({ trend, target }: { trend: TrendRow[]; target: number }) {
  // Oldest → newest reads left-to-right like a timeline. The query returns
  // newest-first, so reverse. Cap at the last 10 nights for width.
  const data = [...trend].slice(0, 10).reverse();
  const max = Math.max(target, ...data.map((r) => r.queued), 1);
  const targetPct = (target / max) * 100;

  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      {/* items-stretch (default) so each column fills the h-44 height — the
          bars are % of the column, so a content-sized column would collapse
          them to nothing. */}
      <div className="relative flex h-44 gap-2">
        {/* target reference line */}
        <div
          className="pointer-events-none absolute inset-x-0 flex items-center"
          style={{ bottom: `${targetPct}%` }}
        >
          <div className="h-px w-full border-t border-dashed" style={{ borderColor: "var(--gold)" }} />
          <span className="ml-2 shrink-0 font-mono-label text-[10px] text-gold">target {target}</span>
        </div>
        {data.map((r) => {
          const heightPct = Math.max(2, (r.queued / max) * 100);
          const hit = r.queued >= target;
          return (
            <div key={r.night} className="flex flex-1 flex-col items-center justify-end gap-1.5" style={{ minWidth: 0 }}>
              <span className="font-mono-label text-[11px] tabular-nums text-text">{r.queued}</span>
              <div
                className="w-full max-w-[38px] rounded-t"
                style={{
                  height: `${heightPct}%`,
                  background: hit ? "var(--teal)" : "var(--gold)",
                  opacity: r.sourced === 0 ? 0.25 : 1,
                }}
                title={`${r.night}: ${r.queued} email-ready of ${r.sourced} sourced`}
              />
            </div>
          );
        })}
      </div>
      <div className="mt-2 flex gap-2">
        {data.map((r) => (
          <div key={r.night} className="flex-1 text-center font-mono-label text-[9px] text-faint" style={{ minWidth: 0 }}>
            {/* just the MM-DD portion, dropping the (Dy) suffix */}
            {r.night.slice(5, 10)}
          </div>
        ))}
      </div>
    </div>
  );
}

// One rejection bucket as a labeled proportional bar. Rust (a "died" color),
// count + label as text so it never relies on width alone.
function RejectionBars({ buckets }: { buckets: { bucket: string; n: number }[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.n));
  return (
    <div className="flex flex-col gap-2">
      {buckets.map((b) => (
        <div key={b.bucket} className="flex items-center gap-3">
          <div className="w-32 shrink-0 text-xs text-muted">{b.bucket}</div>
          <div className="h-4 flex-1 overflow-hidden rounded bg-surface-2">
            <div className="h-full rounded" style={{ width: `${(b.n / max) * 100}%`, background: "var(--rust)" }} />
          </div>
          <div className="w-8 shrink-0 text-right font-mono-label text-xs tabular-nums text-text">{b.n}</div>
        </div>
      ))}
    </div>
  );
}

const attentionToneClass: Record<AttentionItem["tone"], string> = {
  gold: "border-gold/30 bg-gold/10",
  coral: "border-coral/40 bg-coral/10",
};

export default async function AdminOverviewPage() {
  const night = await getLastSourcingNight();
  const [health, trend, funnel, buckets, emailYield, activity, attention] = await Promise.all([
    getRunHealth(),
    getEmailReadyTrend(10),
    night ? getNightFunnel(night) : Promise.resolve(null),
    night ? getRejectionBuckets(night) : Promise.resolve([]),
    getEmailYield(7),
    getActivity(),
    getNeedsAttention(),
  ]);
  const anomalies = await getAnomalies(night ?? "1970-01-01", funnel);

  const { avg, runNights } = avgEmailReady(trend);
  const latestYield = emailYield.find((r) => r.sites > 0);
  const yieldPct = latestYield ? Math.round((latestYield.emails / latestYield.sites) * 100) : null;

  // The email-ready funnel for last night, as proportional stages.
  const funnelSteps = funnel
    ? [
        { label: "Sourced", value: funnel.sourced },
        { label: "Reached enrichment", value: funnel.sourced - funnel.free_filtered },
        { label: "Email-ready", value: funnel.queued },
      ]
    : [];

  return (
    <>
      {/* Did anything break overnight? — the first question every morning. */}
      <section>
        <SectionHeading>Overnight check</SectionHeading>
        {anomalies.length === 0 ? (
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-4 py-3 text-sm">
            <span className="text-teal">✓</span>
            <span className="text-muted">
              Gates ran normally {night ? `on the ${night} run` : "last run"} — no outage signatures detected.
            </span>
          </div>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {anomalies.map((a, i) => (
              <div
                key={i}
                role="alert"
                className="flex items-start gap-2 rounded-lg border px-4 py-3 text-sm"
                style={{ borderColor: "var(--coral)", background: "color-mix(in oklch, var(--coral) 12%, var(--card))" }}
              >
                <span className="text-coral">⚠</span>
                <span className="text-text">{a}</span>
              </div>
            ))}
          </div>
        )}

        {/* run-health strip */}
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 rounded-lg border border-line bg-surface px-4 py-3 text-xs">
          <HealthStat label="Worker" value={health.ageHours != null ? `booted ${health.ageHours.toFixed(0)}h ago` : "no boot info"} warn={health.bootedAt == null} />
          <HealthStat label="Nightly cap" value={health.nightlyCap != null ? String(health.nightlyCap) : "—"} />
          <HealthStat label="Cities" value={health.cities != null ? String(health.cities) : "—"} />
          <HealthStat label="Outreach" value={health.outreachEnabled ? "enabled" : "off"} warn={!health.outreachEnabled} />
        </div>
      </section>

      {/* The daily work loop — the three guide steps. */}
      <section className="mt-10">
        <SectionHeading>Needs your attention</SectionHeading>
        {attention.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Queue&apos;s clear — nothing waiting on you right now.</p>
        ) : (
          <div className="mt-3 flex flex-col gap-2">
            {attention.map((a, i) => (
              <Link
                key={i}
                href={a.href}
                className={`btn-press flex items-center justify-between gap-3 rounded-lg border px-4 py-3 transition-colors ${attentionToneClass[a.tone]}`}
              >
                <div>
                  <div className="text-sm font-semibold text-text">{a.title}</div>
                  <div className="text-xs text-muted">{a.sub}</div>
                </div>
                <span className="font-mono-label text-lg font-semibold tabular-nums text-text">{a.n}</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* The priority metric. */}
      <section className="mt-10">
        {/* Spelled out because this is easily confused with the Approvals
            count: this counts NEW leads that got a verified email on the night
            they were sourced. The approvals queue is drafts composed today
            from the whole accumulated queued pool, so the two rarely match. */}
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionHeading>Email-ready per night</SectionHeading>
          <span className="text-xs text-muted">
            avg <span className="font-mono-label font-semibold text-text">{avg.toFixed(1)}</span> / run night vs target{" "}
            <span className="font-mono-label text-gold">{EMAIL_READY_TARGET}</span>
            <span className="text-faint"> · {runNights} run nights</span>
          </span>
        </div>
        <p className="mt-2 text-xs text-faint">
          New leads that got a verified email on the night they were sourced. Not the same as the Approvals count —
          drafts are composed from the whole queued pool, which builds up across nights.
        </p>
        <div className="mt-3">
          <NightBars trend={trend} target={EMAIL_READY_TARGET} />
        </div>
      </section>

      {/* Last night's funnel + why leads died, side by side. */}
      <section className="mt-10 grid gap-6 lg:grid-cols-2">
        <div>
          <SectionHeading>Last night&apos;s funnel {night && <span className="text-faint">· {night}</span>}</SectionHeading>
          <p className="mt-2 text-xs text-faint">
            Candidates found → those that survived the free filters and cost money to enrich → those that ended with a
            verified email. Each arrow shows the share lost at that step.
          </p>
          {funnelSteps.length > 0 && funnel && funnel.sourced > 0 ? (
            <div className="mt-3">
              <Funnel steps={funnelSteps} />
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No run recorded yet.</p>
          )}
        </div>
        <div>
          <SectionHeading>Why leads died</SectionHeading>
          <p className="mt-2 text-xs text-faint">Reason each rejected lead was dropped, last night.</p>
          {buckets.length > 0 ? (
            <div className="mt-3">
              <RejectionBars buckets={buckets} />
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">No rejections last night.</p>
          )}
        </div>
      </section>

      {/* Email discovery yield — the stated bottleneck. */}
      <section className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <SectionHeading>Email-discovery yield</SectionHeading>
          {yieldPct != null && (
            <span className="text-xs text-muted">
              latest <span className="font-mono-label font-semibold text-text">{yieldPct}%</span> of website-havers got a verified email
            </span>
          )}
        </div>
        <p className="mt-2 text-xs text-faint">Of leads with a website, the share that finished with a verified email. The real bottleneck — more sourcing can&apos;t fix a low number here.</p>
        {emailYield.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {[...emailYield].reverse().map((r) => {
              const rate = r.sites ? Math.round((r.emails / r.sites) * 100) : null;
              return (
                <div
                  key={r.night}
                  className="rounded-lg border border-line bg-surface px-3 py-2 text-center"
                  title={`${r.night}: ${r.emails} of ${r.sites} leads that had a website finished with a verified email`}
                >
                  <div className="font-mono-label text-[10px] text-faint">{r.night}</div>
                  <div className="font-mono-label text-base font-semibold tabular-nums text-text">{rate != null ? `${rate}%` : "—"}</div>
                  {/* Spell out the fraction — a bare "9/25" reads ambiguously. */}
                  <div className="font-mono-label text-[10px] tabular-nums text-faint">
                    {r.emails} of {r.sites}
                  </div>
                  <div className="text-[9px] leading-tight text-faint">w/ site</div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">No website-havers processed in the window.</p>
        )}
      </section>

      {/* Live event stream — kept as useful context, moved to the bottom. */}
      <section className="mt-10">
        <SectionHeading>Recent activity</SectionHeading>
        {activity.items.length === 0 ? (
          <p className="mt-3 text-sm text-muted">Nothing yet — activity shows up here as the pipeline runs.</p>
        ) : (
          <ul className="mt-4 flex flex-col gap-1">
            {activity.items.map((a, i) => {
              const inner = (
                <div className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-surface-2">
                  <Badge value={a.kind} />
                  <span className="flex-1 text-sm text-muted">{a.text}</span>
                  <span className="whitespace-nowrap text-xs tabular-nums text-faint">{relTime(a.at, activity.nowMs)}</span>
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

function HealthStat({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <span className="font-mono-label text-[10px] uppercase tracking-wider text-faint">{label}</span>
      <span className={`font-mono-label tabular-nums ${warn ? "text-coral" : "text-text"}`}>{value}</span>
    </div>
  );
}
