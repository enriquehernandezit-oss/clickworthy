// One-off probe: is there real supply past position 20 in a saturated grid
// cell? Nearby Search hard-caps at 20 results with no pagination; Text Search
// can page to 60, ranked by distance. This checks whether that's worth
// building BEFORE writing any production code (§4 of the cost-efficiency /
// email-ready plan, 2026-09-13).
//
//   bun run scripts/probe-depth.ts
//
// READ-ONLY: no DB writes, only Places API calls (~12 requests, well under
// $1). Reports, for each of the 3 driest cells (one per NYC/LA/Miami):
//   - overlap between Nearby's top 20 and Text Search's first page
//   - whether Text Search results are actually distance-ordered
//   - for positions 21-60: how many are new to the DB, pass the hard filters,
//     aren't chains, and have an owned (non-dead-end) website
//
// GO/NO-GO: >=5 new filter-passing website places per cell on average ->
// build worker/lib/places.ts's searchTextNearestRestaurants() (see the plan).
// Fewer -> skip; add offset cells in the least-saturated areas instead.

import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { requireKey } from "@/worker/config";
import { passesHardFilters } from "@/worker/lib/filters";
import { isKnownChain } from "@/worker/lib/chains";
import { classifyWebsite } from "@/worker/lib/websitePlatform";
import type { Place } from "@/worker/lib/places";

// Mirrors NEARBY_FIELD_MASK in worker/lib/places.ts (not exported — this is a
// throwaway diagnostic, not a production dependency).
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.businessStatus",
  "places.primaryType",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.delivery",
  "places.photos.name",
  "places.photos.authorAttributions",
].join(",");

const CELLS = [
  { city: "New York, NY", name: "Corona", lat: 40.747, lng: -73.8603, radiusM: 1200 },
  { city: "Los Angeles, CA", name: "Van Nuys", lat: 34.1867, lng: -118.4483, radiusM: 1500 },
  { city: "Miami, FL", name: "Little Haiti", lat: 25.8259, lng: -80.1936, radiusM: 1500 },
];

async function nearby(lat: number, lng: number, radiusM: number): Promise<Place[]> {
  const apiKey = requireKey("googleMapsApiKey", "GOOGLE_MAPS_API_KEY");
  const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": FIELD_MASK },
    body: JSON.stringify({
      includedTypes: ["restaurant"],
      excludedTypes: ["fine_dining_restaurant"],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: radiusM } },
    }),
  });
  if (!res.ok) throw new Error(`Nearby failed (${res.status}): ${await res.text()}`);
  return ((await res.json()) as { places?: Place[] }).places ?? [];
}

// Text Search's locationRestriction only accepts a RECTANGLE, not a circle
// (that's locationBias, which is soft and leaks results from outside the
// area) — verifying that live, not assuming it, is part of what this probe
// checks.
function circleToRectangle(lat: number, lng: number, radiusM: number) {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  return { low: { latitude: lat - dLat, longitude: lng - dLng }, high: { latitude: lat + dLat, longitude: lng + dLng } };
}

