// Hard filters for the wide-net sourcing strategy. A place must pass ALL of
// these to enter the outreach pipeline. Photo count is deliberately NOT here —
// it's a priority signal only (see lib/priority.ts), never a disqualifier.
//
// These thresholds ARE the targeting thesis, so they live in code (git is the
// right audit trail for changing who we email), but they're injectable so a
// test can sweep values at zero API cost.

import type { Place } from "./places";
import { priceLevelToInt } from "./places";

export type FilterResult = { pass: true } | { pass: false; reason: string };

export type FilterThresholds = {
  minReviews: number;
  maxReviews: number | null; // null = no ceiling
  maxPriceLevel: number; // 1 = $, 2 = $$, ...
  requireWebsite: boolean;
  maxRating: number | null; // null = no rating ceiling (wide net)
};

// Grid-era defaults: any operational, affordable, real-but-not-famous
// restaurant with a website we can scrape an email from. No rating ceiling —
// we email regardless of how good their current photos already look.
//
// The review CEILING is back (the original 30–500 band was removed under the
// wide net) — but the history matters: it never "limited too much." It starved
// because citywide Text Search fed it a prominence-ranked pool whose median was
// 2,353 reviews (one restaurant under 150 in the whole DB). With the
// neighborhood grid feeding a real cross-section, the ceiling does its actual
// job: a place with thousands of reviews is an established destination that
// buys its own photography, and (measured) the segment we hand-reject.
export const DEFAULT_FILTER_THRESHOLDS: FilterThresholds = {
  minReviews: 20,
  maxReviews: 800,
  maxPriceLevel: 2,
  requireWebsite: true,
  maxRating: null,
};

export function passesHardFilters(
  place: Place,
  t: FilterThresholds = DEFAULT_FILTER_THRESHOLDS
): FilterResult {
  const rating = place.rating ?? null;
  const reviews = place.userRatingCount ?? null;
  const price = priceLevelToInt(place.priceLevel);

  // Rating ceiling is optional under the wide net. When set, compare with `>`
  // so an exact-boundary value passes (4.2 > 4.2 is false in IEEE754). A place
  // with no rating at all is allowed through — a new spot with few reviews is a
  // fine target, and the review floor below already screens out empty listings.
  if (t.maxRating !== null && rating !== null && rating > t.maxRating) {
    return { pass: false, reason: `rating ${rating} > ${t.maxRating}` };
  }

  // Enough reviews to be a real, operating business — not a fake/placeholder
  // listing — but below the ceiling that marks an established destination.
  if (reviews === null) return { pass: false, reason: "no review count" };
  if (reviews < t.minReviews) return { pass: false, reason: `only ${reviews} reviews (<${t.minReviews})` };
  if (t.maxReviews !== null && reviews > t.maxReviews) {
    return { pass: false, reason: `${reviews} reviews (>${t.maxReviews}) — established destination` };
  }

  // Reject only KNOWN-expensive places ($$$+); fine dining already pays for
  // professional photography. A missing price level is NOT a rejection under the
  // wide net — Google leaves plenty of ordinary independents unclassified, and
  // dropping them for missing data (not for being expensive) costs real volume.
  if (price !== null && price > t.maxPriceLevel) {
    return { pass: false, reason: `price level ${price} (> ${t.maxPriceLevel})` };
  }

  // Must be operational.
  if (place.businessStatus && place.businessStatus !== "OPERATIONAL") {
    return { pass: false, reason: `business status ${place.businessStatus}` };
  }

  // Require a website. Email discovery scrapes the website for a contact
  // address, so no website means an un-emailable lead — filtering here, BEFORE
  // enrichment, avoids paying to photo-score a restaurant we could never email.
  if (t.requireWebsite && !place.websiteUri) {
    return { pass: false, reason: "no website" };
  }

  return { pass: true };
}
