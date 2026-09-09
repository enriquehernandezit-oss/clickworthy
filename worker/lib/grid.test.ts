// Integrity tests for the neighborhood grid — a malformed cell (bad coords, a
// radius over the API max, a city with no cells) would silently source nothing
// or error the whole nightly run. Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { CITY_GRIDS, interleaveByCity, cellStateKey, shouldSkipCell, type CellSweepState } from "./grid";

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

  test("dryStreak 1-2 skips for 3 nights, then resumes", () => {
    expect(shouldSkipCell(state(1, 0), NOW)).toBe(true); // swept today, dry once — skip
    expect(shouldSkipCell(state(1, 2), NOW)).toBe(true); // 2 of 3 skip-nights elapsed — still skip
    expect(shouldSkipCell(state(1, 3), NOW)).toBe(false); // 3 full nights elapsed — sweep again
    expect(shouldSkipCell(state(2, 2), NOW)).toBe(true); // dryStreak 2 behaves the same as 1
  });

  test("dryStreak 3+ skips for 7 nights, then resumes — the cap, never longer", () => {
    expect(shouldSkipCell(state(3, 6), NOW)).toBe(true); // 6 of 7 skip-nights elapsed — still skip
    expect(shouldSkipCell(state(3, 7), NOW)).toBe(false); // 7 full nights — sweep again
    expect(shouldSkipCell(state(10, 6), NOW)).toBe(true); // a much longer streak is still capped at 7, not longer
    expect(shouldSkipCell(state(10, 7), NOW)).toBe(false);
  });

  test("no cell ever goes unswept for more than 7 nights, at any dry streak", () => {
    for (const dryStreak of [1, 2, 3, 5, 20]) {
      expect(shouldSkipCell(state(dryStreak, 8), NOW), `dryStreak ${dryStreak} at 8 days`).toBe(false);
    }
  });
});
