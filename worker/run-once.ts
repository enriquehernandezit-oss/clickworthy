// Manual one-off runner for testing the pipeline without waiting for the cron.
// Sources + enriches a small batch synchronously (enrichment runs inline rather
// than through the queue so you see the full result in one command), then exits.
//
//   bun run worker/run-once.ts "Santo Domingo, Dominican Republic" 10
//
// Respects WORKER_DRY_RUN / WORKER_SOURCE_LIMIT env. Requires GOOGLE_MAPS_API_KEY,
// ANTHROPIC_API_KEY, NEVERBOUNCE_API_KEY, and a reachable DATABASE_URL.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "./config";
import { searchRestaurants, priceLevelToInt, ownerPhotos } from "./lib/places";
import { passesHardFilters } from "./lib/filters";
import { runEnrichment } from "./jobs/enrichRestaurant";

async function main() {
  const city = process.argv[2] ?? config.targetCities[0];
  const limit = Number(process.argv[3] ?? config.sourceLimit ?? 10);

  console.log(`\n=== run-once: "${city}", limit ${limit} ===\n`);

  const places = await searchRestaurants(`restaurants in ${city}`, limit);
  console.log(`Places returned: ${places.length}`);

  let processed = 0;
  for (const place of places) {
    const verdict = passesHardFilters(place);
    const name = place.displayName?.text ?? "(unknown)";
    if (!verdict.pass) {
      console.log(`  ✗ ${name} — ${verdict.reason}`);
      continue;
    }
    console.log(`  ✓ ${name} — passes filters, enriching...`);

    const existing = await db
      .select({ id: restaurants.id })
      .from(restaurants)
      .where(eq(restaurants.googlePlaceId, place.id))
      .limit(1);

    const row = {
      name,
      googlePlaceId: place.id,
      rating: place.rating ?? null,
      reviewCount: place.userRatingCount ?? null,
      priceLevel: priceLevelToInt(place.priceLevel),
      city,
      phone: place.nationalPhoneNumber ?? null,
      website: place.websiteUri ?? null,
      temporarilyClosed: place.businessStatus === "CLOSED_TEMPORARILY",
      deliveryEnabled: Boolean(place.delivery),
      photoCount: ownerPhotos(place).length, // owner-uploaded only
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

    await runEnrichment({ restaurantId: id, photoNames: ownerPhotos(place).map((p) => p.name) });
    processed++;
  }

  console.log(`\n=== done: ${processed} restaurants sourced + enriched ===`);
  process.exit(0);
}

main().catch((err) => {
  console.error("run-once failed:", err);
  process.exit(1);
});
