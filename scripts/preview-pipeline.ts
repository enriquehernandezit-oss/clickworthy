// Integration preview of the whole sourcing pipeline on LIVE data — a safe dress
// rehearsal of a nightly run. Runs the real deployed path end to end:
//   grid Nearby Search -> dedup -> skip existing -> skip chains -> Place Details
//   -> hard filters -> photo-fit gates (Gate 1 + Gate 2)
// and reports the funnel + per-restaurant outcomes.
//
// Does NOT write to the DB and does NOT call NeverBounce — it stops at "would
// this lead be queued / rejected / needs-manual?". Spends Places (Nearby +
// Details) and, for non-sparse sites, Vision. Bounded by the candidate cap.
//
//   bun run scripts/preview-pipeline.ts                 # 2 cells/city, up to 24 processed
//   bun run scripts/preview-pipeline.ts "Miami, FL" 30  # one city, up to 30 processed

import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import {
  searchNearbyRestaurants,
  getPlaceDetailsForSourcing,
  type Place,
} from "@/worker/lib/places";
import { passesHardFilters } from "@/worker/lib/filters";
import { isKnownChain } from "@/worker/lib/chains";
import { CITY_GRIDS, interleaveByCity } from "@/worker/lib/grid";
import { fetchHomepageHtml } from "@/worker/lib/emailDiscovery";
import { assessPhotoFit } from "@/worker/lib/photoFit";

const THROTTLE_MS = 200;
const CELLS_PER_CITY = 3; // when no city arg — how many neighborhoods per city to sweep
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Arg parsing: a leading NUMBER means "all cities, this cap"; a leading city name
// means "that city, cap = next arg". So:
//   preview-pipeline.ts            -> all cities, default cap
//   preview-pipeline.ts 48         -> all cities, cap 48
//   preview-pipeline.ts "Miami, FL" 30
const arg2 = process.argv[2];
const arg2IsNum = arg2 !== undefined && arg2.trim() !== "" && Number.isFinite(Number(arg2));
const cityArg = arg2IsNum ? undefined : arg2;
const capRaw = arg2IsNum ? Number(arg2) : Number(process.argv[3]);
const maxCandidates = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 24;

// Build the cell list: one city if named, else the first N cells of each city.
const cells: { city: string; lat: number; lng: number; radiusM: number; name: string }[] = [];
if (cityArg) {
  const cs = CITY_GRIDS[cityArg];
  if (!cs) {
    console.error(`Unknown city "${cityArg}". Options:\n  ${Object.keys(CITY_GRIDS).join("\n  ")}`);
    process.exit(1);
  }
  for (const c of cs) cells.push({ city: cityArg, ...c });
} else {
  for (const [city, cs] of Object.entries(CITY_GRIDS)) {
    for (const c of cs.slice(0, CELLS_PER_CITY)) cells.push({ city, ...c });
  }
}

// --- 1. Sweep + dedup ---
console.log(`Sweeping ${cells.length} cells, processing up to ${maxCandidates} new candidates...\n`);
const discovered = new Map<string, { place: Place; city: string }>();
let cellFailures = 0;
for (const cell of cells) {
  try {
    const places = await searchNearbyRestaurants(cell.lat, cell.lng, cell.radiusM);
    for (const p of places) if (!discovered.has(p.id)) discovered.set(p.id, { place: p, city: cell.city });
  } catch (err) {
    cellFailures++;
    console.log(`  cell ${cell.city}/${cell.name} FAILED: ${err instanceof Error ? err.message : err}`);
  }
  await sleep(THROTTLE_MS);
}

// --- 2. Skip existing + chains ---
const ids = [...discovered.keys()];
const existing = ids.length
  ? await db.select({ pid: restaurants.googlePlaceId }).from(restaurants).where(inArray(restaurants.googlePlaceId, ids))
  : [];
const existingIds = new Set(existing.map((e) => e.pid));

