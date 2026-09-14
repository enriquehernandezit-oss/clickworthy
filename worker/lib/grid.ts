// The neighborhood grid: where sourcing actually looks for restaurants.
//
// WHY THIS EXISTS — citywide Text Search ("restaurants in Miami") is
// prominence-ranked and structurally cannot return the modest neighborhood
// restaurants this product serves: measured Aug 2026, its pool had a median of
// 9,554 reviews and ZERO places under 500 reviews, while the DB it filled had
// exactly one restaurant under 150 reviews. Nearby Search over small circles
// with rankPreference=DISTANCE returns every restaurant in each circle
// nearest-first — prominence never gets a vote — so the grid below, not a
// query string, is the targeting instrument.
//
// Cell choice IS the targeting thesis (like the thresholds in filters.ts), so
// it lives in code where git is the audit trail. Cells are centered on
// working-class / immigrant / family-restaurant neighborhoods, not downtown
// cores or tourist strips — the segments where (per the Aug 2026 research
// pass) independent restaurants are least likely to already have professional
// photography. Coordinates are neighborhood centers, deliberately coarse; the
// radius is forgiving. Add/remove cells freely — dedup across overlapping
// circles happens by place id in the sourcing job.
//
// Keys MUST match config.targetCities entries exactly — the sourcing job looks
// its cities up here, and the `city` column written to the DB (which /admin
// filters on) comes from these keys.

export type GridCell = {
  name: string; // neighborhood label, for logs/reports
  lat: number;
  lng: number;
  radiusM: number; // Nearby Search circle radius (API max 50,000)
};

// Reorders city-tagged items so a per-run cap is split roughly evenly across
// cities instead of being eaten by whichever city was swept first. The grid
// sweeps all of Miami's cells before New York's, so without this the nightly
// candidate cap would spend entirely on Miami and starve the other cities.
// Round-robin: one from each city in turn, preserving each city's own order.
export function interleaveByCity<T extends { city: string }>(items: T[]): T[] {
  const byCity = new Map<string, T[]>();
  for (const item of items) {
    const q = byCity.get(item.city);
    if (q) q.push(item);
    else byCity.set(item.city, [item]);
  }
  const queues = [...byCity.values()];
  const out: T[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const q of queues) {
      const next = q.shift();
      if (next !== undefined) {
        out.push(next);
        progressed = true;
      }
    }
  }
  return out;
}

// Per-cell adaptive cooldown state, keyed "City::CellName". Lives in the
// sourcing_cell_state setting (a plain jsonb blob — no migration, same
// pattern as worker_boot_info / package_tiers), owned and read/written
// entirely by sourceLeads.ts. Exported here so the pure decision below and
// its test can share the type without importing the worker job.
//
// `mode` — which search a cell is currently assigned: `nearby` (or absent,
// for rows written before Text Search mode existed) is the cheap 20-result
// sweep; `text` is the deeper Nearby+Text-Search-pages combo (see
// searchCellDeep in sourceLeads.ts), used once a cell has proven the shallow
// search alone is exhausted. A cell promoted to `text` stays there — see
// planCellSweep below.
export type CellSweepState = { lastSweptAt: string; dryStreak: number; mode?: "nearby" | "text" };

export function cellStateKey(city: string, cellName: string): string {
  return `${city}::${cellName}`;
}

// Pure — the actual per-cell sweep-vs-skip decision, unit-testable without a
// DB or a live Places call. A live probe (2026-09-08) found real cells 80-95%
// saturated: the same 62-76 fixed circles are re-swept nightly with no
// cooldown at all, so a cell whose restaurants are all already known still
// bills a full Nearby Search every night forever. Backoff, not a permanent
// skip — a cell earns its way back to nightly sweeps the moment it produces
// something new again (see the dryStreak reset in sourceLeads.ts), and the
// 7-night ceiling below means even a fully-dry cell is never unswept for
// more than a week, so a newly-opened restaurant still gets found promptly.
const DRY_SKIP_NIGHTS: Record<number, number> = { 0: 0, 1: 3, 2: 3 }; // dryStreak -> nights to rest; 3+ uses the cap below
const DRY_SKIP_NIGHTS_MAX = 7; // dryStreak >= 3

