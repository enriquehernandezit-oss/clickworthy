// Shared pipeline-health queries — the SINGLE source of truth for the nightly
// diagnostic. Both scripts/nightly-analysis.ts (terminal) and the
// /admin/photo briefing page import from here, so the "how did last night go?"
// numbers can't drift between the CLI and the dashboard. This is the same
// discipline getWeekly() already follows by mirroring weeklyStats.ts — four
// separate measurement bugs in one day (2026-08-25) all traced to the same
// metric being computed in two places that disagreed.
//
// Every function returns plain data; formatting (padStart columns in the
// script, JSX on the page) stays with the caller. READ-ONLY — computes, never
// writes.

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { getSetting } from "@/lib/settings";

// created_at is a naive UTC timestamp; bucket it in AST so a "night" lines up
// with the calendar day you'd call "last night" (the 02:17 UTC cron = 22:17
// AST the prior evening). Shared by every date-bucketed query below.
const AST_DAY = sql`date_trunc('day', (created_at at time zone 'UTC') at time zone 'America/Puerto_Rico')`;

// The stated priority metric's target: email-ready leads per run night.
export const EMAIL_READY_TARGET = 20;

const asRows = <T>(r: unknown) => r as T[];

// ── Run health (§1) ─────────────────────────────────────────────────────────
export type RunHealth = {
  bootedAt: string | null;
  ageHours: number | null;
  nightlyCap: number | null;
  cities: number | null;
  outreachEnabled: boolean;
};

// nowMs defaults to call time. Optional so a React Server Component can call
// getRunHealth() without a Date.now() in its render body (react-hooks/purity);
// the CLI script still passes an explicit value. This function is already
// impure (it hits the DB), so reading the clock here is fine.
export async function getRunHealth(nowMs: number = Date.now()): Promise<RunHealth> {
  const boot = (await getSetting("worker_boot_info")) as
    | { bootedAt?: string; nightlyEnrichCap?: number; cities?: string[]; outreachEnabled?: boolean }
    | null;
  const bootedAt = boot?.bootedAt ?? null;
  return {
    bootedAt,
    ageHours: bootedAt ? (nowMs - Date.parse(bootedAt)) / 3_600_000 : null,
    nightlyCap: boot?.nightlyEnrichCap ?? null,
    cities: boot?.cities?.length ?? null,
    outreachEnabled: Boolean(boot?.outreachEnabled),
  };
}

// Live Anthropic reachability probe — a depleted balance / usage cap silently
// disables both quality gates (they fail open), the #1 cause of a poisoned
// night. Isolated in its own function (NOT part of getRunHealth) precisely so
// a page render never fires it by accident: an Anthropic call on every
// dashboard load would add latency + cost to a read. The script calls it; the
// page relies on the downstream anomaly detectors (§8) instead.
export async function checkAnthropicReachable(): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const c = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
    await c.messages.create({ model: "claude-sonnet-5", max_tokens: 8, messages: [{ role: "user", content: "ok" }] });
    return { ok: true };
  } catch (e: unknown) {
    return { ok: false, message: (e as { message?: string })?.message ?? String(e) };
  }
}

// ── Email-ready trend (§2) ───────────────────────────────────────────────────
export type TrendRow = { night: string; sourced: number; queued: number; needs: number; call: number; rej: number };

export async function getEmailReadyTrend(nights: number): Promise<TrendRow[]> {
  return asRows<TrendRow>(
    await db.execute(sql`
      select to_char(${AST_DAY}, 'YYYY-MM-DD (Dy)') as night,
        count(*)::int as sourced,
        -- email-ready = ever reached a verified email. A lead that got EMAILED
        -- moves queued -> contacted, so counting only 'queued' made the number
        -- SHRINK as leads succeeded once the send cron went live. Both count.
        count(*) filter (where enrichment_status in ('queued','contacted'))::int as queued,
        count(*) filter (where enrichment_status='needs_manual_email')::int as needs,
        count(*) filter (where enrichment_status='call_list')::int as call,
        count(*) filter (where enrichment_status='rejected')::int as rej
      from restaurants
      where created_at > now() - (${nights} * interval '1 day')
      group by 1 order by 1 desc`)
  );
}

// avg email-ready over nights that actually sourced something (a night the
// cron didn't fire shouldn't drag the average toward zero).
export function avgEmailReady(trend: TrendRow[]): { avg: number; runNights: number } {
  const runNights = trend.filter((r) => r.sourced > 0);
  const avg = runNights.length ? runNights.reduce((a, r) => a + r.queued, 0) / runNights.length : 0;
  return { avg, runNights: runNights.length };
}

