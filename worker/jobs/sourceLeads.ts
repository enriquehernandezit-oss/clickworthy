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
import { isSourcingBacklogDeep, resolveCandidateCap } from "@/lib/pipelineHealth";
import { dailyCap } from "./sendOutreach";
import {
  searchNearbyRestaurants,
  searchTextNearestRestaurants,
  priceLevelToInt,
  ownerPhotos,
  type Place,
} from "../lib/places";
import { passesHardFilters } from "../lib/filters";
import { isKnownChain } from "../lib/chains";
import { CITY_GRIDS, interleaveByCity, cellStateKey, planCellSweep, nextCellStates, type GridCell } from "../lib/grid";
import { ENRICH_QUEUE, type EnrichJobData } from "./enrichRestaurant";

// A "text mode" cell (see planCellSweep, grid.ts) gets BOTH Nearby Search's
// cheap top-20 AND Text Search paged out to ~60 more, real-distance-sorted
// (searchTextNearestRestaurants) — merged and deduped by place id. Nearby
// stays in the mix rather than being replaced by Text Search alone: a live
// check (2026-09-13) found only 3 of Text Search's own first-20 results
// overlapped with Nearby's actual nearest 20, so Text Search's result POOL
// (not just its claimed ordering) can't be assumed to be a superset of
// Nearby's — dropping Nearby would risk a text-mode cell finding LESS than a
// plain nearby-mode cell would have, which defeats the point of promoting it.
async function searchCellDeep(cell: GridCell): Promise<Place[]> {
  const [nearby, deep] = await Promise.all([
    searchNearbyRestaurants(cell.lat, cell.lng, cell.radiusM),
    searchTextNearestRestaurants(cell.lat, cell.lng, cell.radiusM, 3),
  ]);
  const byId = new Map<string, Place>();
  for (const p of nearby) byId.set(p.id, p);
  for (const p of deep) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

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
  const candidateCap = resolveCandidateCap(data.limit, capOverride, config.nightlyEnrichCap); // 0 = no cap

  // Per-cell adaptive cooldown — see planCellSweep() in grid.ts for the
  // decision itself. Read once; every cell's updated state is written back in
  // one shot after the sweep (step 2.5 below), never mutated mid-loop.
  const [cellState, textBudget] = await Promise.all([
    getSetting("sourcing_cell_state"),
    getSetting("sourcing_text_sweeps_per_night"),
  ]);
  const nowMs = Date.now();

  // --- 1. PLAN: decide skip / nearby / text for every cell, WITHOUT calling
  //        Places yet. Split from the actual sweep (step 1b below) so the
  //        scarce text-search budget can be allocated fairly across cities
  //        BEFORE any cell spends it — see the interleave step. ---
  type CellRef = { city: string; cell: GridCell; cellKey: string };
  const nearbyCells: CellRef[] = [];
  const textCandidates: CellRef[] = []; // tentative "text" plan, pending budget
  let cellsSkippedCooldown = 0;

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
      const plan = planCellSweep(cellState[cellKey], nowMs);
      if (plan === "skip") cellsSkippedCooldown++;
      else if (plan === "nearby") nearbyCells.push({ city, cell, cellKey });
      else textCandidates.push({ city, cell, cellKey });
    }
  }

  // --- 1a. Fairly allocate the nightly text-search budget across cities —
  //         the same fairness problem interleaveByCity already solves for
  //         the candidate cap below, and the zone-fair-share allocator
  //         (worker/lib/sendAllocation.ts) solves for the daily send cap.
  //         Without this, cells are considered in the same fixed city order
  //         every night (Miami -> NYC -> ... -> San Diego, config.targetCities),
  //         so whichever cities sit early in that list would claim the whole
  //         budget first, every night, indefinitely — caught 2026-09-14
  //         before this ever ran in production. Cells past the budget are
  //         treated exactly like a cooldown skip: no calls, no state change,
  //         they compete again fresh next time they're due. ---
  const orderedTextCandidates = interleaveByCity(textCandidates);
  const budgetedText = orderedTextCandidates.slice(0, textBudget);
  cellsSkippedCooldown += orderedTextCandidates.length - budgetedText.length;

  // --- 1b. SWEEP: nearby cells first (cheap, unbudgeted), then the
  //         budgeted text-mode cells. Dedup by place id across everything. ---
  const discovered = new Map<string, { place: Place; city: string; cellKey: string }>();
  const sweptCellModes = new Map<string, "nearby" | "text">(); // successfully swept this run -> mode actually used
  let cellsSwept = 0;
  let cellFailures = 0;
  let textSweepsUsed = 0;

  async function sweepCell(ref: CellRef, plan: "nearby" | "text"): Promise<void> {
    try {
      const places =
        plan === "text"
          ? await searchCellDeep(ref.cell)
          : await searchNearbyRestaurants(ref.cell.lat, ref.cell.lng, ref.cell.radiusM);
      cellsSwept++;
      if (plan === "text") textSweepsUsed++;
      sweptCellModes.set(ref.cellKey, plan);
      for (const place of places) {
        if (!discovered.has(place.id)) discovered.set(place.id, { place, city: ref.city, cellKey: ref.cellKey });
      }
    } catch (err) {
      // One cell's failure must not strand the rest of the run (a single
      // NO_RETRY pg-boss job). Count it; alert only if the whole sweep failed.
      // NOT added to sweptCellModes — a transient API failure must not start
      // or extend a cell's dry streak; its cooldown state is left untouched
      // so the next un-skipped night retries it fresh.
      cellFailures++;
      console.error(`[source] ${plan} search FAILED for ${ref.city}/${ref.cell.name}:`, err instanceof Error ? err.message : err);
    }
    await sleep(config.placesThrottleMs);
  }

  for (const ref of nearbyCells) await sweepCell(ref, "nearby");
  for (const ref of budgetedText) await sweepCell(ref, "text");

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

  // Drop known national franchises up front — free (the Nearby result carries
  // displayName). They're not recorded, so they re-skip for free on future sweeps.
  // MUST happen before step 2.5 below: a chain is never inserted, so it would
  // otherwise reappear as "new" every night forever, making a cell with a
  // nearby McDonald's look permanently productive and never rest (caught
  // 2026-09-13 — 59/76 cells showed dryStreak 0 while real grid yield had
  // collapsed to 24/night).
  const newCandidates = newAll.filter((c) => !isKnownChain(c.place.displayName?.text, c.place.websiteUri));
  const chainsSkipped = newAll.length - newCandidates.length;

  // --- 2.5. Update per-cell cooldown state from what THIS run actually swept.
  //          A swept cell that produced at least one new-to-DB, non-chain
  //          place (even one later cut by candidateCap — still genuinely new)
  //          resets to nightly; one that swept clean (or found only chains)
  //          extends its dry streak. Skipped and failed cells are untouched —
  //          see their sites above for why. Written in one shot, after the
  //          sweep, never mid-loop. See nextCellStates() in grid.ts. ---
  if (sweptCellModes.size > 0) {
    const productiveCellKeys = new Set(newCandidates.map((c) => c.cellKey));
    const nowIso = new Date(nowMs).toISOString();
    const nextState = nextCellStates(cellState, sweptCellModes, productiveCellKeys, nowIso);
    await setSetting("sourcing_cell_state", nextState);
  }

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
    `[source] done: swept ${cellsSwept} cells (${textSweepsUsed} deep/text, ${cellFailures} failed, ` +
      `${cellsSkippedCooldown} skipped on cooldown/budget), discovered ${discovered.size} unique, ` +
      `${chainsSkipped} chains skipped, ${newCandidates.length} new (${toProcess.length} processed this run), ` +
      `${enqueued} enqueued, ${rejected} filtered out` +
      (config.dryRun ? " (DRY RUN)" : "")
  );

  // Record what THIS run actually did — read back by computeNightSession()
  // (lib/pipelineHealth.ts) for the Insights snapshot, so the frozen "nightly
  // cap" for a night reflects the live sourcing_nightly_cap override (if any)
  // actually in force, not just the compiled-in config default (see that
  // setting's own comment in lib/settings.ts for the bug this replaces).
  if (!config.dryRun) {
    await setSetting("sourcing_last_run", {
      at: new Date(nowMs).toISOString(),
      candidateCap,
      cellsSwept,
      cellsSkipped: cellsSkippedCooldown,
      textSweeps: textSweepsUsed,
      newCandidates: newCandidates.length,
      enqueued,
    });
  }

  // The whole sweep failing looks identical to a tapped-out grid in the logs —
  // surface each distinctly. A cooldown- or budget-skipped cell is NOT a
  // failure (see planCellSweep in grid.ts), so cellsSwept === 0 only means a
  // real outage when nothing was skipped on cooldown/budget either —
  // otherwise every cell just happened to be resting the same night, which is
  // expected behavior, not an alert-worthy one.
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