export function shouldSkipCell(state: CellSweepState | undefined, nowMs: number): boolean {
  if (!state) return false; // never swept — always sweep (covers all 14 just-added cells)
  const restNights = state.dryStreak >= 3 ? DRY_SKIP_NIGHTS_MAX : (DRY_SKIP_NIGHTS[state.dryStreak] ?? 0);
  if (restNights === 0) return false; // dryStreak 0 — swept nightly
  // Whole nights, not exact ms — the cron fires a few seconds later each
  // night (source-leads took 25-49s to run), so a raw ms/86_400_000 divide
  // drifted below the intended rest period and "rest 3 nights" actually
  // rested only 2 (caught 2026-09-13). Rounding to the nearest night makes a
  // run a few seconds early or late land on the same night count either way.
  const nightsElapsed = Math.round((nowMs - Date.parse(state.lastSweptAt)) / 86_400_000);
  return nightsElapsed <= restNights;
}

// What to actually DO with a cell tonight: skip it, sweep it with the cheap
// shallow search, or sweep it with the deeper combo. Nearby Search hard-caps
// at 20 results with no pagination — a cell that's gone dry on the shallow
// search hasn't necessarily run out of real supply, it may just have more
// than 20 restaurants in range.
//
// The rest gate (shouldSkipCell) applies FIRST, for both modes uniformly —
// a newly-dry cell still gets its full 3-night (then 7-night) rest under the
// cheap search, at zero Places cost, exactly like a cell that never gets
// promoted at all. Promotion to `text` only happens once that rest period has
// run its course and the cell is STILL dry when it's due to sweep again.
//
// CAUGHT 2026-09-14, before this ever ran in production: an earlier version
// of this function promoted on the very first dry night, with NO rest spent
// — which sounds like it finds real supply sooner, but concretely meant
// EVERY cell currently resting under the cooldown fix (19 of them, checked
// live) would be pulled straight back out of that rest and cost up to 4x on
// the very next run, directly undoing the savings that fix was built for.
// Gating on shouldSkipCell first preserves that rest completely; the only
// change from a plain nearby-mode cell's schedule is what happens once the
// rest is over and it's still dry — try the deeper search instead of just
// re-sweeping shallow again.
//
// A cell that reaches `text` mode stays there: searchCellDeep() already
// includes a plain Nearby sweep (see sourceLeads.ts), so there's no shallower
// mode to fall back to, and no reason to — see that function's own comment
// for why the deeper search doesn't just replace Nearby outright.
export type CellSweepPlan = "skip" | "nearby" | "text";

export function planCellSweep(state: CellSweepState | undefined, nowMs: number): CellSweepPlan {
  if (!state) return "nearby"; // never swept
  if (shouldSkipCell(state, nowMs)) return "skip"; // still resting — regardless of mode
  const mode = state.mode ?? "nearby"; // rows written before Text Search mode existed
  if (mode === "nearby" && state.dryStreak === 0) return "nearby"; // still productive on the shallow search
  return "text"; // due again and still dry, or already in text mode — try the deeper search
}

// Great-circle distance in meters. Used to sort Text Search results by REAL
// distance — verified live 2026-09-13 that Text Search's own
// rankPreference=DISTANCE does NOT return distance-ordered results despite
// the parameter name (a page of "nearest" results had real distances from
// the search center scattered 57m-878m, not increasing). Nearby Search's own
// DISTANCE ranking was NOT re-verified and is trusted as-is — it's the
// established, unchanged code path; only the new Text Search addition needed
// this correction.
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Text Search's locationRestriction only accepts a RECTANGLE, never a circle
// (a circle is only allowed in locationBias, which is soft — it can leak
// results from outside the area, which locationRestriction never does). The
// circumscribed square is ~27% larger in area than the circle it replaces;
// overlap with Nearby Search's own circle-based results is handled by
// place-id dedup in searchCellDeep (sourceLeads.ts), not here.
export function circleToRectangle(
  lat: number,
  lng: number,
  radiusM: number
): { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } } {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } };
}

// Builds next-run cell state from what THIS sweep actually did. Pure so the
// attribution logic (which cells count as "productive") is unit-testable
// without a DB — see sourceLeads.ts step 2.5 for how it's called.
//
// `productiveKeys` must be built from candidates that survive the chain
// filter (worker/lib/chains.ts), NOT from every new-to-DB place. A known
// chain is never inserted, so it reappears in `discovered` every night
// forever — crediting it as "this cell is productive" meant a cell with a
// McDonald's nearby never rested even once (caught 2026-09-13: 59/76 cells
// showed dryStreak 0 while the grid's real yield had collapsed to 24/night).
//
// `swept` maps each swept cell's key to the mode ACTUALLY used for it this
// run (which can differ from what planCellSweep proposed — e.g. a "text"
// plan that fell back to a plain "nearby" sweep because the nightly Text
// Search budget was already spent; see sourceLeads.ts). Recording the real
// mode, not the planned one, keeps state honest: a budget-limited cell simply
// tries for promotion again next time it's due, rather than being stuck
// claiming a `text` assignment it never actually got to use. Cells NOT in
// `swept` (skipped on cooldown/budget, or a failed API call — see
// sourceLeads.ts) are carried over untouched: a transient failure or a
// deliberate rest must not start or extend a dry streak.
export function nextCellStates(
  prev: Record<string, CellSweepState>,
  swept: ReadonlyMap<string, "nearby" | "text">,
  productiveKeys: ReadonlySet<string>,
  nowIso: string
): Record<string, CellSweepState> {
  const next: Record<string, CellSweepState> = { ...prev };
  for (const [key, mode] of swept) {
    const prevStreak = prev[key]?.dryStreak ?? 0;
    next[key] = {
      lastSweptAt: nowIso,
      dryStreak: productiveKeys.has(key) ? 0 : prevStreak + 1,
      mode,
    };
  }
  return next;
}