let chains = 0;
const fresh: { place: Place; city: string }[] = [];
for (const c of discovered.values()) {
  if (existingIds.has(c.place.id)) continue;
  if (isKnownChain(c.place.displayName?.text)) {
    chains++;
    continue;
  }
  fresh.push(c);
}
const toProcess = interleaveByCity(fresh).slice(0, maxCandidates);

// --- 3. Details -> hard filters -> photo-fit gates ---
type Row = { name: string; city: string; reviews: number | null; outcome: string; detail: string };
const rows: Row[] = [];
const tally = { wouldQueue: 0, needsManual: 0, filtered: 0, photoRejected: 0, detailsFailed: 0, sparseKept: 0 };

for (const { place: nearby, city } of toProcess) {
  const d = await getPlaceDetailsForSourcing(nearby.id);
  await sleep(THROTTLE_MS);
  const name = d?.displayName?.text ?? nearby.displayName?.text ?? "?";
  if (!d) {
    tally.detailsFailed++;
    rows.push({ name, city, reviews: null, outcome: "no-details", detail: "gone" });
    continue;
  }
  const verdict = passesHardFilters(d);
  if (!verdict.pass) {
    tally.filtered++;
    rows.push({ name, city, reviews: d.userRatingCount ?? null, outcome: "filtered", detail: verdict.reason });
    continue;
  }

  const html = d.websiteUri ? await fetchHomepageHtml(d.websiteUri) : null;
  const fit = await assessPhotoFit(html, d.websiteUri ?? null);
  if (fit.decision === "reject") {
    tally.photoRejected++;
    rows.push({ name, city, reviews: d.userRatingCount ?? null, outcome: "PHOTO-REJECT", detail: `${fit.band} pro=${fit.proScore}` });
    continue;
  }
  // Kept — in the real run this proceeds to email discovery + NeverBounce. We
  // don't verify email here, so report it as "would-keep" and note the band.
  if (fit.band === "sparse") tally.sparseKept++;
  tally.wouldQueue++;
  rows.push({
    name,
    city,
    reviews: d.userRatingCount ?? null,
    outcome: "KEEP",
    detail: `${fit.band}${fit.proScore != null ? ` pro=${fit.proScore}` : ""}${fit.dish ? ` dish="${fit.dish}"` : ""}`,
  });
}

// --- 4. Report ---
console.log("=== FUNNEL ===");
console.log(`  discovered (unique): ${discovered.size}   (${cellFailures} cells failed)`);
console.log(`  already in DB:       ${existingIds.size}`);
console.log(`  chains skipped:      ${chains}`);
console.log(`  new & processed:     ${toProcess.length} of ${fresh.length} fresh`);
console.log(`    -> would KEEP:      ${tally.wouldQueue}  (of which ${tally.sparseKept} sparse = no Vision spent)`);
console.log(`    -> photo-rejected:  ${tally.photoRejected}  (already have pro photography)`);
console.log(`    -> hard-filtered:   ${tally.filtered}`);
console.log(`    -> no details:      ${tally.detailsFailed}`);

const keepRate = toProcess.length ? Math.round((tally.wouldQueue / toProcess.length) * 100) : 0;
console.log(`\n  KEEP rate among processed: ${keepRate}%  (vs the old ~20% approval on the citywide pool)`);

console.log("\n=== PER-RESTAURANT ===");
for (const r of rows.sort((a, b) => a.outcome.localeCompare(b.outcome))) {
  const tag = r.outcome === "KEEP" ? "✓ KEEP      " : r.outcome === "PHOTO-REJECT" ? "✗ PHOTO-REJ " : r.outcome === "filtered" ? "· filtered  " : "? " + r.outcome.padEnd(10);
  console.log(`  ${tag} ${String(r.reviews ?? "?").padStart(5)}rev  ${r.name.slice(0, 30).padEnd(30)} ${r.city.slice(0, 12).padEnd(12)} ${r.detail}`);
}

process.exit(0);