// ── Last sourcing night + its funnel (§3) ────────────────────────────────────
// The most recent AST day that actually sourced anything.
export async function getLastSourcingNight(): Promise<string | null> {
  const [row] = asRows<{ d: string }>(
    await db.execute(sql`
      select to_char(${AST_DAY}, 'YYYY-MM-DD') as d
      from restaurants group by 1 having count(*) > 0 order by 1 desc limit 1`)
  );
  return row?.d ?? null;
}

// A predicate confining a query to one AST night. Kept here so every §3–§8
// query buckets identically.
function inNight(night: string) {
  return sql`(created_at at time zone 'UTC') at time zone 'America/Puerto_Rico' >= ${night}::date
    and (created_at at time zone 'UTC') at time zone 'America/Puerto_Rico' < (${night}::date + interval '1 day')`;
}

export type NightFunnel = {
  sourced: number;
  free_filtered: number;
  gate_rejected: number;
  queued: number;
  contacted: number;
  needs_email: number;
  call_list: number;
  with_site: number;
};

export async function getNightFunnel(night: string): Promise<NightFunnel | null> {
  const [f] = asRows<NightFunnel>(
    await db.execute(sql`
      select
        count(*)::int as sourced,
        count(*) filter (where rejection_reason like 'Hard filter:%')::int as free_filtered,
        count(*) filter (where enrichment_status='rejected' and rejection_reason not like 'Hard filter:%')::int as gate_rejected,
        count(*) filter (where enrichment_status in ('queued','contacted'))::int as queued,
        count(*) filter (where enrichment_status='contacted')::int as contacted,
        count(*) filter (where enrichment_status='needs_manual_email')::int as needs_email,
        count(*) filter (where enrichment_status='call_list')::int as call_list,
        count(*) filter (where website is not null)::int as with_site
      from restaurants where ${inNight(night)}`)
  );
  return f ?? null;
}

// ── Why leads died (§4) ──────────────────────────────────────────────────────
export type RejectionBucket = { bucket: string; n: number };

export async function getRejectionBuckets(night: string): Promise<RejectionBucket[]> {
  return asRows<RejectionBucket>(
    await db.execute(sql`
      select case
        when rejection_reason like 'Hard filter: only%' or rejection_reason like 'Hard filter: no review%' then 'too few reviews'
        when rejection_reason like '%established destination%' then 'over review ceiling'
        when rejection_reason like 'Hard filter: price%' then 'too expensive'
        when rejection_reason like 'Hard filter: business status%' then 'closed'
        when rejection_reason like '%chain%' or rejection_reason like '%hospitality group%' then 'chain / group'
        when rejection_reason like '%professional photography%' then 'already has pro photos'
        when rejection_reason like 'Hard filter:%' then 'other hard filter'
        else 'other' end as bucket,
        count(*)::int as n
      from restaurants where ${inNight(night)} and enrichment_status='rejected'
      group by 1 order by 2 desc`)
  );
}

// ── Email-discovery yield (§5) ───────────────────────────────────────────────
export type YieldRow = { night: string; sites: number; emails: number };

export async function getEmailYield(nights: number): Promise<YieldRow[]> {
  return asRows<YieldRow>(
    await db.execute(sql`
      select to_char(${AST_DAY}, 'MM-DD') as night,
        -- website-havers that finished as an email decision: got an email
        -- (queued/contacted) or had a site but none found (needs_manual_email).
        count(*) filter (where website is not null and enrichment_status in ('queued','contacted','needs_manual_email'))::int as sites,
        count(*) filter (where enrichment_status in ('queued','contacted'))::int as emails
      from restaurants
      where created_at > now() - (${Math.min(nights, 7)} * interval '1 day')
      group by 1 order by 1 desc`)
  );
}

