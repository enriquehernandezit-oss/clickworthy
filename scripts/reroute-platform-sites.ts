// One-time data fix: move existing `needs_manual_email` rows whose "website"
// is actually a social page or an ordering platform into `call_list` instead.
//
// Before 2026-08-25, routing in worker/jobs/enrichRestaurant.ts only checked
// `website != null` — it never consulted what the URL actually was. A
// restaurant whose only web presence is an Instagram/Facebook page or an
// ordering-platform URL has no mailbox of its own to find, so it was sending
// Jose to "find the address" somewhere no address can exist. Measured
// 2026-08-25: 15 of 119 needs_manual_email leads were exactly this. The
// routing rule itself is now fixed (classifyWebsite is consulted going
// forward) — this script only backfills the rows that already exist.
//
// Idempotent and safe to re-run: it only ever touches rows currently sitting
// in needs_manual_email, so a lead already moved to call_list is left alone,
// and it will also catch any stray that lands back in needs_manual_email later
// (e.g. restored by scripts/rescreen-chains.ts, whose restore path predates
// this fix).
//
//   bun run scripts/reroute-platform-sites.ts            # DRY RUN — lists verdicts, no writes
//   bun run scripts/reroute-platform-sites.ts --commit   # apply

import { and, eq, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { classifyWebsite } from "@/worker/lib/websitePlatform";

const commit = process.argv.includes("--commit");

const rows = await db
  .select({ id: restaurants.id, name: restaurants.name, website: restaurants.website })
  .from(restaurants)
  .where(and(eq(restaurants.enrichmentStatus, "needs_manual_email"), isNotNull(restaurants.website)));

const toReroute = rows
  .map((r) => ({ ...r, tier: classifyWebsite(r.website).tier }))
  .filter((r) => r.tier === "social_only" || r.tier === "ordering_platform");

console.log(
  `${rows.length} needs_manual_email lead(s) with a website; ${toReroute.length} are a dead-end (social/ordering) page` +
    (commit ? " — COMMIT" : " — dry run") +
    ".\n"
);
for (const r of toReroute) console.log(`  [${r.tier}] ${r.name} — ${r.website}`);

if (!commit) {
  console.log("\nDry run — nothing written. Re-run with --commit to apply.");
  process.exit(0);
}

let applied = 0;
for (const r of toReroute) {
  await db.update(restaurants).set({ enrichmentStatus: "call_list" }).where(eq(restaurants.id, r.id));
  applied++;
}
console.log(`\nRerouted ${applied} to call_list.`);
process.exit(0);
