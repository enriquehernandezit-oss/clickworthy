// Pipeline health snapshot — run after a nightly sourcing/enrichment cycle to
// confirm the pipeline is behaving. For restaurants sourced in the window it
// reports the status split, how many got a verified email (proves NeverBounce
// is working), and how many got an owner-photo score / signature dish (proves
// owner-photo scoring is working). Also prints the worker's last boot time so
// you can confirm it's on the current code.
//
//   bun run scripts/pipeline-health.ts        # last 30h (covers the last nightly run)
//   bun run scripts/pipeline-health.ts 48     # custom lookback in hours
//
// Read-only: never writes. Requires a reachable DATABASE_URL (uses .env.local).

import { gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { getSetting } from "@/lib/settings";

const arg = Number(process.argv[2]);
const hours = Number.isFinite(arg) && arg > 0 ? arg : 30;
const since = new Date(Date.now() - hours * 3_600_000);

const boot = (await getSetting("worker_boot_info")) as { bootedAt?: string } | null;
if (boot?.bootedAt) {
  const ageH = ((Date.now() - Date.parse(boot.bootedAt)) / 3_600_000).toFixed(1);
  console.log(`worker booted: ${boot.bootedAt} (${ageH}h ago)`);
} else {
  console.log("worker boot info: (none)");
}

console.log(`\n=== leads sourced in the last ${hours}h (since ${since.toISOString()}) ===`);
const [agg] = await db
  .select({
    n: sql<number>`count(*)::int`,
    withEmail: sql<number>`count(${restaurants.email})::int`,
    withScore: sql<number>`count(${restaurants.avgPhotoScore})::int`,
    withDish: sql<number>`count(${restaurants.signatureDish})::int`,
  })
  .from(restaurants)
  .where(gte(restaurants.createdAt, since));

console.log(`  sourced:             ${agg.n}`);
console.log(`  with verified email: ${String(agg.withEmail).padStart(4)}   (NeverBounce working if > 0)`);
console.log(`  with photo score:    ${String(agg.withScore).padStart(4)}   (owner-photo scoring)`);
console.log(`  with signature dish: ${String(agg.withDish).padStart(4)}`);

const byStatus = await db
  .select({ s: restaurants.enrichmentStatus, n: sql<number>`count(*)::int` })
  .from(restaurants)
  .where(gte(restaurants.createdAt, since))
  .groupBy(restaurants.enrichmentStatus);
console.log(`\n  status split (new leads):`);
for (const r of byStatus.sort((a, b) => Number(b.n) - Number(a.n))) console.log(`    ${String(r.n).padStart(4)}  ${r.s}`);

const [q] = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(restaurants)
  .where(sql`${restaurants.enrichmentStatus} = 'queued'`);
console.log(`\n  total queued (all time): ${q.n}`);

console.log("");
if (agg.n === 0) {
  console.log("⚠ No new leads in the window — the cron may not have run, the target cities are tapped out, or Places is failing. Check the worker logs / alert emails.");
} else if (agg.withEmail === 0) {
  console.log(`⚠ ${agg.n} sourced but 0 verified emails — NeverBounce or email discovery may be failing. Investigate before trusting the run.`);
} else {
  console.log(`✓ Sourced ${agg.n}, ${agg.withEmail} with verified emails, ${agg.withScore} photo-scored — pipeline looks healthy.`);
}
process.exit(0);
