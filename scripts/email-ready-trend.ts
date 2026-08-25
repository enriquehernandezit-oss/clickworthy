// Email-ready trend — the decision tool for "is grid + the raised review ceiling
// (800->2000) enough, or do we need the new-openings feeds?" Groups every
// sourced lead by the NIGHT it was sourced and headlines the `queued` count —
// leads with a verified, contactable email, i.e. THE priority metric — so you
// can watch the per-night number over several runs instead of trusting one
// noisy 50-lead sample.
//
//   bun run scripts/email-ready-trend.ts        # last 14 nights
//   bun run scripts/email-ready-trend.ts 30     # custom lookback in nights
//
// Read-only: never writes. Requires a reachable DATABASE_URL (uses .env.local).
//
// Nights are bucketed in AST (America/Puerto_Rico) so a row lands on the same
// calendar day you'd call "last night" — the sourcing cron fires 02:17 UTC,
// which is 22:17 the prior evening AST, so AST bucketing keeps one run on one
// line. created_at is a naive UTC timestamp (defaultNow() on the UTC server),
// hence the double `AT TIME ZONE`: read it as UTC, then render in AST.

import { sql } from "drizzle-orm";
import { db } from "@/db";

const TARGET = 20; // queued/night goal (see outreach-send-controls / sourcing-strategy-pivot)
const arg = Number(process.argv[2]);
const nights = Number.isFinite(arg) && arg > 0 ? Math.floor(arg) : 14;

type Row = {
  night: string;
  sourced: number;
  emailReady: number; // queued — verified contactable email
  needsEmail: number; // has a website, no email auto-found (Jose can find it)
  callList: number; // no website — phone segment
  rejected: number;
};

const rows = (await db.execute(sql`
  select
    to_char(date_trunc('day', (created_at at time zone 'UTC') at time zone 'America/Puerto_Rico'), 'YYYY-MM-DD (Dy)') as night,
    count(*)::int                                                         as sourced,
    -- email-ready = ever got a verified email. Once EMAILED a lead moves
    -- queued -> contacted, so counting only 'queued' makes the number shrink
    -- as leads succeed (a bug once the send cron went live). Both count.
    count(*) filter (where enrichment_status in ('queued','contacted'))::int as "emailReady",
    count(*) filter (where enrichment_status = 'needs_manual_email')::int as "needsEmail",
    count(*) filter (where enrichment_status = 'call_list')::int          as "callList",
    count(*) filter (where enrichment_status = 'rejected')::int           as rejected
  from restaurants
  where created_at > now() - (${nights} * interval '1 day')
  group by 1
  order by 1 desc
`)) as unknown as Row[];

if (rows.length === 0) {
  console.log(`No leads sourced in the last ${nights} nights.`);
  process.exit(0);
}

console.log(`\n=== email-ready (queued) per night — last ${nights} nights, AST ===\n`);
console.log("  night              sourced   EMAIL-READY   needs-email   call-list   rejected   bar");
console.log("  " + "-".repeat(94));

for (const r of rows) {
  const bar = "█".repeat(Math.min(r.emailReady, 40));
  console.log(
    "  " +
      r.night.padEnd(18) +
      String(r.sourced).padStart(6) +
      String(r.emailReady).padStart(14) +
      String(r.needsEmail).padStart(14) +
      String(r.callList).padStart(12) +
      String(r.rejected).padStart(11) +
      "   " +
      bar
  );
}

// Average only across nights that actually had a run — a zero-sourced day is a
// night the cron didn't fire (or the window's ragged edge), not a night that
// produced zero email-ready leads, and averaging those in would understate the
// real rate.
const runNights = rows.filter((r) => r.sourced > 0);
const avgReady = runNights.reduce((a, r) => a + r.emailReady, 0) / runNights.length;
const avgSourced = runNights.reduce((a, r) => a + r.sourced, 0) / runNights.length;

console.log("");
console.log(`  nights with a run:        ${runNights.length}`);
console.log(`  avg sourced / run night:  ${avgSourced.toFixed(1)}`);
console.log(`  avg EMAIL-READY / run:    ${avgReady.toFixed(1)}   (target ${TARGET})`);

console.log("");
if (avgReady >= TARGET) {
  console.log(`✓ Averaging ${avgReady.toFixed(1)} email-ready/night — at/above the ${TARGET} target. Grid + ceiling is enough; the new-openings feeds aren't needed to hit volume.`);
} else {
  const short = TARGET - avgReady;
  console.log(`⚠ Averaging ${avgReady.toFixed(1)} email-ready/night — short of ${TARGET} by ${short.toFixed(1)}. If this holds over a few more run nights, the gap is real and worth closing (more grid cities, better email discovery, or the new-openings feeds).`);
}
console.log(`\n  (needs-email = has a site but no auto-found address — Jose can still work these into email leads.)`);
process.exit(0);
