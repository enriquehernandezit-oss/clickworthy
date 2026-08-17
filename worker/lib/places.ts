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
  "places.photos",
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
    (p.authorAttributions ?? []).some((a) => normalizePhotoAuthor(a.displayName) === placeName)
  );
}

function normalizePhotoAuthor(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
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
