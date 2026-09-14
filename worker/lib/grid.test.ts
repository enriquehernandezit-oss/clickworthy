// Integrity tests for the neighborhood grid — a malformed cell (bad coords, a
// radius over the API max, a city with no cells) would silently source nothing
// or error the whole nightly run. Run with `bun test`.

import { expect, test, describe } from "bun:test";
import {
  CITY_GRIDS,
  interleaveByCity,
  cellStateKey,
  shouldSkipCell,
  nextCellStates,
  planCellSweep,
  haversineM,
  circleToRectangle,
  type CellSweepState,
} from "./grid";

// The four cities the pipeline ships targeting (config.targetCities default).
const SHIPPED_CITIES = ["Miami, FL", "New York, NY", "Chicago, IL", "Los Angeles, CA", "Nashville, TN", "Denver, CO", "San Diego, CA"];

describe("CITY_GRIDS", () => {
  test("every shipped target city has grid cells", () => {
    for (const city of SHIPPED_CITIES) {
      expect(CITY_GRIDS[city]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("cells are well-formed: valid US coords, radius within API limits, named", () => {
    for (const [city, cells] of Object.entries(CITY_GRIDS)) {
      const names = new Set<string>();
      for (const c of cells) {
        expect(c.name.trim().length, `${city} has an unnamed cell`).toBeGreaterThan(0);
        // Continental-US bounding box — a transposed lat/lng or a stray sign
        // would land outside it.
        expect(c.lat, `${city}/${c.name} lat`).toBeGreaterThan(24);
        expect(c.lat, `${city}/${c.name} lat`).toBeLessThan(49);
        expect(c.lng, `${city}/${c.name} lng`).toBeGreaterThan(-125);
        expect(c.lng, `${city}/${c.name} lng`).toBeLessThan(-66);
        // Nearby Search circle radius must be > 0 and <= 50,000 m.
        expect(c.radiusM, `${city}/${c.name} radius`).toBeGreaterThan(0);
        expect(c.radiusM, `${city}/${c.name} radius`).toBeLessThanOrEqual(50000);
        names.add(c.name);
      }
      expect(names.size, `${city} has duplicate cell names`).toBe(cells.length);
    }
  });
});

describe("interleaveByCity — prevents one city eating the nightly cap", () => {
  test("round-robins so a capped slice covers every city", () => {
    // 5 Miami then 5 NYC then 5 Chicago — a naive slice(0,6) would be all Miami.
    const items = [
      ...Array.from({ length: 5 }, (_, i) => ({ city: "Miami", n: i })),
      ...Array.from({ length: 5 }, (_, i) => ({ city: "NYC", n: i })),
      ...Array.from({ length: 5 }, (_, i) => ({ city: "Chicago", n: i })),
    ];
    const out = interleaveByCity(items);
    const firstSix = out.slice(0, 6).map((x) => x.city);
    expect(new Set(firstSix).size).toBe(3); // all three cities represented early
    expect(out.length).toBe(15); // nothing dropped
  });

  test("preserves each city's internal order", () => {
    const items = [
      { city: "A", n: 0 },
      { city: "A", n: 1 },
      { city: "B", n: 0 },
    ];
    const out = interleaveByCity(items);
    const aOrder = out.filter((x) => x.city === "A").map((x) => x.n);
    expect(aOrder).toEqual([0, 1]);
  });

  test("handles a single city and an empty list", () => {
    expect(interleaveByCity([]).length).toBe(0);
    expect(interleaveByCity([{ city: "A", n: 1 }]).length).toBe(1);
  });
});

describe("cellStateKey", () => {
  test("combines city and cell name with a delimiter unlikely to collide", () => {
    expect(cellStateKey("Miami, FL", "Hialeah")).toBe("Miami, FL::Hialeah");
  });
});

// The highest silent-regression risk in the cost-efficiency work: a wrong
// backoff decision either sweeps a saturated cell forever (no saving) or
// skips a cell too aggressively (misses genuinely new restaurants). Pure —
// unit-testable against synthetic state, no live Places call needed.
describe("shouldSkipCell", () => {
  // Fixed reference instant, matching the convention in lib/pipelineHealth.test.ts.
  const NOW = Date.parse("2026-09-09T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
  const state = (dryStreak: number, sweptDaysAgo: number): CellSweepState => ({
    dryStreak,
    lastSweptAt: daysAgo(sweptDaysAgo),
  });

  test("a never-swept cell (undefined state) always sweeps — covers all 14 just-added cells", () => {
    expect(shouldSkipCell(undefined, NOW)).toBe(false);
  });

  test("dryStreak 0 sweeps nightly regardless of when it was last swept", () => {
    expect(shouldSkipCell(state(0, 0), NOW)).toBe(false);
    expect(shouldSkipCell(state(0, 1), NOW)).toBe(false);
  });

  test("dryStreak 1-2 rests 3 FULL nights, then resumes on night 4", () => {
    expect(shouldSkipCell(state(1, 0), NOW)).toBe(true); // swept tonight, dry once — skip
    expect(shouldSkipCell(state(1, 2), NOW)).toBe(true); // 2 of 3 rest-nights elapsed — still skip
    expect(shouldSkipCell(state(1, 3), NOW)).toBe(true); // 3rd rest night — still skip (caught 2026-09-13: this used to sweep here, resting only 2 nights)
    expect(shouldSkipCell(state(1, 4), NOW)).toBe(false); // 4th night — rest is over, sweep again
    expect(shouldSkipCell(state(2, 3), NOW)).toBe(true); // dryStreak 2 behaves the same as 1
  });

  test("dryStreak 3+ rests 7 FULL nights, then resumes on night 8 — the cap, never longer", () => {
    expect(shouldSkipCell(state(3, 6), NOW)).toBe(true); // 6 of 7 rest-nights elapsed — still skip
    expect(shouldSkipCell(state(3, 7), NOW)).toBe(true); // 7th rest night — still skip
    expect(shouldSkipCell(state(3, 8), NOW)).toBe(false); // 8th night — sweep again
    expect(shouldSkipCell(state(10, 7), NOW)).toBe(true); // a much longer streak is still capped at 7, not longer
    expect(shouldSkipCell(state(10, 8), NOW)).toBe(false);
  });

  test("no cell ever goes unswept for more than 7 nights, at any dry streak", () => {
    for (const dryStreak of [1, 2, 3, 5, 20]) {
      expect(shouldSkipCell(state(dryStreak, 8), NOW), `dryStreak ${dryStreak} at 8 days`).toBe(false);
    }
  });

  test("a run a few seconds early or late lands on the same night count either way", () => {
    // The real bug: the cron fires a bit later each night, so lastSweptAt drifts
    // forward relative to a naive 24h clock. Rounding to the nearest night must
    // absorb both directions of drift around the 3-night boundary.
    const justUnder3 = new Date(NOW - (3 * 86_400_000 - 90_000)).toISOString(); // 90s short of 3 days
    const justOver3 = new Date(NOW - (3 * 86_400_000 + 90_000)).toISOString(); // 90s past 3 days
    expect(shouldSkipCell({ dryStreak: 1, lastSweptAt: justUnder3 }, NOW)).toBe(true);
    expect(shouldSkipCell({ dryStreak: 1, lastSweptAt: justOver3 }, NOW)).toBe(true);
  });
});

describe("nextCellStates — per-cell yield attribution", () => {
  const NOW_ISO = "2026-09-13T02:17:24.000Z";
  const swept = (key: string, mode: "nearby" | "text" = "nearby") => new Map([[key, mode]]);

  test("a swept cell with a productive (non-chain) new place resets to dryStreak 0", () => {
    const prev = { "Miami, FL::Hialeah": { dryStreak: 2, lastSweptAt: "2026-09-10T02:17:00.000Z" } };
    const next = nextCellStates(prev, swept("Miami, FL::Hialeah"), new Set(["Miami, FL::Hialeah"]), NOW_ISO);
    expect(next["Miami, FL::Hialeah"]).toEqual({ dryStreak: 0, lastSweptAt: NOW_ISO, mode: "nearby" });
  });

  test("a swept cell whose only new places were chains still increments dryStreak — the bug this fixes", () => {
    // Caller passes productiveKeys built from POST-chain-filter candidates only,
    // so a cell that found nothing but a McDonald's is correctly "not productive".
    const prev = { "Miami, FL::Hialeah": { dryStreak: 1, lastSweptAt: "2026-09-10T02:17:00.000Z" } };
    const next = nextCellStates(prev, swept("Miami, FL::Hialeah"), new Set(), NOW_ISO);
    expect(next["Miami, FL::Hialeah"]).toEqual({ dryStreak: 2, lastSweptAt: NOW_ISO, mode: "nearby" });
  });

  test("a cell with no prior state starts at dryStreak 1 when its sweep is unproductive", () => {
    const next = nextCellStates({}, swept("New York, NY::Ridgewood"), new Set(), NOW_ISO);
    expect(next["New York, NY::Ridgewood"]).toEqual({ dryStreak: 1, lastSweptAt: NOW_ISO, mode: "nearby" });
  });

  test("cells NOT in the swept map (skipped on cooldown, budget, or a failed call) are carried over untouched", () => {
    const prev = {
      "Miami, FL::Hialeah": { dryStreak: 5, lastSweptAt: "2026-09-06T02:17:00.000Z" },
      "Chicago, IL::Pilsen": { dryStreak: 0, lastSweptAt: "2026-09-12T02:17:00.000Z" },
    };
    // Neither key is swept — one was resting, one's Nearby call failed.
    const next = nextCellStates(prev, new Map(), new Set(), NOW_ISO);
    expect(next).toEqual(prev);
  });

  test("only swept cells are updated; unswept cells in the same run are untouched", () => {
    const prev = { "Chicago, IL::Pilsen": { dryStreak: 3, lastSweptAt: "2026-09-06T02:17:00.000Z" } };
    const next = nextCellStates(prev, swept("Miami, FL::Hialeah"), new Set(["Miami, FL::Hialeah"]), NOW_ISO);
    expect(next["Chicago, IL::Pilsen"]).toEqual(prev["Chicago, IL::Pilsen"]); // untouched
    expect(next["Miami, FL::Hialeah"]).toEqual({ dryStreak: 0, lastSweptAt: NOW_ISO, mode: "nearby" }); // new
  });

  test("records the ACTUAL mode used, not necessarily what was planned", () => {
    // e.g. a "text" plan that fell back to a plain nearby sweep because the
    // nightly Text Search budget was already spent (see sourceLeads.ts).
    const next = nextCellStates({}, swept("Denver, CO::Globeville", "text"), new Set(), NOW_ISO);
    expect(next["Denver, CO::Globeville"]?.mode).toBe("text");
  });
});

describe("planCellSweep — skip / nearby / text decision", () => {
  const NOW = Date.parse("2026-09-14T12:00:00.000Z");
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

  test("a never-swept cell starts on the cheap nearby search", () => {
    expect(planCellSweep(undefined, NOW)).toBe("nearby");
  });

  test("a nearby-mode cell that's still productive (dryStreak 0) stays on nearby", () => {
    expect(planCellSweep({ dryStreak: 0, lastSweptAt: daysAgo(1), mode: "nearby" }, NOW)).toBe("nearby");
  });

  test("a nearby-mode cell that just went dry STILL RESTS first — no promotion mid-rest", () => {
    // CAUGHT 2026-09-14 before this ever ran in production: an earlier
    // version promoted here immediately, with no rest spent — which would
    // have pulled every cell currently resting under the cooldown fix (19 of
    // them, checked live) straight back into spending, undoing that fix on
    // its very first night. The rest gate must apply before mode decides
    // anything.
    expect(planCellSweep({ dryStreak: 1, lastSweptAt: daysAgo(0), mode: "nearby" }, NOW)).toBe("skip");
    expect(planCellSweep({ dryStreak: 1, lastSweptAt: daysAgo(2), mode: "nearby" }, NOW)).toBe("skip"); // still resting
  });

  test("a nearby-mode cell promotes to text once its rest is OVER and it's still dry", () => {
    expect(planCellSweep({ dryStreak: 1, lastSweptAt: daysAgo(4), mode: "nearby" }, NOW)).toBe("text"); // 3-night rest elapsed
    expect(planCellSweep({ dryStreak: 2, lastSweptAt: daysAgo(4), mode: "nearby" }, NOW)).toBe("text");
  });

  test("a legacy row with no mode field (written before Text Search existed) is treated exactly like nearby mode", () => {
    expect(planCellSweep({ dryStreak: 0, lastSweptAt: daysAgo(1) }, NOW)).toBe("nearby");
    expect(planCellSweep({ dryStreak: 1, lastSweptAt: daysAgo(0) }, NOW)).toBe("skip"); // rests first, same as an explicit "nearby" row
    expect(planCellSweep({ dryStreak: 1, lastSweptAt: daysAgo(4) }, NOW)).toBe("text"); // promotes once rest is over
  });

  test("a text-mode cell follows the same 3/7-night backoff as shouldSkipCell", () => {
    expect(planCellSweep({ dryStreak: 1, lastSweptAt: daysAgo(0), mode: "text" }, NOW)).toBe("skip");
    expect(planCellSweep({ dryStreak: 1, lastSweptAt: daysAgo(4), mode: "text" }, NOW)).toBe("text"); // rest over
    expect(planCellSweep({ dryStreak: 3, lastSweptAt: daysAgo(6), mode: "text" }, NOW)).toBe("skip");
    expect(planCellSweep({ dryStreak: 3, lastSweptAt: daysAgo(8), mode: "text" }, NOW)).toBe("text"); // 7-night cap over
  });

  test("a text-mode cell that's productive again (dryStreak 0) sweeps every night, still in text mode", () => {
    expect(planCellSweep({ dryStreak: 0, lastSweptAt: daysAgo(1), mode: "text" }, NOW)).toBe("text");
  });
});

describe("haversineM", () => {
  test("zero distance from a point to itself", () => {
    expect(haversineM(40.7128, -74.006, 40.7128, -74.006)).toBeCloseTo(0, 1);
  });

  test("a known distance: roughly 1 degree of latitude is ~111.32 km", () => {
    expect(haversineM(0, 0, 1, 0)).toBeCloseTo(111_320, -3); // within ~1km
  });
});

describe("circleToRectangle", () => {
  test("is symmetric around the center", () => {
    const r = circleToRectangle(40.7128, -74.006, 1500);
    const centerLat = (r.low.latitude + r.high.latitude) / 2;
    const centerLng = (r.low.longitude + r.high.longitude) / 2;
    expect(centerLat).toBeCloseTo(40.7128, 6);
    expect(centerLng).toBeCloseTo(-74.006, 6);
  });

  test("longitude degrees are wider than latitude degrees away from the equator (cos correction)", () => {
    // At 40N, cos(40°) ≈ 0.766, so a given radius spans MORE longitude degrees
    // than latitude degrees to cover the same real distance.
    const r = circleToRectangle(40, -74, 1500);
    const latSpan = r.high.latitude - r.low.latitude;
    const lngSpan = r.high.longitude - r.low.longitude;
    expect(lngSpan).toBeGreaterThan(latSpan);
  });

  test("at the equator, latitude and longitude spans are equal (no cos correction needed)", () => {
    const r = circleToRectangle(0, 0, 1500);
    const latSpan = r.high.latitude - r.low.latitude;
    const lngSpan = r.high.longitude - r.low.longitude;
    expect(lngSpan).toBeCloseTo(latSpan, 6);
  });
});
