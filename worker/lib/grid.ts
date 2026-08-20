// The neighborhood grid: where sourcing actually looks for restaurants.
//
// WHY THIS EXISTS — citywide Text Search ("restaurants in Miami") is
// prominence-ranked and structurally cannot return the modest neighborhood
// restaurants this product serves: measured Aug 2026, its pool had a median of
// 9,554 reviews and ZERO places under 500 reviews, while the DB it filled had
// exactly one restaurant under 150 reviews. Nearby Search over small circles
// with rankPreference=DISTANCE returns every restaurant in each circle
// nearest-first — prominence never gets a vote — so the grid below, not a
// query string, is the targeting instrument.
//
// Cell choice IS the targeting thesis (like the thresholds in filters.ts), so
// it lives in code where git is the audit trail. Cells are centered on
// working-class / immigrant / family-restaurant neighborhoods, not downtown
// cores or tourist strips — the segments where (per the Aug 2026 research
// pass) independent restaurants are least likely to already have professional
// photography. Coordinates are neighborhood centers, deliberately coarse; the
// radius is forgiving. Add/remove cells freely — dedup across overlapping
// circles happens by place id in the sourcing job.
//
// Keys MUST match config.targetCities entries exactly — the sourcing job looks
// its cities up here, and the `city` column written to the DB (which /admin
// filters on) comes from these keys.

export type GridCell = {
  name: string; // neighborhood label, for logs/reports
  lat: number;
  lng: number;
  radiusM: number; // Nearby Search circle radius (API max 50,000)
};

export const CITY_GRIDS: Record<string, GridCell[]> = {
  "Miami, FL": [
    { name: "Hialeah", lat: 25.8576, lng: -80.2781, radiusM: 1500 },
    { name: "Little Havana", lat: 25.7654, lng: -80.2196, radiusM: 1500 },
    { name: "Allapattah", lat: 25.8151, lng: -80.224, radiusM: 1500 },
    { name: "Little Haiti", lat: 25.8259, lng: -80.1936, radiusM: 1500 },
    { name: "Westchester", lat: 25.7548, lng: -80.3374, radiusM: 1500 },
    { name: "Coral Way", lat: 25.7503, lng: -80.2472, radiusM: 1500 },
    { name: "Kendall", lat: 25.6793, lng: -80.3173, radiusM: 1500 },
    { name: "North Miami", lat: 25.8901, lng: -80.1867, radiusM: 1500 },
    { name: "Sweetwater", lat: 25.7631, lng: -80.3728, radiusM: 1500 },
    { name: "Homestead", lat: 25.4687, lng: -80.4776, radiusM: 1500 },
  ],
  "New York, NY": [
    { name: "Jackson Heights", lat: 40.7557, lng: -73.8831, radiusM: 1200 },
    { name: "Washington Heights", lat: 40.8417, lng: -73.9394, radiusM: 1200 },
    { name: "Sunset Park", lat: 40.6453, lng: -74.0126, radiusM: 1200 },
    { name: "Flushing", lat: 40.7675, lng: -73.8331, radiusM: 1200 },
    { name: "Astoria", lat: 40.7644, lng: -73.9235, radiusM: 1200 },
    { name: "Bushwick", lat: 40.6944, lng: -73.9213, radiusM: 1200 },
    { name: "East Harlem", lat: 40.7947, lng: -73.9425, radiusM: 1200 },
    { name: "Bay Ridge", lat: 40.6264, lng: -74.0299, radiusM: 1200 },
    { name: "Corona", lat: 40.747, lng: -73.8603, radiusM: 1200 },
    { name: "Jamaica", lat: 40.7027, lng: -73.789, radiusM: 1200 },
    { name: "Inwood", lat: 40.8677, lng: -73.9212, radiusM: 1200 },
  ],
  "Chicago, IL": [
    { name: "Pilsen", lat: 41.8562, lng: -87.6572, radiusM: 1500 },
    { name: "Little Village", lat: 41.8445, lng: -87.7053, radiusM: 1500 },
    { name: "Albany Park", lat: 41.9683, lng: -87.7239, radiusM: 1500 },
    { name: "Logan Square", lat: 41.923, lng: -87.707, radiusM: 1500 },
    { name: "Bridgeport", lat: 41.8381, lng: -87.6511, radiusM: 1500 },
    { name: "Uptown", lat: 41.9665, lng: -87.6553, radiusM: 1500 },
    { name: "Belmont Cragin", lat: 41.9317, lng: -87.7686, radiusM: 1500 },
    { name: "Chinatown", lat: 41.8519, lng: -87.6323, radiusM: 1500 },
    { name: "Rogers Park", lat: 42.0096, lng: -87.674, radiusM: 1500 },
    { name: "Back of the Yards", lat: 41.8171, lng: -87.6961, radiusM: 1500 },
  ],
  "Los Angeles, CA": [
    { name: "Boyle Heights", lat: 34.0339, lng: -118.2073, radiusM: 1500 },
    { name: "Koreatown", lat: 34.058, lng: -118.301, radiusM: 1500 },
    { name: "Highland Park", lat: 34.1113, lng: -118.1926, radiusM: 1500 },
    { name: "Westlake", lat: 34.0575, lng: -118.274, radiusM: 1500 },
    { name: "Van Nuys", lat: 34.1867, lng: -118.4483, radiusM: 1500 },
    { name: "Huntington Park", lat: 33.9817, lng: -118.2251, radiusM: 1500 },
    { name: "South Gate", lat: 33.9547, lng: -118.212, radiusM: 1500 },
    { name: "Pacoima", lat: 34.2728, lng: -118.4262, radiusM: 1500 },
    { name: "Inglewood", lat: 33.9617, lng: -118.3531, radiusM: 1500 },
    { name: "El Sereno", lat: 34.0811, lng: -118.1765, radiusM: 1500 },
  ],
};
