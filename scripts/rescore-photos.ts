// Re-score owner photos for leads that missed scoring (e.g. while the Anthropic
// balance was depleted, or sourced before owner-photo scoring existed). Sourcing
// never re-enriches existing rows and the transient photo refs aren't stored, so
// recovery means re-fetching each place by ID and re-running the SAME scoring the
// enricher does — filling avgPhotoScore, photosScored, the signature dish, and
// the recomputed priority score.
//
//   bun run scripts/rescore-photos.ts                     # DRY RUN — counts + lists, no API calls
//   bun run scripts/rescore-photos.ts --commit            # re-fetch + re-score + write
//   bun run scripts/rescore-photos.ts --commit --limit 5  # first 5 only (sane first-run check)
//
// Targets rows with enrichmentStatus queued/needs_manual_email, NO avgPhotoScore,
// and a googlePlaceId. Never clears an existing dish; leaves status untouched
// (a dish isn't required to queue). Existing DRAFTS keep their generic wording —
// use "Redraft" in /admin to fold a newly-found dish into a lead's draft.

import { and, eq, inArray, isNull, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "@/worker/config";
import { getPlaceById, fetchPhotoBytes, ownerPhotos } from "@/worker/lib/places";
import { scorePhoto } from "@/worker/lib/anthropic";
import { priorityScore } from "@/worker/lib/priority";

const commit = process.argv.includes("--commit");
const limitArg = process.argv.indexOf("--limit");
const limit = limitArg >= 0 ? Math.max(1, Number(process.argv[limitArg + 1]) || 0) : 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

if (commit && !process.env.ANTHROPIC_API_KEY?.trim()) {
  console.error("ANTHROPIC_API_KEY is not set — scoring can't run. Aborting.");
  process.exit(1);
}

const candidates = await db
  .select()
  .from(restaurants)
  .where(
    and(
      inArray(restaurants.enrichmentStatus, ["queued", "needs_manual_email"]),
      isNull(restaurants.avgPhotoScore),
      isNotNull(restaurants.googlePlaceId),
    ),
  )
  .orderBy(restaurants.id);

console.log(`\n=== rescore-photos ===`);
console.log(`candidates (no photo score + a place id): ${candidates.length}\n`);

if (!commit) {
  const preview = candidates.slice(0, limit || candidates.length);
  for (const r of preview) console.log(`  ${String(r.id).padStart(4)}  ${r.enrichmentStatus?.padEnd(18)} ${r.name}`);
  console.log(`\nDry run — no API calls, no writes.${limit ? ` (showing first ${preview.length})` : ""}\nPass --commit to re-fetch + re-score + write.`);
  process.exit(0);
}

const batch = limit ? candidates.slice(0, limit) : candidates;
console.log(`Processing ${batch.length} row(s)...\n`);
let scored = 0, noOwnerPhotos = 0, gotDish = 0, errored = 0;

for (const r of batch) {
  try {
    const place = await getPlaceById(r.googlePlaceId!);
    const owner = place ? ownerPhotos(place) : [];
    if (owner.length === 0) {
      noOwnerPhotos++;
      console.log(`  · ${r.name} — no owner photos to score`);
      continue;
    }

    // Same adaptive loop as enrichRestaurant.scorePhotos: score owner photos one
    // at a time, stop at the first real dish. Bytes are never persisted.
    const names = owner.map((p) => p.name).slice(0, config.photoScoreLimit);
    const scores: number[] = [];
    let dish: string | null = null;
    for (const name of names) {
      try {
        const { bytes, contentType } = await fetchPhotoBytes(name);
        const result = await scorePhoto(bytes, contentType);
        scores.push(result.score);
        if (result.dish) { dish = result.dish; break; }
      } catch (err) {
        console.warn(`    photo score failed for ${r.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (scores.length === 0) { noOwnerPhotos++; console.log(`  · ${r.name} — all photo scores failed`); continue; }

    const avg = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100;
    const score = priorityScore({
      rating: r.rating,
      reviewCount: r.reviewCount,
      priceLevelInt: r.priceLevel,
      deliveryEnabled: Boolean(r.deliveryEnabled),
      photoCount: owner.length,
      avgPhotoScore: avg,
    });

    const set: Record<string, unknown> = { avgPhotoScore: avg, photosScored: scores.length, photoCount: owner.length, priorityScore: score };
    if (dish) set.signatureDish = dish; // never clear an existing dish
    await db.update(restaurants).set(set).where(eq(restaurants.id, r.id));

    scored++;
    if (dish) gotDish++;
    console.log(`  ✓ ${r.name} — avg ${avg}/6 over ${scores.length} photo(s)${dish ? `, dish "${dish}"` : ""}`);
  } catch (err) {
    errored++;
    console.warn(`  ! ${r.name} — error: ${err instanceof Error ? err.message : String(err)}`);
  }
  await sleep(150);
}

console.log(`\n=== done ===\n  scored:              ${scored} (${gotDish} got a signature dish)\n  no owner photos:     ${noOwnerPhotos}\n  errored:             ${errored}`);
process.exit(0);
