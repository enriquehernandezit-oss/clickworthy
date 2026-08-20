// Google Places API (New) client — Text Search + Photo media.
// Request/response shapes verified against the live docs (July 2026):
//   POST https://places.googleapis.com/v1/places:searchText
//     headers: X-Goog-Api-Key, X-Goog-FieldMask (no spaces), Content-Type
//     body: { textQuery, pageSize, pageToken? }
//     response: { places: [...], nextPageToken? }
//   GET  https://places.googleapis.com/v1/{photo.name}/media?maxWidthPx=...&key=...
//     -> redirects to the raw image bytes.

import { requireKey } from "../config";

const SEARCH_URL = "https://places.googleapis.com/v1/places:searchText";
const NEARBY_URL = "https://places.googleapis.com/v1/places:searchNearby";

// Fields we need. Requesting photos/phone/website bills at the Enterprise SKU,
// which is fine at our volume (1,000 free calls/mo covers the 200-restaurant
// month-1 run). Keep this list tight — every field can bump the SKU.
const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.rating",
  "places.userRatingCount",
  "places.priceLevel",
  "places.businessStatus",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  // Photo subfields are requested explicitly (not the broad `places.photos`) so
  // the dependency is visible here: `.name` feeds photo scoring, and
  // `.authorAttributions` is REQUIRED by ownerPhotos() to tell owner uploads from
  // customer photos. Dropping authorAttributions would silently make ownerPhotos
  // return [] for every place (no score, no dish) — keep both.
  "places.photos.name",
  "places.photos.authorAttributions",
  "places.delivery",
  "places.takeout",
  "places.dineIn",
].join(",");

export type PhotoAuthorAttribution = {
  displayName?: string; // the contributor's name — the business's own name for owner uploads
  uri?: string;
  photoUri?: string;
};

export type PlacePhoto = {
  name: string; // "places/{id}/photos/{ref}"
  widthPx?: number;
  heightPx?: number;
  authorAttributions?: PhotoAuthorAttribution[];
};

export type Place = {
  id: string;
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string; // PRICE_LEVEL_INEXPENSIVE, PRICE_LEVEL_MODERATE, ...
  businessStatus?: string; // OPERATIONAL, CLOSED_TEMPORARILY, CLOSED_PERMANENTLY
  websiteUri?: string;
  nationalPhoneNumber?: string;
  photos?: PlacePhoto[];
  delivery?: boolean;
  takeout?: boolean;
  dineIn?: boolean;
};

type SearchResponse = {
  places?: Place[];
  nextPageToken?: string;
};

// --- Grid sourcing (Nearby Search), billed in two tiers on purpose ---
//
// The nightly grid makes MANY search calls (one per neighborhood cell), so the
// search request stays on the Pro SKU ($32/1k, 5,000 free calls/mo): id, name,
// businessStatus, photos. The Enterprise-priced fields the pipeline also needs
// (rating, review count, price level, website, phone — $35/1k with only 1,000
// free when put on a SEARCH) are fetched afterwards via Place Details ($20/1k)
// and ONLY for places we haven't seen before. The old single-mask design billed
// every search page at the top SKU; this split keeps the whole grid inside the
// free tiers at current volume.

const NEARBY_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.businessStatus",
  "places.primaryType",
  "places.photos.name",
  "places.photos.authorAttributions",
].join(",");

// Place Details mask (no "places." prefix — Details returns a single object).
// Superset of what sourcing writes to the DB, including the photo subfields
// ownerPhotos() needs. delivery/takeout/dineIn stay: deliveryEnabled feeds the
// priority score and the Revenue Impact Card.
const DETAILS_FIELD_MASK = [
  "id",
  "displayName",
  "rating",
  "userRatingCount",
  "priceLevel",
  "businessStatus",
  "websiteUri",
  "nationalPhoneNumber",
  "photos.name",
  "photos.authorAttributions",
  "delivery",
  "takeout",
  "dineIn",
].join(",");

// One Nearby Search over a circle, ranked by DISTANCE — the whole point: within
// a small circle, every restaurant Google has indexed comes back nearest-first,
// so prominence (which citywide Text Search ranks by, and which buried our
// actual market) never filters the pool. fine_dining_restaurant is excluded
// server-side — that segment already pays for photography.
//
// Hard API limits: max 20 results per request, NO pagination — a denser area
// needs more/smaller circles, not a bigger request.
export async function searchNearbyRestaurants(
  lat: number,
  lng: number,
  radiusM: number
): Promise<Place[]> {
  const apiKey = requireKey("googleMapsApiKey", "GOOGLE_MAPS_API_KEY");
  const res = await fetch(NEARBY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": apiKey,
      "X-Goog-FieldMask": NEARBY_FIELD_MASK,
    },
    body: JSON.stringify({
      includedTypes: ["restaurant"],
      excludedTypes: ["fine_dining_restaurant"],
      maxResultCount: 20,
      rankPreference: "DISTANCE",
      locationRestriction: {
        circle: { center: { latitude: lat, longitude: lng }, radius: radiusM },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Places searchNearby failed (${res.status}): ${await res.text()}`);
  }
  const body = (await res.json()) as SearchResponse;
  return body.places ?? [];
}

// Full Place Details for a NEW candidate (Enterprise fields the nearby mask
// deliberately omits). Called once per never-before-seen place, before the hard
// filters — never for places already in the DB.
export async function getPlaceDetailsForSourcing(placeId: string): Promise<Place | null> {
  const apiKey = requireKey("googleMapsApiKey", "GOOGLE_MAPS_API_KEY");
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": DETAILS_FIELD_MASK },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Places details (sourcing) failed (${res.status}) for ${placeId}: ${await res.text()}`);
  }
  return (await res.json()) as Place;
}

// Runs a paginated Text Search for one query, returning up to `max` places.
export async function searchRestaurants(query: string, max: number): Promise<Place[]> {
  const apiKey = requireKey("googleMapsApiKey", "GOOGLE_MAPS_API_KEY");
  const collected: Place[] = [];
  let pageToken: string | undefined;

  while (collected.length < max) {
    const res = await fetch(SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": `${FIELD_MASK},nextPageToken`,
      },
      body: JSON.stringify({
        textQuery: query,
        // Always 20 (the API max). A SHRINKING pageSize on a continuation
        // request (pageToken present) is documented to return INVALID_ARGUMENT;
        // the final .slice(0, max) trims any overshoot instead.
        pageSize: 20,
        ...(pageToken ? { pageToken } : {}),
      }),
    });

    if (!res.ok) {
      throw new Error(`Places searchText failed (${res.status}): ${await res.text()}`);
    }

    const body = (await res.json()) as SearchResponse;
    if (body.places) collected.push(...body.places);

    if (!body.nextPageToken || !body.places?.length) break;
    pageToken = body.nextPageToken;
  }

  return collected.slice(0, max);
}

