// Sourcing job: sweep the neighborhood GRID (worker/lib/grid.ts) with Google
// Places Nearby Search, keep the never-before-seen restaurants, and enqueue a
// per-restaurant enrichment job for the ones that clear the hard filters. Runs
// nightly on a cron (see worker/index.ts).
//
// WHY A GRID, NOT "restaurants in {city}" — citywide Text Search is
// prominence-ranked, so it structurally returns famous, well-photographed
// destinations (measured Aug 2026: median 9,554 reviews, zero places under 500)
// — the exact restaurants that already pay for photography and that we
// hand-reject. Nearby Search with rankPreference=DISTANCE over small circles
// returns EVERY restaurant in each circle nearest-first, so the modest
// neighborhood spots this product serves finally enter the pipeline. See grid.ts.
//
// COST SHAPE — the sweep (many Nearby calls) runs on the cheap Pro SKU. The
// Enterprise fields the filters need (rating/reviews/price/website/phone) are
// fetched via Place Details ONLY for new candidates, and only up to the nightly
// cap (config.nightlyEnrichCap). A place is Details-fetched at most once ever:
// candidates that fail the filters are recorded as `rejected` so they're skipped
// on future sweeps instead of re-billing a Details call every night.

import type { PgBoss } from "pg-boss";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "../config";
import { sendAlert } from "@/lib/alerts";
import {
  searchNearbyRestaurants,
  getPlaceDetailsForSourcing,
  priceLevelToInt,
  ownerPhotos,
  type Place,
} from "../lib/places";
import { passesHardFilters } from "../lib/filters";
import { isKnownChain } from "../lib/chains";
import { CITY_GRIDS } from "../lib/grid";
import { ENRICH_QUEUE, type EnrichJobData } from "./enrichRestaurant";

export { SOURCE_QUEUE } from "@/lib/queues";

