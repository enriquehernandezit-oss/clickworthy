// Integrity tests for the neighborhood grid — a malformed cell (bad coords, a
// radius over the API max, a city with no cells) would silently source nothing
// or error the whole nightly run. Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { CITY_GRIDS } from "./grid";

// The four cities the pipeline ships targeting (config.targetCities default).
const SHIPPED_CITIES = ["Miami, FL", "New York, NY", "Chicago, IL", "Los Angeles, CA"];

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
