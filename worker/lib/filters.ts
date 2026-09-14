// Hard filters for the wide-net sourcing strategy. A place must pass ALL of
// these to enter the outreach pipeline. Photo count is deliberately NOT here —
// it's a priority signal only (see lib/priority.ts), never a disqualifier.
//
// These thresholds ARE the targeting thesis, so they live in code (git is the
// right audit trail for changing who we email), but they're injectable so a
// test can sweep values at zero API cost.

import type { Place } from "./places";
import { priceLevelToInt } from "./places";
import { isKnownChain } from "./chains";
import { classifyWebsite } from "./websitePlatform";

export type FilterResult = { pass: true } | { pass: false; reason: string };

export type FilterThresholds = {
  minReviews: number; // floor for a place with an OWNED, emailable website
  // Floor for everything else (no website, or a website that's really just a
  // Facebook/Instagram page or an ordering-platform listing — see
  // minReviewsFor() below). These route to the phone call_list, not email, so
  // the email-hit-rate rationale behind minReviews doesn't apply to them.
  minReviewsNoWebsite: number;
  maxReviews: number | null; // null = no ceiling
  maxPriceLevel: number; // 1 = $, 2 = $$, ...
  requireWebsite: boolean;
  maxRating: number | null; // null = no rating ceiling (wide net)
};

// Which floor applies: the stricter one for a website that could actually
// yield an email (none/free_subdomain/diy_builder/custom — everything
// enrichRestaurant.ts doesn't treat as a phone-only dead end), the looser one
// otherwise. Mirrors enrichRestaurant.ts's own isDeadEndWebsite check exactly
// so a place's filter floor and its eventual outreach segment never disagree.
function minReviewsFor(websiteUri: string | undefined, t: FilterThresholds): number {
  if (!websiteUri) return t.minReviewsNoWebsite;
  const tier = classifyWebsite(websiteUri).tier;
  const isDeadEndWebsite = tier === "social_only" || tier === "ordering_platform";
  return isDeadEndWebsite ? t.minReviewsNoWebsite : t.minReviews;
}

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
//
// Raised 800 -> 2000 on 2026-08-22: rechecking the 800-2000 band with the
// photo-fit gate (credits restored) showed it KEEPS 69% of that band (11/16
// sampled) rather than hand-rejecting all of it — the gate itself already
// screens out the professionally-photographed places in that range, so the
// ceiling was discarding recoverable email-ready supply (186 leads rejected,
// 183 of them with websites) for no gate-verified reason. Revert if the queue
// gets noticeably noisier than before.
//
// Floor lowered 20 -> 10 on 2026-09-08: the 62-cell grid saturated (nightly
// new-lead count fell to ~1-4 — see grid.ts) while 65 already-discovered
// restaurants sat hand-rejected for having 10-19 reviews, at zero marginal
// cost to re-admit (scripts/rescreen-rejected.ts). A 10-19-review place is
// small or newly opened — exactly the profile least likely to already employ
// a photographer, and "new opening" is already a segment sold the Grand
// Opening package.
//
// Split back apart 2026-09-13, for EMAIL leads only: a live probe of the
// 10-19-review band found 0 scraped emails out of 25 (0%), against 16-23% at
// every review count above 20 — this band wasn't finding smaller independents
// with real photo need, it was pure dilution of the (already scarce) email
// slots the nightly candidateCap spends on. But the reasoning that motivated
// the Sep 8 drop is still correct for the phone segment: a 10-19-review place
// with no website (or only a Facebook/ordering-platform page) can't produce
// an email either way, so there's no email-hit-rate to protect by raising ITS
// floor — keep it at 10 via minReviewsNoWebsite. See minReviewsFor() above.
export const DEFAULT_FILTER_THRESHOLDS: FilterThresholds = {
  minReviews: 20,
  minReviewsNoWebsite: 10,
  maxReviews: 2000,
  maxPriceLevel: 2,
  // No longer required: a good restaurant with NO website used to be dropped
  // here (un-emailable), but that discarded ~20% of prime small targets — the
  // exact low-digital-footprint places that most need the service. They now flow
  // through and enrichment routes them to the `call_list` (phone) segment instead
  // of rejecting them. Segment A of the three-channel outreach plan.
  requireWebsite: false,
  maxRating: null,
};

export function passesHardFilters(
  place: Place,
  t: FilterThresholds = DEFAULT_FILTER_THRESHOLDS
): FilterResult {
  const rating = place.rating ?? null;
  const reviews = place.userRatingCount ?? null;
  const price = priceLevelToInt(place.priceLevel);

  // Known national franchise — a guaranteed non-lead (corporate owns the brand
  // photography). Deterministic and free; the neighborhood grid surfaces plenty.
  if (isKnownChain(place.displayName?.text, place.websiteUri)) {
    return { pass: false, reason: `known chain (${place.displayName?.text ?? "?"})` };
  }

  // Rating ceiling is optional under the wide net. When set, compare with `>`
  // so an exact-boundary value passes (4.2 > 4.2 is false in IEEE754). A place
  // with no rating at all is allowed through — a new spot with few reviews is a
  // fine target, and the review floor below already screens out empty listings.
  if (t.maxRating !== null && rating !== null && rating > t.maxRating) {
    return { pass: false, reason: `rating ${rating} > ${t.maxRating}` };
  }

  // Enough reviews to be a real, operating business — not a fake/placeholder
  // listing — but below the ceiling that marks an established destination.
  // Which floor applies depends on whether this place could ever become an
  // EMAIL lead — see minReviewsFor() above.
  if (reviews === null) return { pass: false, reason: "no review count" };
  const minReviews = minReviewsFor(place.websiteUri, t);
  if (reviews < minReviews) return { pass: false, reason: `only ${reviews} reviews (<${minReviews})` };
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