// ── Anomaly detection (§8) ───────────────────────────────────────────────────
// Outage signatures — the gates fail open, so a poisoned night LOOKS like a
// great one (everything passes). Each returned string is one flag.
export async function getAnomalies(night: string, funnel: NightFunnel | null): Promise<string[]> {
  const flags: string[] = [];

  // Gate-2 failed open: a RICH band where Vision made ZERO calls means the API
  // was unreachable. Two exclusions, both learned the hard way:
  //   - `unclear` is skipped by design (decidePhotoFit can only reject `rich`),
  //     so every unclear lead has a null pro-score on purpose.
  //   - A null pro-score is NOT the signal. Gate 2 legitimately returns null
  //     when it scored images but found no real photo (logos/menus only) —
  //     which is common. Keying on that made this fire on three consecutive
  //     normal nights (2026-08-25/26/27) before website_images_scored existed.
  //     `= 0` is the true outage signature; NULL means "enriched before the
  //     column existed", which we can't judge, so we don't flag it.
  const [g2] = asRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from restaurants
      where ${inNight(night)} and website_photo_band = 'rich' and website_images_scored = 0`)
  );
  if (g2?.n > 0)
    flags.push(
      `Gate-2 (Vision) made zero calls on ${g2.n} rich-band lead(s) last night — the API was likely unreachable, so those leads were never actually judged (this can't reject them into a decision, but they went unscreened).`
    );

  // Chain check failed open: a full run with zero chain/group rejections is
  // suspicious (a normal night rejects several).
  const [cc] = asRows<{ n: number }>(
    await db.execute(
      sql`select count(*) filter (where rejection_reason ilike '%hospitality group%')::int as n from restaurants where ${inNight(night)}`
    )
  );
  if (funnel && funnel.sourced >= 40 && cc?.n === 0)
    flags.push(`0 chain/group rejections on a ${funnel.sourced}-lead run — the chain check may have been down (a normal run rejects several).`);

  // Suspiciously high email-ready rate (gates letting everything through).
  if (funnel && funnel.sourced >= 40 && funnel.queued / funnel.sourced > 0.4)
    flags.push(
      `Email-ready rate ${((funnel.queued / funnel.sourced) * 100).toFixed(0)}% is abnormally high — gates may have failed open; verify before trusting the queue.`
    );

  return flags;
}

// ── Per-night session (for the Insights snapshot) ────────────────────────────
// The complete frozen picture of one night, assembled from the queries above
// plus a per-night yield count. Written to pipeline_night_snapshots the morning
// after (worker/jobs/snapshotNight.ts) and read back by the Insights tab.
export type NightSession = {
  night: string;
  sourced: number;
  freeFiltered: number;
  reachedEnrichment: number;
  gateRejected: number;
  emailReady: number;
  contacted: number;
  needsManualEmail: number;
  callList: number;
  siteHavers: number;
  siteGotEmail: number;
  nightlyCap: number | null;
  rejectionBuckets: RejectionBucket[];
  anomalies: string[];
};

export async function computeNightSession(night: string): Promise<NightSession> {
  const funnel = await getNightFunnel(night);
  const [buckets, anomalies, yieldRow] = await Promise.all([
    getRejectionBuckets(night),
    getAnomalies(night, funnel),
    (async () => {
      const [y] = asRows<{ havers: number; got: number }>(
        await db.execute(sql`
          select
            count(*) filter (where website is not null and enrichment_status in ('queued','contacted','needs_manual_email'))::int as havers,
            count(*) filter (where website is not null and enrichment_status in ('queued','contacted'))::int as got
          from restaurants where ${inNight(night)}`)
      );
      return y ?? { havers: 0, got: 0 };
    })(),
  ]);
  const cap = (await getRunHealth()).nightlyCap;

  return {
    night,
    sourced: funnel?.sourced ?? 0,
    freeFiltered: funnel?.free_filtered ?? 0,
    reachedEnrichment: funnel ? funnel.sourced - funnel.free_filtered : 0,
    gateRejected: funnel?.gate_rejected ?? 0,
    emailReady: funnel?.queued ?? 0,
    contacted: funnel?.contacted ?? 0,
    needsManualEmail: funnel?.needs_email ?? 0,
    callList: funnel?.call_list ?? 0,
    siteHavers: yieldRow.havers,
    siteGotEmail: yieldRow.got,
    nightlyCap: cap,
    rejectionBuckets: buckets,
    anomalies,
  };
}

// ── Findings + patterns (derived on read from frozen snapshots) ──────────────
// Deterministic, rule-based — no LLM, no API cost, no measurement-bug risk.
// `finding` = something true about THIS night; `pattern` = something true
// across the recent series. Each carries a tone so the UI can color it.
export type Insight = { tone: "good" | "warn" | "bad" | "neutral"; text: string };

export function yieldPct(s: { siteHavers: number; siteGotEmail: number }): number | null {
  return s.siteHavers > 0 ? Math.round((s.siteGotEmail / s.siteHavers) * 100) : null;
}

