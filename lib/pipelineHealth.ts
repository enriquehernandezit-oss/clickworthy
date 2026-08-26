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

export async function getRunHealth(nowMs: number): Promise<RunHealth> {
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

  // Gate-2 failed open: a RICH band with no pro-score means the Vision call
  // didn't happen. `unclear` is deliberately EXCLUDED — Gate 2 skips it by
  // design (decidePhotoFit can only reject `rich`), so every unclear lead has
  // a null pro-score on purpose; counting them would cry outage every night.
  const [g2] = asRows<{ n: number }>(
    await db.execute(sql`
      select count(*)::int as n from restaurants
      where ${inNight(night)} and website_photo_band = 'rich' and website_pro_score is null`)
  );
  if (g2?.n > 0)
    flags.push(
      `Gate-2 (Vision) skipped on ${g2.n} rich-band lead(s) last night — likely an API outage; those leads were NOT photo-screened (this can't reject them into a decision, but it means they were never actually judged).`
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
