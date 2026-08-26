// Freezes each completed night's pipeline metrics into pipeline_night_snapshots
// — the immutable record the Insights tab reads. Runs the morning AFTER a
// sourcing run (a couple hours later, like the sourcing report), so enrichment
// has fully settled and the numbers won't shift under it.
//
// Idempotent: `night` is unique and we insert-if-absent, so re-running (or the
// cron firing twice) never double-writes or overwrites a frozen night. Only
// COMPLETED nights are snapshotted — never today's still-running AST day.

import { sql } from "drizzle-orm";
import { db } from "@/db";
import { pipelineNightSnapshots } from "@/db/schema";
import { computeNightSession, type NightSession } from "@/lib/pipelineHealth";

export { SNAPSHOT_QUEUE } from "@/lib/queues";

// Today's AST calendar day ('YYYY-MM-DD') — the boundary we never snapshot past
// (its run may still be enriching).
async function todayAst(): Promise<string> {
  const [row] = (await db.execute(
    sql`select to_char((now() at time zone 'UTC') at time zone 'America/Puerto_Rico', 'YYYY-MM-DD') as d`
  )) as unknown as { d: string }[];
  return row!.d;
}

// Completed AST nights that have restaurant rows but no snapshot yet. Bounded to
// a recent window so a long-idle worker doesn't try to backfill all of history.
async function nightsNeedingSnapshot(lookbackDays: number): Promise<string[]> {
  const today = await todayAst();
  const rows = (await db.execute(sql`
    with nights as (
      select distinct to_char(date_trunc('day', (created_at at time zone 'UTC') at time zone 'America/Puerto_Rico'), 'YYYY-MM-DD') as night
      from restaurants
      where created_at > now() - (${lookbackDays} * interval '1 day')
    )
    select n.night from nights n
    left join pipeline_night_snapshots s on s.night = n.night
    where s.night is null and n.night < ${today}
    order by n.night
  `)) as unknown as { night: string }[];
  return rows.map((r) => r.night);
}

async function writeSnapshot(s: NightSession): Promise<void> {
  await db
    .insert(pipelineNightSnapshots)
    .values({
      night: s.night,
      sourced: s.sourced,
      freeFiltered: s.freeFiltered,
      reachedEnrichment: s.reachedEnrichment,
      gateRejected: s.gateRejected,
      emailReady: s.emailReady,
      contacted: s.contacted,
      needsManualEmail: s.needsManualEmail,
      callList: s.callList,
      siteHavers: s.siteHavers,
      siteGotEmail: s.siteGotEmail,
      nightlyCap: s.nightlyCap,
      rejectionBuckets: s.rejectionBuckets,
      anomalies: s.anomalies,
    })
    .onConflictDoNothing({ target: pipelineNightSnapshots.night });
}

// lookbackDays default 10 covers a stalled worker catching up several nights;
// exported so the backfill script can widen it for a one-time historical fill.
export async function runSnapshotNight(lookbackDays = 10): Promise<{ written: string[] }> {
  const nights = await nightsNeedingSnapshot(lookbackDays);
  const written: string[] = [];
  for (const night of nights) {
    const session = await computeNightSession(night);
    await writeSnapshot(session);
    written.push(night);
    console.log(`[snapshot] froze ${night}: ${session.emailReady} email-ready of ${session.sourced} sourced${session.anomalies.length ? `, ${session.anomalies.length} anomaly flag(s)` : ""}`);
  }
  if (written.length === 0) console.log("[snapshot] nothing to snapshot — all completed nights already frozen.");
  return { written };
}