// Baseline yield from the corrected Aug-2026 measurement (pipeline-baseline
// memory): ~29% was the historical hit rate; the fetcher hardening lifted it
// into the mid-30s. Above this reads as "healthy".
const YIELD_BASELINE_PCT = 30;

export function deriveNightFindings(s: NightSession): Insight[] {
  const out: Insight[] = [];

  // The headline metric.
  if (s.emailReady >= EMAIL_READY_TARGET)
    out.push({ tone: "good", text: `Hit the target: ${s.emailReady} email-ready (≥ ${EMAIL_READY_TARGET}).` });
  else
    out.push({ tone: s.emailReady === 0 ? "bad" : "warn", text: `${s.emailReady} email-ready, below the ${EMAIL_READY_TARGET} target.` });

  // Where the funnel leaked most.
  if (s.sourced > 0) {
    const filteredPct = Math.round((s.freeFiltered / s.sourced) * 100);
    if (filteredPct >= 40)
      out.push({ tone: "neutral", text: `${filteredPct}% (${s.freeFiltered}/${s.sourced}) died at the free filters — a thin sourcing night.` });
  }

  // Email yield vs baseline — the stated bottleneck.
  const y = yieldPct(s);
  if (y !== null) {
    if (y >= YIELD_BASELINE_PCT + 5) out.push({ tone: "good", text: `Email yield ${y}% (${s.siteGotEmail}/${s.siteHavers}) — above the ~${YIELD_BASELINE_PCT}% baseline.` });
    else if (y < YIELD_BASELINE_PCT - 5) out.push({ tone: "warn", text: `Email yield ${y}% (${s.siteGotEmail}/${s.siteHavers}) — below the ~${YIELD_BASELINE_PCT}% baseline; the discovery bottleneck bit last night.` });
  }

  // Top reason leads died.
  if (s.rejectionBuckets.length > 0) {
    const top = s.rejectionBuckets[0];
    out.push({ tone: "neutral", text: `Top killer: ${top.bucket} (${top.n}).` });
  }

  // Anomalies are always a finding (they mean the numbers may not be trustworthy).
  for (const a of s.anomalies) out.push({ tone: "bad", text: a });

  return out;
}

// Cross-night patterns from the recent snapshot series (newest first).
export function derivePatterns(series: NightSession[]): Insight[] {
  const out: Insight[] = [];
  if (series.length < 3) return out;
  const recent = series.slice(0, 7); // up to a week

  // Streak below target.
  let belowStreak = 0;
  for (const s of series) {
    if (s.emailReady < EMAIL_READY_TARGET) belowStreak++;
    else break;
  }
  if (belowStreak >= 3) out.push({ tone: "warn", text: `Email-ready has been below target ${belowStreak} nights running.` });

  // Yield trend over the recent window.
  const ys = recent.map(yieldPct).filter((v): v is number => v !== null);
  if (ys.length >= 3) {
    const avg = Math.round(ys.reduce((a, b) => a + b, 0) / ys.length);
    const first = ys[ys.length - 1];
    const last = ys[0];
    if (last - first >= 8) out.push({ tone: "good", text: `Email yield trending up (${first}% → ${last}%, avg ${avg}% over ${ys.length} nights).` });
    else if (first - last >= 8) out.push({ tone: "warn", text: `Email yield trending down (${first}% → ${last}%, avg ${avg}%).` });
    else out.push({ tone: "neutral", text: `Email yield holding around ${avg}% over the last ${ys.length} nights.` });
  }

  // Recurring top killer.
  const topKillers = recent.map((s) => s.rejectionBuckets[0]?.bucket).filter(Boolean) as string[];
  if (topKillers.length >= 3) {
    const counts = new Map<string, number>();
    for (const k of topKillers) counts.set(k, (counts.get(k) ?? 0) + 1);
    const [name, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (n >= 3) out.push({ tone: "neutral", text: `"${name}" has been the top rejection reason ${n} of the last ${recent.length} nights.` });
  }

  // Recurring anomalies (an outage that keeps happening isn't a blip).
  const anomalyNights = recent.filter((s) => s.anomalies.length > 0).length;
  if (anomalyNights >= 2) out.push({ tone: "bad", text: `Anomaly flags on ${anomalyNights} of the last ${recent.length} nights — a recurring outage, not a one-off. Worth investigating the gate/API health.` });

  return out;
}
