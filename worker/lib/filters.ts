// Hard filters from PROJECT_CONTEXT Section 7. A place must pass ALL of these
// to enter the outreach pipeline. Photo count is deliberately NOT here — it's a
// priority signal only (see lib/priority.ts), never a disqualifier.

import type { Place } from "./places";
import { priceLevelToInt } from "./places";

export type FilterResult = { pass: true } | { pass: false; reason: string };

export function passesHardFilters(place: Place): FilterResult {
  const rating = place.rating ?? null;
  const reviews = place.userRatingCount ?? null;
  const price = priceLevelToInt(place.priceLevel);

  // Rating <= 4.0 (under-performing photos are the whole thesis; well-rated
  // places with great photos aren't the target). Require a rating to exist.
  if (rating === null) return { pass: false, reason: "no rating" };
  if (rating > 4.0) return { pass: false, reason: `rating ${rating} > 4.0` };

  // Reviews between 30 and 500 (enough signal, not a big established brand).
  if (reviews === null) return { pass: false, reason: "no review count" };
  if (reviews < 30) return { pass: false, reason: `only ${reviews} reviews (<30)` };
  if (reviews > 500) return { pass: false, reason: `${reviews} reviews (>500)` };

  // Price level $ or $$ only.
  if (price === null) return { pass: false, reason: "no/unknown price level" };
  if (price > 2) return { pass: false, reason: `price level ${price} (> $$)` };

  // Must be operational (not temporarily/permanently closed).
  if (place.businessStatus && place.businessStatus !== "OPERATIONAL") {
    return { pass: false, reason: `business status ${place.businessStatus}` };
  }

  // NOTE: "not a chain" and "not part of a hospitality group" are checked
  // separately (Claude + web search) in the enrichment step, since they can't
  // be determined from the Places response alone.
  return { pass: true };
}
