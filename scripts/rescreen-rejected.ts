// Re-admit restaurants rejected ONLY for being under the old review-count
// floor, now that the floor has moved.
//
//   bun run scripts/rescreen-rejected.ts             # DRY RUN — verdicts only, no writes
//   bun run scripts/rescreen-rejected.ts --commit    # apply: clear rejection, enqueue enrichment
//   bun run scripts/rescreen-rejected.ts --commit --limit 20
//
// WHY THIS EXISTS (2026-09-08). worker/lib/filters.ts's minReviews dropped
// 20 -> 10 the same day this shipped (the 62-cell grid saturated — see
// grid.ts — so unlocking already-discovered supply was the free lever). That
// change is forward-looking only: `passesHardFilters` runs at SOURCING time,
// so it does nothing for a restaurant already sitting at enrichmentStatus
// 'rejected' with the old rejectionReason baked in. This is the one-off pass
// that applies the new floor retroactively.
//
// SCOPE, deliberately narrow: only rows whose rejectionReason matches the
// review-floor's exact wording (`Hard filter: only N reviews`), never the
// review CEILING, missing-review-count, chain, closed, or photo-fit
// rejections sitting in the same `rejected` pool — those still apply exactly
// as before. The SQL LIKE only picks candidates; the actual gate is a live
// re-run of passesHardFilters() against each row's current stored columns
// (reviews may itself be stale — Google's count moves — so this re-checks
// for real rather than trusting the old count implied by the reason text).
//
// COST: zero Places calls (every field the filters need is already a stored
// column — no live Google fetch). Restaurants that now pass are enqueued on
// ENRICH_QUEUE exactly as a fresh sourcing run would, so the ordinary
// enrichment cost (homepage fetch, photo-fit Vision, NeverBounce, the
// email-gated chain check) applies from there — same per-lead cost as any
// other night, just for supply that already exists.
//
// NOTE: photoNames is sent empty ([]). A restaurant's ORIGINAL Places photo
// refs are transient — captured only at the moment of the live Nearby Search
// call (see sourceLeads.ts) and never stored — so they cannot be
// reconstructed without a fresh Places call, which would defeat the "zero
// Places cost" point of this script. This is a real but minor and
// well-precedented degradation: runEnrichment() already prefers a dish seen
// on the restaurant's own WEBSITE (fit.dish, itself a free re-fetch) and only
// falls back to scoring Google photos when the website has none AND the lead
// has a verified email (enrichRestaurant.ts:211-219; scorePhotos([]) returns
// {avg:null, count:0, signatureDish:null} cleanly). A dish-less result just
// drafts with the generic {{dish}} fallback, same as scripts/reverify-emails.ts
// already accepts for the same reason. priorityScore is unaffected either way
// — it reads the STORED restaurants.photoCount column, not photoNames.

import { PgBoss } from "pg-boss";
import { and, eq, ilike } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { requireKey } from "@/worker/config";
import { passesHardFilters, DEFAULT_FILTER_THRESHOLDS } from "@/worker/lib/filters";
import { priceLevelToInt, type Place } from "@/worker/lib/places";
import { ENRICH_QUEUE, type EnrichJobData } from "@/worker/jobs/enrichRestaurant";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 0) : 0;

// Inverse of priceLevelToInt (places.ts) — passesHardFilters wants the raw
// Google enum string, but the DB stores the already-converted integer.
// Reconstructing a plausible enum string (any string that maps back to the
// same integer works; the exact enum name is never read again) lets this
// script call the REAL filter function instead of re-deriving its logic.
function intToPriceLevelString(n: number | null): string | undefined {
  switch (n) {
    case 1: return "PRICE_LEVEL_INEXPENSIVE";
    case 2: return "PRICE_LEVEL_MODERATE";
    case 3: return "PRICE_LEVEL_EXPENSIVE";
    case 4: return "PRICE_LEVEL_VERY_EXPENSIVE";
    default: return undefined;
  }
}

const candidates = await db
  .select()
  .from(restaurants)
  .where(and(eq(restaurants.enrichmentStatus, "rejected"), ilike(restaurants.rejectionReason, "Hard filter: only%reviews%")))
  .orderBy(restaurants.id);

console.log(
  `\n=== rescreen-rejected ${commit ? "(COMMIT)" : "(DRY RUN)"} ===\n` +
    `candidates (rejected on the review floor): ${candidates.length}\n` +
    `current floor: minReviews=${DEFAULT_FILTER_THRESHOLDS.minReviews}\n`
);

const batch = limit ? candidates.slice(0, limit) : candidates;

// Pass 1: verdicts only, no side effects — decides WHETHER pg-boss is even
// needed before touching it (kept as a single non-reassigned `const` below,
// same shape as worker/index.ts's own `boss`, rather than a lazily-created
// variable threaded through the loop).
const toReadmit: typeof batch = [];
let stillRejected = 0;

for (const r of batch) {
  // Reconstruct just enough of a Place to run the REAL filter function — not
  // a fresh Places response, the stored columns from this exact row.
  const place: Place = {
    id: r.googlePlaceId ?? "",
    displayName: { text: r.name },
    rating: r.rating ?? undefined,
    userRatingCount: r.reviewCount ?? undefined,
    priceLevel: intToPriceLevelString(r.priceLevel),
    businessStatus: "OPERATIONAL", // was operational when sourced; not re-checked live here
    websiteUri: r.website ?? undefined,
  };

  const verdict = passesHardFilters(place);
  if (!verdict.pass) {
    stillRejected++;
    console.log(`  ✗ ${r.name} (${r.reviewCount ?? "?"} reviews) — still rejected: ${verdict.reason}`);
    continue;
  }

  toReadmit.push(r);
  console.log(`  ✓ ${r.name} (${r.reviewCount} reviews) — re-admitted, enqueuing enrichment`);
}

// Pass 2: writes. Only opens a pg-boss connection when there's actually
// something to enqueue — a dry run, or a commit that finds nothing new,
// never touches it at all.
if (commit && toReadmit.length > 0) {
  const boss = new PgBoss(requireKey("databaseUrl", "DATABASE_URL"));
  await boss.start();
  for (const r of toReadmit) {
    await db
      .update(restaurants)
      .set({ rejectionReason: null, enrichmentStatus: "sourced" })
      .where(eq(restaurants.id, r.id));
    const enrichData: EnrichJobData = { restaurantId: r.id, photoNames: [] };
    await boss.send(ENRICH_QUEUE, enrichData);
  }
  await boss.stop();
}
const readmitted = toReadmit.length;

console.log(
  `\n=== done ===\n` +
    `  re-admitted (enrichment ${commit ? "enqueued" : "would be enqueued"}): ${readmitted}\n` +
    `  still fail the current filters:                    ${stillRejected}\n` +
    (commit
      ? readmitted > 0
        ? `\n${readmitted} restaurant(s) are back at 'sourced' with enrichment queued — the running worker will pick them up.`
        : `\nNothing to enqueue.`
      : `\nDry run — no writes. Pass --commit to apply.`)
);
process.exit(0);
