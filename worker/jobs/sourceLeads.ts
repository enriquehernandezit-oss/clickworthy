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
// COST SHAPE — every field the filters need rides on the Nearby search call
// itself (rating/reviews/price/website/phone; ~1/11th the cost of per-place
// Place Details — see worker/lib/places.ts). Enrichment (Vision + NeverBounce)
// is the only per-lead spend, capped by config.nightlyEnrichCap. Candidates that
// fail the free hard filters are recorded as `rejected` so a future sweep skips
// them instead of re-enriching.

import type { PgBoss } from "pg-boss";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "../config";
import { getSetting, setSetting } from "@/lib/settings";
import { sendAlert } from "@/lib/alerts";
import { isSourcingBacklogDeep } from "@/lib/pipelineHealth";
import { dailyCap } from "./sendOutreach";
import {
  searchNearbyRestaurants,
  priceLevelToInt,
  ownerPhotos,
  type Place,
} from "../lib/places";
import { passesHardFilters } from "../lib/filters";
import { isKnownChain } from "../lib/chains";
import { CITY_GRIDS, interleaveByCity, cellStateKey, shouldSkipCell, type CellSweepState } from "../lib/grid";
import { ENRICH_QUEUE, type EnrichJobData } from "./enrichRestaurant";

export { SOURCE_QUEUE } from "@/lib/queues";

