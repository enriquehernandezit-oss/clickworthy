// Franchise denylist — a cheap, deterministic disqualifier for obvious national
// chains. The neighborhood grid (worker/lib/grid.ts) deliberately fishes in
// working-class areas, which are thick with fast-food and casual-dining
// franchises (a live Little Havana sweep surfaced a Pizza Hut). A franchise
// location doesn't own its brand photography and can't buy our service — the
// corporate marketing team does — so it's a guaranteed non-lead.
//
// This complements, and runs cheaper than, the LLM hospitality-group check in
// enrichment (checkHospitalityGroup, ~6¢/call, off by default): matching a name
// against this list costs nothing and happens BEFORE the paid Place Details
// call, so a McDonald's never even gets a Details fetch. It only catches the
// big, unambiguous names — the LLM check (when enabled) is what reasons about
// local mini-chains and ambiguous cases.

// Normalized franchise names (lowercase, no punctuation). Matched as either the
// whole name or a leading token run, so "McDonald's", "McDonalds Times Square",
// and "Subway #2841" all hit, but a local "Havana Pizza" does not (it doesn't
// START with a franchise name). Keep this to nationally-recognized chains where
// a false positive is near-impossible.
const FRANCHISE_NAMES: string[] = [
  // Burgers / fast food
  "mcdonalds", "burger king", "wendys", "five guys", "in n out", "in n out burger",
  "shake shack", "whataburger", "jack in the box", "sonic drive in", "sonic",
  "carls jr", "hardees", "white castle", "checkers", "rallys", "culvers",
  "smashburger", "fatburger", "wingstop", "buffalo wild wings", "hooters",
  // Chicken
  "kfc", "popeyes", "chick fil a", "raising canes", "zaxbys", "bojangles",
  "churchs chicken", "churchs texas chicken", "el pollo loco", "wingstreet",
  // Pizza
  "pizza hut", "dominos", "dominos pizza", "papa johns", "little caesars",
  "papa murphys", "marcos pizza", "cicis", "cicis pizza", "sbarro", "blaze pizza",
  "mod pizza", "round table pizza",
  // Mexican / fast-casual
  "taco bell", "chipotle", "chipotle mexican grill", "qdoba", "moes southwest grill",
  "del taco", "baja fresh", "rubios", "panda express", "pei wei",
  // Sandwiches / subs
  "subway", "jimmy johns", "jersey mikes", "jersey mikes subs", "firehouse subs",
  "potbelly", "quiznos", "which wich", "mcalisters deli", "schlotzskys",
  "panera bread", "panera", "corner bakery",
  // Coffee / donuts / snacks
  "starbucks", "dunkin", "dunkin donuts", "tim hortons", "krispy kreme",
  "baskin robbins", "auntie annes", "cinnabon", "dairy queen", "jamba juice",
  "smoothie king", "krystal",
  // Casual dining sit-down chains
  "applebees", "chilis", "tgi fridays", "olive garden", "red lobster",
  "outback steakhouse", "outback", "the cheesecake factory", "cheesecake factory",
  "ihop", "dennys", "waffle house", "cracker barrel", "red robin", "texas roadhouse",
  "longhorn steakhouse", "golden corral", "ruby tuesday", "perkins", "dennys diner",
  "bob evans", "friendlys", "carrabbas", "carrabbas italian grill", "on the border",
  "pf changs", "pf changs china bistro", "california pizza kitchen",
  "buffalo wild wings go", "arbys",
  // Convenience stores that Google tags as restaurants (they sell hot food) —
  // caught in production: two 7-Eleven locations queued for outreach.
  "7 eleven", "circle k", "wawa", "sheetz", "quiktrip", "casey s general store",
  "speedway", "royal farms",
  // Regional / casual-dining chains missed by the first pass — caught in
  // production: Lazy Dog (~50 locations) and Foster's Freeze (~90 locations)
  // both reached the queued/email-ready pool.
  "lazy dog restaurant", "lazy dog", "fosters freeze", "black bear diner",
  "mimis cafe", "corner bakery cafe", "portillos", "portillos hot dogs",
  "raising canes chicken fingers", "chicken salad chick", "first watch",
  "another broken egg cafe", "snooze an am eatery", "eggs up grill",
  // Caught in the next run: "Pollo Feliz" (680 reviews, Chicago) reached
  // queued via a per-city-subdomain franchise site (chicago.pollofeliz.com,
  // "Pollo Feliz USA" branding) — same shape as the Lazy Dog catch above.
  "pollo feliz",
];

// Hotel/hospitality-CHAIN domains. A restaurant living on one of these is a
// hotel dining outlet with a corporate marketing team, not an independent
// owner — caught in production: "Noe Restaurant & Bar" resolved to an
// info@omnihotels.com corporate mailbox. Name-matching can't catch this (the
// restaurant's own name is unbranded), so it's checked against the WEBSITE
// domain instead.
const HOTEL_CHAIN_DOMAINS = [
  "omnihotels.com", "marriott.com", "hilton.com", "hyatt.com", "ihg.com",
  "wyndhamhotels.com", "choicehotels.com", "bestwestern.com", "fourseasons.com",
  "ritzcarlton.com", "fairmont.com", "loewshotels.com", "kimptonhotels.com",
  "sonesta.com", "marriott.com", "starwoodhotels.com", "accor.com",
];

// Normalize to bare lowercase alphanumerics + single spaces (same shape used for
// photo-author matching in places.ts): strip diacritics, drop apostrophes so
// possessives collapse ("Wendy's" -> "wendys"), turn other punctuation into a
// single space.
function normalize(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// True when the restaurant name is a known national franchise. Matches the whole
// normalized name or a leading franchise-name token run, so location suffixes and
// store numbers still hit while a local name that merely CONTAINS a food word
// (e.g. "Havana Pizza") does not.
export function isKnownChain(name: string | null | undefined, website?: string | null): boolean {
  const n = normalize(name ?? "");
  if (n && FRANCHISE_NAMES.some((f) => n === f || n.startsWith(f + " "))) return true;
  if (website) {
    try {
      const host = new URL(website).hostname.replace(/^www\./, "").toLowerCase();
      if (HOTEL_CHAIN_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) return true;
    } catch {
      // malformed URL — fall through, not a chain signal either way
    }
  }
  return false;
}