export type SourceJobData = {
  // Optional overrides for manual/one-off runs; fall back to config.
  cities?: string[];
  limit?: number; // caps NEW candidates processed this run (the spend ceiling)
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSourcing(boss: PgBoss, data: SourceJobData): Promise<void> {
  const cities = data.cities ?? config.targetCities;
  const candidateCap = data.limit ?? config.nightlyEnrichCap; // 0 = no cap

  // --- 1. DISCOVER: sweep every grid cell for every city, dedup by place id. ---
  const discovered = new Map<string, { place: Place; city: string }>();
  let cellsSwept = 0;
  let cellFailures = 0;

  for (const city of cities) {
    const cells = CITY_GRIDS[city];
    if (!cells || cells.length === 0) {
      // A configured city with no grid cells sources nothing — that's a config
      // mismatch worth surfacing, not a silent zero.
      console.warn(`[source] no grid cells for "${city}" — add them in worker/lib/grid.ts`);
      await sendAlert(
        "Sourcing: a target city has no grid cells",
        `"${city}" is in WORKER_TARGET_CITIES but has no cells in worker/lib/grid.ts, so it sourced nothing. ` +
          `Either add neighborhood cells for it or remove it from WORKER_TARGET_CITIES.`
      );
      continue;
    }

    for (const cell of cells) {
      try {
        const places = await searchNearbyRestaurants(cell.lat, cell.lng, cell.radiusM);
        cellsSwept++;
        for (const place of places) {
          if (!discovered.has(place.id)) discovered.set(place.id, { place, city });
        }
      } catch (err) {
        // One cell's failure must not strand the rest of the run (a single
        // NO_RETRY pg-boss job). Count it; alert only if the whole sweep failed.
        cellFailures++;
        console.error(`[source] nearby FAILED for ${city}/${cell.name}:`, err instanceof Error ? err.message : err);
      }
      await sleep(config.placesThrottleMs);
    }
  }

  // --- 2. Keep only genuinely NEW places (skip everything already in the DB). ---
  const allIds = [...discovered.keys()];
  const existingRows = allIds.length
    ? await db
        .select({ pid: restaurants.googlePlaceId })
        .from(restaurants)
        .where(inArray(restaurants.googlePlaceId, allIds))
    : [];
  const existingIds = new Set(existingRows.map((r) => r.pid));
  const newAll = [...discovered.values()].filter((c) => !existingIds.has(c.place.id));

  // Drop known national franchises BEFORE spending a Place Details call on them —
  // the Nearby result already carries displayName, so this is free. They're not
  // recorded (no row), so they just get re-skipped for free on future sweeps.
  const newCandidates = newAll.filter((c) => !isKnownChain(c.place.displayName?.text));
  const chainsSkipped = newAll.length - newCandidates.length;

  // --- 3. Cap the number of new candidates we spend on this run. Uncapped ones
  //        simply reappear in tomorrow's sweep (they're not recorded), so the
  //        grid backfills over several nights instead of one huge bill. ---
  const toProcess = candidateCap > 0 ? newCandidates.slice(0, candidateCap) : newCandidates;

  // --- 4. For each: Place Details -> hard filters -> insert + enqueue (or record
  //        the rejection so we never Details-fetch it again). ---
  let enqueued = 0;
  let rejected = 0;
  let detailsFailed = 0;

  for (const { place: nearbyPlace, city } of toProcess) {
    let place: Place | null;
    try {
      place = await getPlaceDetailsForSourcing(nearbyPlace.id);
    } catch (err) {
      detailsFailed++;
      console.error(`[source] details FAILED for ${nearbyPlace.id}:`, err instanceof Error ? err.message : err);
      continue; // no row written -> retried on a future sweep
    }
    await sleep(config.placesThrottleMs);
    if (!place) continue; // 404 / permanently gone; skip (may reappear, that's fine)

    const name = place.displayName?.text ?? "(unknown)";
    const verdict = passesHardFilters(place);

    // Common column values whether we keep or reject — recording rejects means a
    // future sweep sees the row as "existing" and skips the Details re-fetch.
    const base = {
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
    };

    if (!verdict.pass) {
      rejected++;
      if (!config.dryRun) {
        await db
          .insert(restaurants)
          .values({ ...base, enrichmentStatus: "rejected" as const, rejectionReason: `Hard filter: ${verdict.reason}` });
      } else {
        console.log(`[source] (dry) would reject ${name} — ${verdict.reason}`);
      }
      continue;
    }

    if (config.dryRun) {
      console.log(`[source] (dry) would enqueue ${name} (${place.userRatingCount ?? "?"} reviews)`);
      enqueued++;
      continue;
    }

    const [inserted] = await db
      .insert(restaurants)
      .values({ ...base, enrichmentStatus: "sourced" as const })
      .returning({ id: restaurants.id });

    const enrichData: EnrichJobData = {
      restaurantId: inserted.id,
      // Score only the restaurant's OWN photos — customer snapshots aren't theirs
      // to replace and shouldn't drive the score or the signature dish.
      photoNames: ownerPhotos(place).map((p) => p.name).slice(0, config.photoScoreLimit),
    };
    await boss.send(ENRICH_QUEUE, enrichData);
    enqueued++;
  }

  console.log(
    `[source] done: swept ${cellsSwept} cells (${cellFailures} failed), ` +
      `discovered ${discovered.size} unique, ${chainsSkipped} chains skipped, ${newCandidates.length} new ` +
      `(${toProcess.length} processed this run), ${enqueued} enqueued, ${rejected} filtered out, ` +
      `${detailsFailed} details-failed` +
      (config.dryRun ? " (DRY RUN)" : "")
  );

  // The whole sweep failing looks identical to a tapped-out grid in the logs —
  // surface each distinctly.
  if (cellsSwept === 0 && !config.dryRun) {
    await sendAlert(
      "Sourcing swept zero cells",
      `Tonight's run couldn't complete a single Nearby Search (${cellFailures} cell attempts failed). ` +
        `The Google Places API key/quota is the likely cause — check /admin/photo/controls.`
    );
  } else if (enqueued === 0 && !config.dryRun) {
    await sendAlert(
      "Sourcing enqueued no new restaurants",
      `Tonight's grid sweep found ${discovered.size} places but enqueued 0 new leads ` +
        `(${newCandidates.length} were new; ${rejected} failed the hard filters). ` +
        `If this persists, the grid neighborhoods may be tapped out (add cells in worker/lib/grid.ts) ` +
        `or the filters may be too tight (worker/lib/filters.ts).`
    );
  }
}
