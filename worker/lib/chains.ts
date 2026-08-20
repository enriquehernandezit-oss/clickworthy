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
export function isKnownChain(name: string | null | undefined): boolean {
  const n = normalize(name ?? "");
  if (!n) return false;
  return FRANCHISE_NAMES.some((f) => n === f || n.startsWith(f + " "));
}
