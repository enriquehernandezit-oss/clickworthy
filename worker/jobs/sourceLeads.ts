// Sourcing job: query Google Places for restaurants in each target city, apply
// the hard filters, upsert the survivors into `restaurants`, and enqueue a
// per-restaurant enrichment job. Runs nightly on a cron (see worker/index.ts).

import type { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "../config";
import { searchRestaurants, priceLevelToInt, type Place } from "../lib/places";
import { passesHardFilters } from "../lib/filters";
import { ENRICH_QUEUE, type EnrichJobData } from "./enrichRestaurant";

export const SOURCE_QUEUE = "source-leads";

export type SourceJobData = {
  // Optional overrides for manual/one-off runs; fall back to config.
  cities?: string[];
  limit?: number;
};

// Upserts one place into `restaurants`, returning the row id, or null if it
// already existed and was recently enriched (skip re-processing).
async function upsertRestaurant(place: Place, city: string): Promise<number | null> {
  const name = place.displayName?.text ?? "(unknown)";
  const priceLevelInt = priceLevelToInt(place.priceLevel);

  const existing = await db
    .select({ id: restaurants.id, enrichmentStatus: restaurants.enrichmentStatus })
    .from(restaurants)
    .where(eq(restaurants.googlePlaceId, place.id))
    .limit(1);

  const row = {
    name,
    googlePlaceId: place.id,
    rating: place.rating ?? null,
    reviewCount: place.userRatingCount ?? null,
    priceLevel: priceLevelInt,
    city,
    phone: place.nationalPhoneNumber ?? null,
    website: place.websiteUri ?? null,
    temporarilyClosed: place.businessStatus === "CLOSED_TEMPORARILY",
    deliveryEnabled: Boolean(place.delivery),
    photoCount: place.photos?.length ?? 0,
    enrichmentStatus: "sourced" as const,
  };

  if (existing.length > 0) {
    // Refresh the Places-derived fields but don't reset a restaurant we've
    // already contacted back into the queue.
    if (existing[0].enrichmentStatus === "contacted") return null;
    await db.update(restaurants).set(row).where(eq(restaurants.id, existing[0].id));
    return existing[0].id;
  }

  const [inserted] = await db.insert(restaurants).values(row).returning({ id: restaurants.id });
  return inserted.id;
}

export async function runSourcing(boss: PgBoss, data: SourceJobData): Promise<void> {
  const cities = data.cities ?? config.targetCities;
  const perCityLimit = data.limit ?? config.sourceLimit;

  let sourced = 0;
  let rejected = 0;

  for (const city of cities) {
    const query = `restaurants in ${city}`;
    console.log(`[source] searching: "${query}" (limit ${perCityLimit || "∞"})`);

    const places = await searchRestaurants(query, perCityLimit || 60);

    for (const place of places) {
      const verdict = passesHardFilters(place);
      if (!verdict.pass) {
        rejected++;
        continue;
      }

      const id = await upsertRestaurant(place, city);
      if (id === null) continue;
      sourced++;

      // Enqueue enrichment. Photo `name` refs are passed transiently through
      // the job payload and used immediately for scoring — never stored in our
      // own tables (Google ToS forbids warehousing Places photos).
      const enrichData: EnrichJobData = {
        restaurantId: id,
        photoNames: (place.photos ?? []).map((p) => p.name),
      };
      await boss.send(ENRICH_QUEUE, enrichData);
    }
  }

  console.log(
    `[source] done: ${sourced} sourced + enrichment queued, ${rejected} rejected by hard filters` +
      (config.dryRun ? " (DRY RUN)" : "")
  );
}