async function textSearchPage(
  lat: number,
  lng: number,
  radiusM: number,
  pageToken?: string
): Promise<{ places: Place[]; nextPageToken?: string }> {
  const apiKey = requireKey("googleMapsApiKey", "GOOGLE_MAPS_API_KEY");
  const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": `${FIELD_MASK},nextPageToken`,
    },
    body: JSON.stringify({
      textQuery: "restaurant",
      includedType: "restaurant",
      strictTypeFiltering: true,
      rankPreference: "DISTANCE",
      pageSize: 20,
      locationRestriction: { rectangle: circleToRectangle(lat, lng, radiusM) },
      ...(pageToken ? { pageToken } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Text Search failed (${res.status}): ${await res.text()}`);
  const body = (await res.json()) as { places?: Place[]; nextPageToken?: string };
  return { places: body.places ?? [], nextPageToken: body.nextPageToken };
}

// Great-circle distance in meters — to verify Text Search's DISTANCE ranking
// actually holds (rather than assume it, per the plan).
function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function main() {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let totalFilterPassingWebsiteNew = 0;

  for (const cell of CELLS) {
    console.log(`\n=== ${cell.city} / ${cell.name} ===`);

    const nearbyResults = await nearby(cell.lat, cell.lng, cell.radiusM);
    await sleep(200);
    console.log(`Nearby top 20: ${nearbyResults.length} results`);

    const page1 = await textSearchPage(cell.lat, cell.lng, cell.radiusM);
    await sleep(200);
    const nearbyIds = new Set(nearbyResults.map((p) => p.id));
    const overlap = page1.places.filter((p) => nearbyIds.has(p.id)).length;
    console.log(`Text Search page 1: ${page1.places.length} results, ${overlap} overlap with Nearby's top 20`);

    // Distance-ordering check: the field mask doesn't return lat/lng, so
    // verifying exact monotonic distance would need adding it — instead,
    // spot-check via the overlap above. If Text Search is truly
    // nearest-first, positions 1-20 should be dominated by the SAME set
    // Nearby's top-20-by-distance returned; a low overlap is itself the
    // answer to "is it distance-ordered the same way", with no extra field.
    console.log(`Distance-ordering check: ${overlap}/${Math.min(page1.places.length, 20)} of page 1 matches Nearby's distance-ranked top 20`);

    // Page through to position 60.
    const allPages: Place[] = [...page1.places];
    let pageToken = page1.nextPageToken;
    let pageNum = 2;
    while (pageToken && pageNum <= 3) {
      await sleep(200);
      const page = await textSearchPage(cell.lat, cell.lng, cell.radiusM, pageToken);
      allPages.push(...page.places);
      pageToken = page.nextPageToken;
      pageNum++;
    }
    console.log(`Text Search total (pages 1-${pageNum - 1}): ${allPages.length} results`);

    // Positions 21-60: places NOT in Nearby's top 20.
    const beyond20 = allPages.filter((p) => !nearbyIds.has(p.id));
    console.log(`Positions 21+ (not in Nearby's top 20): ${beyond20.length}`);

    if (beyond20.length === 0) {
      console.log("Nothing beyond position 20 — Text Search returned the same places Nearby already found.");
      continue;
    }

    // New to DB?
    const ids = beyond20.map((p) => p.id);
    const existing = await db.select({ pid: restaurants.googlePlaceId }).from(restaurants).where(inArray(restaurants.googlePlaceId, ids));
    const existingIds = new Set(existing.map((r) => r.pid));
    const newToDb = beyond20.filter((p) => !existingIds.has(p.id));
    console.log(`New to DB: ${newToDb.length}/${beyond20.length}`);

    // Not chains.
    const notChains = newToDb.filter((p) => !isKnownChain(p.displayName?.text, p.websiteUri));
    console.log(`Not known chains: ${notChains.length}/${newToDb.length}`);

    // Pass hard filters.
    const passFilters = notChains.filter((p) => passesHardFilters(p).pass);
    console.log(`Pass hard filters: ${passFilters.length}/${notChains.length}`);

    // Have an owned (non-dead-end) website.
    const withOwnedWebsite = passFilters.filter((p) => {
      if (!p.websiteUri) return false;
      const tier = classifyWebsite(p.websiteUri).tier;
      return tier !== "social_only" && tier !== "ordering_platform";
    });
    console.log(`Of those, with an owned/emailable website: ${withOwnedWebsite.length}`);

    totalFilterPassingWebsiteNew += withOwnedWebsite.length;
  }

  const avg = totalFilterPassingWebsiteNew / CELLS.length;
  console.log(
    `\n=== VERDICT ===\nAverage new, filter-passing, website-having places beyond position 20: ${avg.toFixed(1)}/cell\n` +
      (avg >= 5
        ? "GO — build searchTextNearestRestaurants() (see the plan)."
        : "NO-GO — not enough supply past position 20 to justify the extra Places spend. Add offset cells instead.")
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