// Fetches one place's details by ID. Used to RE-PULL photos for a re-score:
// the transient photo refs from sourcing are never stored, so recovering a
// missed score means fetching the place fresh. Same photo subfields as the
// search field mask (see FIELD_MASK) — ownerPhotos() needs authorAttributions.
export async function getPlaceById(placeId: string): Promise<Place | null> {
  const apiKey = requireKey("googleMapsApiKey", "GOOGLE_MAPS_API_KEY");
  const fieldMask = "id,displayName,photos.name,photos.authorAttributions";
  const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
    headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fieldMask },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Places details failed (${res.status}) for ${placeId}: ${await res.text()}`);
  }
  return (await res.json()) as Place;
}

// Fetches the raw bytes of a place photo (follows the media redirect). Used
// only in-memory for Claude Vision scoring — bytes are never persisted
// (Google ToS forbids storing Places photos).
export async function fetchPhotoBytes(
  photoName: string,
  maxWidthPx = 1024
): Promise<{ bytes: Buffer; contentType: string }> {
  const apiKey = requireKey("googleMapsApiKey", "GOOGLE_MAPS_API_KEY");
  const url = `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=${maxWidthPx}&key=${apiKey}`;

  const res = await fetch(url); // redirects to the image by default
  if (!res.ok) {
    throw new Error(`Places photo media failed (${res.status}) for ${photoName}`);
  }
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, contentType };
}

// Google's `photos` array mixes the business's OWN uploads with customer photos
// and exposes no "isOwner" flag — but a business's own uploads are attributed to
// the business's own name (verified against live Places data: the owner photos
// carry authorAttributions.displayName === the place's displayName). We treat a
// photo as owner-authored when any of its attributions matches the place name.
//
// This is the difference between scoring a restaurant's own listing photos —
// which they can actually replace, and which the cold email's "your photo
// doesn't do it justice" pitch is about — and scoring a diner's phone snapshot.
// Ordering alone won't do it: owner photos usually come first, but not always.
export function ownerPhotos(place: Place): PlacePhoto[] {
  const placeName = normalizePhotoAuthor(place.displayName?.text);
  if (!placeName) return [];
  return (place.photos ?? []).filter((p) =>
    (p.authorAttributions ?? []).some((a) => authorMatchesPlace(normalizePhotoAuthor(a.displayName), placeName))
  );
}

// Normalize to bare lowercase alphanumerics + single spaces so cosmetic
// differences don't block a match: strip diacritics ("Café" -> "cafe"), drop
// apostrophes so possessives collapse ("Joe's" -> "joes", not "joe s"), then
// turn any remaining punctuation into a single space.
function normalizePhotoAuthor(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks ("café" -> "cafe")
    .replace(/['’]/g, "") // straight + curly apostrophes: possessives collapse, not split
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// An owner upload is attributed to the business's own name — but the attribution
// and the listing's displayName don't always match character-for-character (a
// legal/parent name, or a location suffix: "The Gage Chicago" vs "The Gage").
// Exact equality alone drops those, silently zeroing a real restaurant's photo
// score and signature dish. So we also accept the case where one normalized name
// is a WHOLE-WORD prefix of the other, guarding trivially short names that would
// over-match a coincidental customer name.
function authorMatchesPlace(author: string, place: string): boolean {
  if (!author || !place) return false;
  if (author === place) return true;
  const [shorter, longer] = author.length <= place.length ? [author, place] : [place, author];
  if (shorter.length < 3) return false; // too short to match on confidently
  return longer.startsWith(shorter + " ");
}

// PRICE_LEVEL_* enum -> the 1–4 integer the schema/filters use ($ = 1 ... $$$$ = 4).
export function priceLevelToInt(priceLevel: string | undefined): number | null {
  switch (priceLevel) {
    case "PRICE_LEVEL_INEXPENSIVE":
      return 1;
    case "PRICE_LEVEL_MODERATE":
      return 2;
    case "PRICE_LEVEL_EXPENSIVE":
      return 3;
    case "PRICE_LEVEL_VERY_EXPENSIVE":
      return 4;
    default:
      return null; // PRICE_LEVEL_FREE / UNSPECIFIED / missing
  }
}