export const CITY_GRIDS: Record<string, GridCell[]> = {
  "Miami, FL": [
    { name: "Hialeah", lat: 25.8576, lng: -80.2781, radiusM: 1500 },
    { name: "Little Havana", lat: 25.7654, lng: -80.2196, radiusM: 1500 },
    { name: "Allapattah", lat: 25.8151, lng: -80.224, radiusM: 1500 },
    { name: "Little Haiti", lat: 25.8259, lng: -80.1936, radiusM: 1500 },
    { name: "Westchester", lat: 25.7548, lng: -80.3374, radiusM: 1500 },
    { name: "Coral Way", lat: 25.7503, lng: -80.2472, radiusM: 1500 },
    { name: "Kendall", lat: 25.6793, lng: -80.3173, radiusM: 1500 },
    { name: "North Miami", lat: 25.8901, lng: -80.1867, radiusM: 1500 },
    { name: "Sweetwater", lat: 25.7631, lng: -80.3728, radiusM: 1500 },
    { name: "Homestead", lat: 25.4687, lng: -80.4776, radiusM: 1500 },
  ],
  "New York, NY": [
    { name: "Jackson Heights", lat: 40.7557, lng: -73.8831, radiusM: 1200 },
    { name: "Washington Heights", lat: 40.8417, lng: -73.9394, radiusM: 1200 },
    { name: "Sunset Park", lat: 40.6453, lng: -74.0126, radiusM: 1200 },
    { name: "Flushing", lat: 40.7675, lng: -73.8331, radiusM: 1200 },
    { name: "Astoria", lat: 40.7644, lng: -73.9235, radiusM: 1200 },
    { name: "Bushwick", lat: 40.6944, lng: -73.9213, radiusM: 1200 },
    { name: "East Harlem", lat: 40.7947, lng: -73.9425, radiusM: 1200 },
    { name: "Bay Ridge", lat: 40.6264, lng: -74.0299, radiusM: 1200 },
    { name: "Corona", lat: 40.747, lng: -73.8603, radiusM: 1200 },
    { name: "Jamaica", lat: 40.7027, lng: -73.789, radiusM: 1200 },
    { name: "Inwood", lat: 40.8677, lng: -73.9212, radiusM: 1200 },
    // Added 2026-09-08 — only ~6% of NYC's land area had ever been swept (11
    // cells over 780 km^2). Same thesis as the rest of the grid.
    { name: "Elmhurst", lat: 40.7361, lng: -73.8781, radiusM: 1200 },
    { name: "Ridgewood", lat: 40.7057, lng: -73.9013, radiusM: 1200 },
    { name: "Bensonhurst", lat: 40.6111, lng: -73.9947, radiusM: 1200 },
    { name: "Fordham", lat: 40.8601, lng: -73.8959, radiusM: 1200 },
  ],
  "Chicago, IL": [
    { name: "Pilsen", lat: 41.8562, lng: -87.6572, radiusM: 1500 },
    { name: "Little Village", lat: 41.8445, lng: -87.7053, radiusM: 1500 },
    { name: "Albany Park", lat: 41.9683, lng: -87.7239, radiusM: 1500 },
    { name: "Logan Square", lat: 41.923, lng: -87.707, radiusM: 1500 },
    { name: "Bridgeport", lat: 41.8381, lng: -87.6511, radiusM: 1500 },
    { name: "Uptown", lat: 41.9665, lng: -87.6553, radiusM: 1500 },
    { name: "Belmont Cragin", lat: 41.9317, lng: -87.7686, radiusM: 1500 },
    { name: "Chinatown", lat: 41.8519, lng: -87.6323, radiusM: 1500 },
    { name: "Rogers Park", lat: 42.0096, lng: -87.674, radiusM: 1500 },
    { name: "Back of the Yards", lat: 41.8171, lng: -87.6961, radiusM: 1500 },
  ],
  "Los Angeles, CA": [
    { name: "Boyle Heights", lat: 34.0339, lng: -118.2073, radiusM: 1500 },
    { name: "Koreatown", lat: 34.058, lng: -118.301, radiusM: 1500 },
    { name: "Highland Park", lat: 34.1113, lng: -118.1926, radiusM: 1500 },
    { name: "Westlake", lat: 34.0575, lng: -118.274, radiusM: 1500 },
    { name: "Van Nuys", lat: 34.1867, lng: -118.4483, radiusM: 1500 },
    { name: "Huntington Park", lat: 33.9817, lng: -118.2251, radiusM: 1500 },
    { name: "South Gate", lat: 33.9547, lng: -118.212, radiusM: 1500 },
    { name: "Pacoima", lat: 34.2728, lng: -118.4262, radiusM: 1500 },
    { name: "Inglewood", lat: 33.9617, lng: -118.3531, radiusM: 1500 },
    { name: "El Sereno", lat: 34.0811, lng: -118.1765, radiusM: 1500 },
    // Added 2026-09-08 — only ~5% of LA's land area had ever been swept.
    { name: "Panorama City", lat: 34.2271, lng: -118.4490, radiusM: 1500 },
    { name: "Canoga Park", lat: 34.2011, lng: -118.5970, radiusM: 1500 },
    { name: "Wilmington", lat: 33.7753, lng: -118.2623, radiusM: 1500 },
    { name: "Bell Gardens", lat: 33.9653, lng: -118.1512, radiusM: 1500 },
  ],
  "Nashville, TN": [
    { name: "Nolensville Pike", lat: 36.1156, lng: -86.7302, radiusM: 1500 },
    { name: "Antioch", lat: 36.0595, lng: -86.6722, radiusM: 1500 },
    { name: "Charlotte Pike", lat: 36.152, lng: -86.857, radiusM: 1500 },
    { name: "Madison", lat: 36.257, lng: -86.713, radiusM: 1500 },
    { name: "Donelson", lat: 36.172, lng: -86.654, radiusM: 1500 },
    { name: "Woodbine", lat: 36.123, lng: -86.736, radiusM: 1500 },
    { name: "Gallatin Pike", lat: 36.198, lng: -86.74, radiusM: 1500 },
    // Added 2026-09-08 — Nashville was the least-covered city, ~4%.
    { name: "Dickerson Pike", lat: 36.212, lng: -86.751, radiusM: 1500 },
    { name: "Murfreesboro Pike", lat: 36.106, lng: -86.664, radiusM: 1500 },
    { name: "Hermitage", lat: 36.181, lng: -86.611, radiusM: 1500 },
  ],
  "Denver, CO": [
    { name: "Westwood", lat: 39.7, lng: -105.02, radiusM: 1500 },
    { name: "Havana St", lat: 39.71, lng: -104.86, radiusM: 1500 },
    { name: "Barnum", lat: 39.715, lng: -105.025, radiusM: 1500 },
    { name: "Elyria-Swansea", lat: 39.785, lng: -104.965, radiusM: 1500 },
    { name: "Montbello", lat: 39.785, lng: -104.86, radiusM: 1500 },
    { name: "Athmar Park", lat: 39.69, lng: -105.01, radiusM: 1500 },
    { name: "Globeville", lat: 39.788, lng: -104.982, radiusM: 1500 },
  ],
  "San Diego, CA": [
    { name: "City Heights", lat: 32.748, lng: -117.09, radiusM: 1500 },
    { name: "Barrio Logan", lat: 32.696, lng: -117.14, radiusM: 1500 },
    { name: "National City", lat: 32.678, lng: -117.099, radiusM: 1500 },
    { name: "Chula Vista", lat: 32.64, lng: -117.084, radiusM: 1500 },
    { name: "Logan Heights", lat: 32.7, lng: -117.13, radiusM: 1500 },
    { name: "Normal Heights", lat: 32.755, lng: -117.105, radiusM: 1500 },
    { name: "Linda Vista", lat: 32.77, lng: -117.17, radiusM: 1500 },
    // Added 2026-09-08 — only ~6% of San Diego's land area had ever been swept.
    { name: "El Cajon", lat: 32.795, lng: -116.962, radiusM: 1500 },
    { name: "San Ysidro", lat: 32.559, lng: -117.030, radiusM: 1500 },
    { name: "Mira Mesa", lat: 32.906, lng: -117.142, radiusM: 1500 },
  ],
};
