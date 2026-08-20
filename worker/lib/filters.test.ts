// Tests for the hard filters — especially the review CEILING reintroduced for
// the grid era (a place with thousands of reviews is an established destination
// that already pays for photography). Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { passesHardFilters, DEFAULT_FILTER_THRESHOLDS, type FilterThresholds } from "./filters";
import type { Place } from "./places";

// Minimal Place builder — only the fields the filters read.
function place(over: Partial<Place> = {}): Place {
  return {
    id: "test",
    displayName: { text: "Test Restaurant" },
    rating: 4.3,
    userRatingCount: 120,
    priceLevel: "PRICE_LEVEL_MODERATE",
    businessStatus: "OPERATIONAL",
    websiteUri: "https://example.com",
    ...over,
  };
}

describe("passesHardFilters — defaults", () => {
  test("a modest neighborhood restaurant passes", () => {
    expect(passesHardFilters(place()).pass).toBe(true);
  });

  test("too few reviews fails", () => {
    const r = passesHardFilters(place({ userRatingCount: 5 }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toContain("reviews");
  });

  test("no review count fails (placeholder listing)", () => {
    expect(passesHardFilters(place({ userRatingCount: undefined })).pass).toBe(false);
  });

  test("above the review ceiling fails — the established-destination cut", () => {
    const r = passesHardFilters(place({ userRatingCount: 900 }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toContain("established destination");
  });

  test("exactly at the ceiling passes (800 is not > 800)", () => {
    expect(passesHardFilters(place({ userRatingCount: DEFAULT_FILTER_THRESHOLDS.maxReviews! })).pass).toBe(true);
  });

  test("expensive ($$$) is rejected; unclassified price is allowed", () => {
    expect(passesHardFilters(place({ priceLevel: "PRICE_LEVEL_EXPENSIVE" })).pass).toBe(false);
    expect(passesHardFilters(place({ priceLevel: undefined })).pass).toBe(true);
  });

  test("no website fails (un-emailable)", () => {
    expect(passesHardFilters(place({ websiteUri: undefined })).pass).toBe(false);
  });

  test("non-operational fails", () => {
    expect(passesHardFilters(place({ businessStatus: "CLOSED_TEMPORARILY" })).pass).toBe(false);
  });

  test("a known franchise fails even when every metric qualifies", () => {
    const r = passesHardFilters(place({ displayName: { text: "Pizza Hut" }, userRatingCount: 727, priceLevel: "PRICE_LEVEL_INEXPENSIVE" }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toContain("chain");
  });
});

describe("passesHardFilters — injectable thresholds", () => {
  test("maxReviews=null lifts the ceiling (a well-reviewed place passes)", () => {
    const t: FilterThresholds = { ...DEFAULT_FILTER_THRESHOLDS, maxReviews: null };
    expect(passesHardFilters(place({ userRatingCount: 9000 }), t).pass).toBe(true);
  });

  test("a tighter ceiling rejects a place the default would accept", () => {
    const t: FilterThresholds = { ...DEFAULT_FILTER_THRESHOLDS, maxReviews: 300 };
    expect(passesHardFilters(place({ userRatingCount: 500 }), t).pass).toBe(false);
  });
});
