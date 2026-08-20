// Manual one-off runner for testing the pipeline without waiting for the cron.
// Sweeps a city's neighborhood grid (worker/lib/grid.ts), then sources + enriches
// a small batch of NEW restaurants synchronously (enrichment runs inline rather
// than through the queue so you see the full result in one command), then exits.
//
//   bun run worker/run-once.ts "Miami, FL" 10
//
// The city must be a key in CITY_GRIDS (run with no args to see the list).
// Respects WORKER_DRY_RUN / WORKER_SOURCE_LIMIT env. Requires GOOGLE_MAPS_API_KEY,
// ANTHROPIC_API_KEY, NEVERBOUNCE_API_KEY, and a reachable DATABASE_URL.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "./config";
import {
  searchNearbyRestaurants,
  getPlaceDetailsForSourcing,
  priceLevelToInt,
  ownerPhotos,
  type Place,
} from "./lib/places";
import { passesHardFilters } from "./lib/filters";
import { CITY_GRIDS } from "./lib/grid";
import { runEnrichment } from "./jobs/enrichRestaurant";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const city = process.argv[2] ?? config.targetCities[0];
  const limit = Number(process.argv[3] ?? config.sourceLimit ?? 10);

  const cells = CITY_GRIDS[city];
  if (!cells || cells.length === 0) {
    console.error(`No grid cells for "${city}". Available cities:\n  ${Object.keys(CITY_GRIDS).join("\n  ")}`);
    process.exit(1);
  }

  console.log(`\n=== run-once: "${city}" grid (${cells.length} cells), up to ${limit} new ===\n`);

  // Sweep cells until we've collected `limit` unique places (or run out of cells).
  const discovered = new Map<string, Place>();
  for (const cell of cells) {
    if (discovered.size >= limit) break;
    try {
      const places = await searchNearbyRestaurants(cell.lat, cell.lng, cell.radiusM);
      for (const p of places) if (!discovered.has(p.id)) discovered.set(p.id, p);
      console.log(`  swept ${cell.name}: +${places.length} (unique so far: ${discovered.size})`);
    } catch (err) {
      console.log(`  swept ${cell.name}: FAILED — ${err instanceof Error ? err.message : err}`);
    }
    await sleep(config.placesThrottleMs);
  }

  let processed = 0;
  for (const nearbyPlace of [...discovered.values()].slice(0, limit)) {
    const details = await getPlaceDetailsForSourcing(nearbyPlace.id);
    await sleep(config.placesThrottleMs);
    if (!details) {
      console.log(`  ✗ ${nearbyPlace.displayName?.text ?? nearbyPlace.id} — no details (gone)`);
      continue;
    }
    const name = details.displayName?.text ?? "(unknown)";
    const verdict = passesHardFilters(details);
    if (!verdict.pass) {
      console.log(`  ✗ ${name} — ${verdict.reason}`);
      continue;
    }
    console.log(`  ✓ ${name} (${details.userRatingCount ?? "?"} reviews) — passes, enriching...`);

    const existing = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.googlePlaceId, details.id))
      .limit(1);

    const row = {
      name,
      googlePlaceId: details.id,
      rating: details.rating ?? null,
      reviewCount: details.userRatingCount ?? null,
      priceLevel: priceLevelToInt(details.priceLevel),
      city,
      phone: details.nationalPhoneNumber ?? null,
      website: details.websiteUri ?? null,
      temporarilyClosed: details.businessStatus === "CLOSED_TEMPORARILY",
      deliveryEnabled: Boolean(details.delivery),
      photoCount: ownerPhotos(details).length,
      enrichmentStatus: "sourced" as const,
    };

    let id: number;
    if (existing.length > 0) {
      id = existing[0].id;
      await db.update(restaurants).set(row).where(eq(restaurants.id, id));
    } else {
      const [ins] = await db.insert(restaurants).values(row).returning({ id: restaurants.id });
      id = ins.id;
    }

    await runEnrichment({ restaurantId: id, photoNames: ownerPhotos(details).map((p) => p.name) });
    processed++;
  }

  console.log(`\n=== done: ${processed} restaurants sourced + enriched ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error("run-once failed:", err);
  process.exit(1);
});