export type SourceJobData = {
  // Optional overrides for manual/one-off runs; fall back to config.
  cities?: string[];
  limit?: number; // caps NEW candidates processed this run (the spend ceiling)
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSourcing(boss: PgBoss, data: SourceJobData): Promise<void> {
  // Sourcing is the largest variable cost in the pipeline and is worth nothing
  // while sending is paused — the leads only pile up in `queued`. An explicit
  // `limit` on a manual/one-off run bypasses the pause on purpose, so a human
  // can still do a deliberate test sweep from /admin without un-pausing.
  const [paused, capOverride] = await Promise.all([
    getSetting("sourcing_paused"),
    getSetting("sourcing_nightly_cap"),
  ]);
  if (paused && data.limit == null) {
    console.log("[source] skipped — sourcing_paused is on (Controls). No Places calls, no spend.");
    return;
  }

  // Self-correcting ceiling, not a substitute for the manual pause above:
  // stop sourcing once unsent inventory already exceeds ~14 days of send
  // capacity, and resume on its own as that inventory gets worked down. This
  // is what the manual switch above can't do — it depends on remembering to
  // flip it back, which is exactly what didn't happen last time. Uses the
  // CONFIGURED cap (dailyCap()) even while outreach_paused is on, not an
  // effective rate of 0 — otherwise sourcing would stop dead the instant
  // sending pauses and there'd be nothing banked when it resumes. Same
  // `data.limit` escape hatch as the pause check above, for a deliberate
  // manual sweep.
  if (data.limit == null) {
    const [{ backlog }] = await db
      .select({ backlog: sql<number>`count(*)::int` })
      .from(restaurants)
      .where(and(eq(restaurants.enrichmentStatus, "queued"), eq(restaurants.suppressed, false)));
    const cap = await dailyCap();
    if (isSourcingBacklogDeep(backlog, cap)) {
      console.log(
        `[source] skipped — ${backlog} unsent leads already banked against a ${cap}/day send cap ` +
          `(${(backlog / cap).toFixed(1)} days), past the 14-day ceiling. No Places calls, no spend.`
      );
      return;
    }
  }

  const cities = data.cities ?? config.targetCities;
  // Precedence: explicit per-run limit > the Controls setting > config/env.
  const candidateCap = data.limit ?? capOverride ?? config.nightlyEnrichCap; // 0 = no cap

  // Per-cell adaptive cooldown — see shouldSkipCell() in grid.ts for the
  // decision itself. Read once; every cell's updated state is written back in
  // one shot after the sweep (step 2.5 below), never mutated mid-loop.
  const cellState = await getSetting("sourcing_cell_state");
  const nowMs = Date.now();
  let cellsSkippedCooldown = 0;

  // --- 1. DISCOVER: sweep every grid cell for every city, dedup by place id. ---
  const discovered = new Map<string, { place: Place; city: string; cellKey: string }>();
  const sweptCellKeys = new Set<string>(); // successfully swept this run — NOT skipped, NOT failed
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
      const cellKey = cellStateKey(city, cell.name);

      if (shouldSkipCell(cellState[cellKey], nowMs)) {
        cellsSkippedCooldown++;
        continue; // no Places call, no sleep — this cell costs nothing tonight
      }

      try {
        const places = await searchNearbyRestaurants(cell.lat, cell.lng, cell.radiusM);
        cellsSwept++;
        sweptCellKeys.add(cellKey);
        for (const place of places) {
          if (!discovered.has(place.id)) discovered.set(place.id, { place, city, cellKey });
        }
      } catch (err) {
        // One cell's failure must not strand the rest of the run (a single
        // NO_RETRY pg-boss job). Count it; alert only if the whole sweep failed.
        // NOT added to sweptCellKeys — a transient API failure must not start
        // or extend a cell's dry streak; its cooldown state is left untouched
        // so the next un-skipped night retries it fresh.
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

  // --- 2.5. Update per-cell cooldown state from what THIS run actually swept.
  //          A swept cell that produced at least one new-to-DB place (even one
  //          later cut by chains/candidateCap — still genuinely new) resets to
  //          nightly; one that swept clean comes up empty extends its dry
  //          streak. Skipped and failed cells are untouched — see their sites
  //          above for why. Written in one shot, after the sweep, never mid-loop. ---
  if (sweptCellKeys.size > 0) {
    const cellsWithNewLead = new Set(newAll.map((c) => c.cellKey));
    const nowIso = new Date(nowMs).toISOString();
    const nextState: Record<string, CellSweepState> = { ...cellState };
    for (const key of sweptCellKeys) {
      const prevStreak = cellState[key]?.dryStreak ?? 0;
      nextState[key] = {
        lastSweptAt: nowIso,
        dryStreak: cellsWithNewLead.has(key) ? 0 : prevStreak + 1,
      };
    }
    await setSetting("sourcing_cell_state", nextState);
  }

  // Drop known national franchises up front — free (the Nearby result carries
  // displayName). They're not recorded, so they re-skip for free on future sweeps.
  const newCandidates = newAll.filter((c) => !isKnownChain(c.place.displayName?.text, c.place.websiteUri));
  const chainsSkipped = newAll.length - newCandidates.length;

  // --- 3. Cap the number of new candidates we spend on this run. Interleave
  //        across cities FIRST so the cap is split roughly evenly (the grid
  //        sweeps Miami before NYC, so a naive slice would starve later cities).
  //        Uncapped leftovers aren't recorded, so they reappear in tomorrow's
  //        sweep — the grid backfills over several nights instead of one bill. ---
  const ordered = interleaveByCity(newCandidates);
  const toProcess = candidateCap > 0 ? ordered.slice(0, candidateCap) : ordered;

  // --- 4. For each: hard filters -> insert + enqueue (or record the rejection so
  //        it's not reconsidered). The Nearby result already carries every field
  //        the filters read — no per-place Place Details call. ---
  let enqueued = 0;
  let rejected = 0;

  for (const { place, city } of toProcess) {
    const name = place.displayName?.text ?? "(unknown)";
    const verdict = passesHardFilters(place);

    // Common column values whether we keep or reject — recording rejects means a
    // future sweep sees the row as "existing" and skips re-processing.
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
    `[source] done: swept ${cellsSwept} cells (${cellFailures} failed, ${cellsSkippedCooldown} skipped on cooldown), ` +
      `discovered ${discovered.size} unique, ${chainsSkipped} chains skipped, ${newCandidates.length} new ` +
      `(${toProcess.length} processed this run), ${enqueued} enqueued, ${rejected} filtered out` +
      (config.dryRun ? " (DRY RUN)" : "")
  );

  // The whole sweep failing looks identical to a tapped-out grid in the logs —
  // surface each distinctly. A cooldown-skipped cell is NOT a failure (see
  // shouldSkipCell in grid.ts), so cellsSwept === 0 only means a real outage
  // when nothing was skipped on cooldown either — otherwise every cell just
  // happened to be resting the same night, which is expected behavior, not
  // an alert-worthy one.
  if (cellsSwept === 0 && cellsSkippedCooldown === 0 && !config.dryRun) {
    await sendAlert(
      "Sourcing swept zero cells",
      `Tonight's run couldn't complete a single Nearby Search (${cellFailures} cell attempts failed). ` +
        `The Google Places API key/quota is the likely cause — check /admin/photo/controls.`
    );
  } else if (cellsSwept === 0 && cellsSkippedCooldown > 0) {
    console.log(
      `[source] all ${cellsSkippedCooldown} attempted cells were on cooldown tonight — not an outage, nothing to alert.`
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
