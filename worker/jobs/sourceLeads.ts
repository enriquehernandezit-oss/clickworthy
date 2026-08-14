// Sourcing job: query Google Places for restaurants in each target city, apply
// the hard filters, upsert the survivors into `restaurants`, and enqueue a
// per-restaurant enrichment job for the NEW ones. Runs nightly on a cron (see
// worker/index.ts).

import type { PgBoss } from "pg-boss";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "../config";
import { sendAlert } from "@/lib/alerts";
import { searchRestaurants, priceLevelToInt, type Place } from "../lib/places";
import { passesHardFilters } from "../lib/filters";
import { ENRICH_QUEUE, type EnrichJobData } from "./enrichRestaurant";

export { SOURCE_QUEUE } from "@/lib/queues";

export type SourceJobData = {
  // Optional overrides for manual/one-off runs; fall back to config.
  cities?: string[];
  limit?: number;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The outcome of upserting one place. Only `inserted` should trigger (paid)
// enrichment — the whole point is to NOT re-enrich a restaurant we already
// know about every single night.
type UpsertResult =
  | { action: "inserted"; id: number }
  | { action: "refreshed"; id: number } // already existed; volatile fields refreshed, no re-enrich
  | { action: "skipped" }; // already contacted — left completely untouched

// Upserts one place into `restaurants`.
//
// Critical: on an EXISTING row we refresh only volatile Places-derived fields
// and NEVER touch enrichmentStatus / photoCount / city / signatureDish. The old
// version wrote enrichmentStatus:"sourced" on every update, which reset
// rejected/queued/needs_manual_email rows back to the start and re-enqueued
// enrichment nightly — re-paying the full photo+Vision cost for the entire back
// catalogue every run.
async function upsertRestaurant(place: Place, city: string): Promise<UpsertResult> {
  const name = place.displayName?.text ?? "(unknown)";
  const priceLevelInt = priceLevelToInt(place.priceLevel);

  const [existing] = await db
    .select({ id: restaurants.id, enrichmentStatus: restaurants.enrichmentStatus })
    .from(restaurants)
    .where(eq(restaurants.googlePlaceId, place.id))
    .limit(1);

  if (existing) {
    // Never re-process a restaurant we've already contacted.
    if (existing.enrichmentStatus === "contacted") return { action: "skipped" };
    // Refresh only fields that legitimately change on Google over time. Notably
    // absent: enrichmentStatus, photoCount, city, and every enrichment-derived
    // field — those are owned by enrichment / sourcing-insert, not by a refresh.
    await db
      .update(restaurants)
      .set({
        name,
        rating: place.rating ?? null,
        reviewCount: place.userRatingCount ?? null,
        priceLevel: priceLevelInt,
        phone: place.nationalPhoneNumber ?? null,
        website: place.websiteUri ?? null,
        temporarilyClosed: place.businessStatus === "CLOSED_TEMPORARILY",
        deliveryEnabled: Boolean(place.delivery),
      })
      .where(eq(restaurants.id, existing.id));
    return { action: "refreshed", id: existing.id };
  }

  const [inserted] = await db
    .insert(restaurants)
    .values({
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
    })
    .returning({ id: restaurants.id });
  return { action: "inserted", id: inserted.id };
}

export async function runSourcing(boss: PgBoss, data: SourceJobData): Promise<void> {
  const cities = data.cities ?? config.targetCities;
  const perCityLimit = data.limit ?? config.perCityLimit;
  const enrichCap = config.nightlyEnrichCap; // 0 = no cap

  const seenPlaceIds = new Set<string>(); // dedupe across cities/overlapping results in ONE run
  let enqueued = 0;
  let rejected = 0;
  let refreshed = 0;

  outer: for (const city of cities) {
    const query = `restaurants in ${city}`;
    console.log(`[source] searching: "${query}" (limit ${perCityLimit})`);

    let places: Place[];
    try {
      places = await searchRestaurants(query, perCityLimit);
    } catch (err) {
      // One city's Places failure must not skip the remaining cities — the whole
      // run is a single NO_RETRY pg-boss job, so a throw here would strand the
      // rest until tomorrow. Log, alert, and move on.
      console.error(`[source] search FAILED for "${query}":`, err instanceof Error ? err.message : err);
      await sendAlert(
        "Sourcing search failed for a city",
        `The nightly sourcing run couldn't search "${query}": ${err instanceof Error ? err.message : String(err)}. ` +
          `Remaining cities still ran. If this repeats, check the Google Places API key/quota.`
      );
      continue;
    }

    await sleep(config.placesThrottleMs);

    for (const place of places) {
      if (seenPlaceIds.has(place.id)) continue; // already handled this place this run
      seenPlaceIds.add(place.id);

      if (!passesHardFilters(place).pass) {
        rejected++;
        continue;
      }

      const result = await upsertRestaurant(place, city);
      if (result.action === "skipped") continue;
      if (result.action === "refreshed") {
        refreshed++;
        continue; // already enriched (or in-flight) — do NOT re-enqueue / re-pay
      }

      // action === "inserted" — a genuinely new lead. Enqueue enrichment,
      // capping the photo payload so a place with 10 Google photos can't blow
      // past the scoring budget.
      const enrichData: EnrichJobData = {
        restaurantId: result.id,
        photoNames: (place.photos ?? []).map((p) => p.name).slice(0, config.photoScoreLimit),
      };
      if (config.dryRun) {
        // Dry run: exercise the real search/filter/upsert path (and the row it
        // wrote) at Places-cost only — but don't spend Anthropic/NeverBounce.
        console.log(`[source] (dry) would enrich ${result.id} (${place.displayName?.text ?? "?"}), ${enrichData.photoNames.length} photos`);
      } else {
        await boss.send(ENRICH_QUEUE, enrichData);
      }
      enqueued++;

      if (enrichCap > 0 && enqueued >= enrichCap) {
        console.log(`[source] nightly enrich cap (${enrichCap}) reached — stopping.`);
        break outer;
      }
    }
  }

  console.log(
    `[source] done: ${enqueued} new enqueued, ${refreshed} refreshed, ${rejected} rejected by filters` +
      (config.dryRun ? " (DRY RUN)" : "")
  );

  // A run that banks zero new leads is either a legitimately-tapped-out set or a
  // broken API key — and today those look identical in the logs (this is how a
  // 5-night sourcing outage went unnoticed). Surface it.
  if (enqueued === 0 && !config.dryRun) {
    await sendAlert(
      "Sourcing found no new restaurants",
      `Tonight's run enqueued 0 new leads (${refreshed} already-known refreshed, ${rejected} filtered out). ` +
        `If this persists for multiple nights, the target areas may be tapped out (widen WORKER_TARGET_CITIES) ` +
        `or the Google Places API may be failing — check /admin/photo/controls.`
    );
  }
}
