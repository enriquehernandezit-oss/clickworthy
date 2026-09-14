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
    const r = passesHardFilters(place({ userRatingCount: DEFAULT_FILTER_THRESHOLDS.maxReviews! + 100 }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toContain("established destination");
  });

  test("exactly at the ceiling passes (2000 is not > 2000)", () => {
    expect(passesHardFilters(place({ userRatingCount: DEFAULT_FILTER_THRESHOLDS.maxReviews! })).pass).toBe(true);
  });

  test("expensive ($$$) is rejected; unclassified price is allowed", () => {
    expect(passesHardFilters(place({ priceLevel: "PRICE_LEVEL_EXPENSIVE" })).pass).toBe(false);
    expect(passesHardFilters(place({ priceLevel: undefined })).pass).toBe(true);
  });

  test("no website now PASSES (routed to the phone call_list, not dropped)", () => {
    // Segment A: a good restaurant with no website is captured for phone outreach
    // rather than rejected. requireWebsite defaults to false.
    expect(passesHardFilters(place({ websiteUri: undefined })).pass).toBe(true);
  });

  test("requireWebsite:true (injected) still rejects a no-website place", () => {
    const t: FilterThresholds = { ...DEFAULT_FILTER_THRESHOLDS, requireWebsite: true };
    expect(passesHardFilters(place({ websiteUri: undefined }), t).pass).toBe(false);
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

// Split review floor (2026-09-13) — a live probe found 0/25 scraped emails in
// the 10-19-review band, but only for places that could ever REACH email
// discovery (an owned website). A no-website or dead-end-website (social/
// ordering-platform) place routes to the phone call_list regardless of review
// count, so raising its floor back to 20 would just lose phone leads for no
// email-yield reason — it keeps the looser 10 via minReviewsNoWebsite.
describe("passesHardFilters — split review floor by website type", () => {
  test("15 reviews with an owned website fails (below the 20 email-lead floor)", () => {
    const r = passesHardFilters(place({ userRatingCount: 15, websiteUri: "https://example.com" }));
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.reason).toContain("only 15 reviews (<20)");
  });

  test("15 reviews with no website at all passes (10 is the phone-lead floor)", () => {
    expect(passesHardFilters(place({ userRatingCount: 15, websiteUri: undefined })).pass).toBe(true);
  });

  test("15 reviews on an Instagram-only listing passes — a dead-end website is a phone lead too", () => {
    expect(passesHardFilters(place({ userRatingCount: 15, websiteUri: "https://instagram.com/joesdiner" })).pass).toBe(true);
  });

  test("15 reviews on a DoorDash/ordering-platform listing passes for the same reason", () => {
    expect(passesHardFilters(place({ userRatingCount: 15, websiteUri: "https://www.doordash.com/store/joes-diner-123" })).pass).toBe(true);
  });

  test("15 reviews on a free-subdomain site (Weebly/Wix) still fails — a real mailbox can exist there", () => {
    const r = passesHardFilters(place({ userRatingCount: 15, websiteUri: "https://joesdiner.weebly.com" }));
    expect(r.pass).toBe(false);
  });

  test("20 reviews with an owned website passes (exactly at the email-lead floor)", () => {
    expect(passesHardFilters(place({ userRatingCount: 20, websiteUri: "https://example.com" })).pass).toBe(true);
  });

  test("9 reviews fails even for a no-website/phone lead (below the 10 floor)", () => {
    expect(passesHardFilters(place({ userRatingCount: 9, websiteUri: undefined })).pass).toBe(false);
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
