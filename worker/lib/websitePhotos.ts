// Gate 1 of the "does this restaurant already have professional photography?"
// fit check — the auto-reject that stops us paying to draft high-end places that
// would never approve (they already shoot their own food beautifully; see the
// sourcing-fit plan).
//
// This module is DETERMINISTIC and FREE: it reads the homepage HTML we already
// download during email discovery (worker/lib/emailDiscovery.ts) and scores how
// professionally-photographed the site looks from structural markers alone — no
// LLM, no extra network call. It never rejects on its own; a reject requires a
// SECOND, independent Vision look at the site's best image to agree (see
// decidePhotoFit below). Two independent methods must both say "already pro"
// before a lead is dropped — that's what makes the auto-reject high-confidence.
//
// All parsing is string/regex based (the worker has no DOM), matching the style
// already used to scrape emails out of the same HTML.

export type WebsitePhotoSignals = {
  ogImage: boolean; // og:image / twitter:image present — the site declares a hero
  proPlatform: boolean; // built on a photo-forward restaurant web platform / image CDN
  galleryPage: boolean; // links to a dedicated gallery/photos/portfolio page
  instagramFeed: boolean; // embeds a live Instagram feed (not just a footer IG link)
  largeImages: number; // count of high-resolution image indicators (capped)
  totalImages: number; // total <img> tags — a rough density signal
};

export type PhotoRichnessBand = "rich" | "unclear" | "sparse";

export type WebsitePhotoAnalysis = {
  richness: number; // 0–100; higher = looks more professionally photographed
  band: PhotoRichnessBand;
  signals: WebsitePhotoSignals;
};

// Weights that build the 0–100 richness score. Exported so a test (or a future
// calibration pass against real approve/reject outcomes) can sweep them without
// editing logic. The point estimates below are deliberately round.
export const RICHNESS_WEIGHTS = {
  ogImage: 15,
  proPlatform: 20,
  galleryPage: 20,
  instagramFeed: 15,
  perLargeImage: 5, // × largeImages, capped by maxLargeImages
  maxLargeImages: 6, // so large images contribute at most 30
  perTotalImage: 0.5, // × totalImages, capped at maxTotalImageBonus
  maxTotalImageBonus: 10,
};

// Band cutoffs on the 0–100 richness score:
//   >= RICH_MIN   → "rich":    professionally-photographed-looking; a reject
//                              CANDIDATE (still needs the Vision gate to confirm).
//   <= SPARSE_MAX → "sparse":  thin/dated site; a strong KEEP — skip the Vision
//                              call entirely (cost saver on our best targets).
//   in between    → "unclear": KEEP, but carry the score into fit ranking; never
//                              auto-rejected no matter what Vision says.
export const RICH_MIN = 60;
export const SPARSE_MAX = 25;

// Image CDNs / restaurant website platforms whose presence signals a
// photo-forward, professionally-built site. Matched as lowercase substrings of
// the raw HTML. Reservation widgets (OpenTable/Resy) are intentionally NOT here
// — they signal an established venue, not necessarily good photography, and we
// only want to reject on the photography question.
const PRO_PLATFORM_FINGERPRINTS = [
  "squarespace-cdn",
  "static1.squarespace",
  "wixstatic",
  "getbento",
  "bentobox",
  "popmenu",
  "cloudinary",
  "imgix",
  "imageengine",
];

// Live-Instagram-feed markers (an embedded feed = curated, current photography).
// A bare <a href="instagram.com"> in the footer is NOT enough — nearly every
// site has one — so we require an actual embed/feed widget.
const INSTAGRAM_FEED_MARKERS = [
  "instagram-media", // official embed blockquote
  "data-instgrm", // official embed script hook
  "instagram.com/embed",
  "instafeed",
  "snapwidget",
  "elfsight", // common IG-feed widget vendor
  "lightwidget",
];

// Dedicated photo-page link: an <a> whose href OR visible text points at a
// gallery/photos/portfolio page.
const GALLERY_LINK_RE =
  /<a\b[^>]*href\s*=\s*["'][^"']*(gallery|galeria|galería|\/photos|portfolio)[^"']*["'][^>]*>|<a\b[^>]*>\s*(gallery|galería|galeria|photos|photo gallery|our food|portfolio)\s*</i;

function has(html: string, needles: string[]): boolean {
  return needles.some((n) => html.includes(n));
}

// Counts high-resolution image indicators — the strongest structural tell of
// professional photography. Three independent sources, deduped by a simple sum
// then capped:
//   1. srcset width descriptors >= 1200w (responsive hero/gallery images)
//   2. explicit width/height attributes >= 1200
//   3. filename dimension hints (…-1600x1067…, …_2048.jpg, Squarespace format=2500w)
//   4. hero background-image declarations (almost always full-bleed)
function countLargeImages(html: string, lower: string): number {
  let n = 0;

  for (const m of html.matchAll(/(\d{3,4})w(?=[,\s"'\]])/g)) {
    if (Number(m[1]) >= 1200) n++;
  }
  for (const m of html.matchAll(/\b(?:width|height)\s*=\s*["']?(\d{3,4})/gi)) {
    if (Number(m[1]) >= 1200) n++;
  }
  for (const m of html.matchAll(/[-_/](\d{3,4})x(\d{3,4})[-_.]/g)) {
    if (Number(m[1]) >= 1200 || Number(m[2]) >= 1200) n++;
  }
  for (const m of html.matchAll(/format=(\d{3,4})w/gi)) {
    if (Number(m[1]) >= 1200) n++;
  }
  // Hero background images (count the declarations, not their size — a CSS
  // background hero is full-bleed by construction).
  n += (lower.match(/background-image\s*:\s*url\(/g) ?? []).length;

  return n;
}

// Analyzes one page's HTML into structural photo signals + a 0–100 richness
// score + a band. Pure: same HTML in → same analysis out.
export function analyzeWebsitePhotos(html: string): WebsitePhotoAnalysis {
  const lower = html.toLowerCase();

  const signals: WebsitePhotoSignals = {
    ogImage: /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["']/i.test(html),
    proPlatform: has(lower, PRO_PLATFORM_FINGERPRINTS),
    galleryPage: GALLERY_LINK_RE.test(html),
    instagramFeed: has(lower, INSTAGRAM_FEED_MARKERS),
    largeImages: countLargeImages(html, lower),
    totalImages: (lower.match(/<img\b/g) ?? []).length,
  };

  const w = RICHNESS_WEIGHTS;
  let richness = 0;
  if (signals.ogImage) richness += w.ogImage;
  if (signals.proPlatform) richness += w.proPlatform;
  if (signals.galleryPage) richness += w.galleryPage;
  if (signals.instagramFeed) richness += w.instagramFeed;
  richness += Math.min(signals.largeImages, w.maxLargeImages) * w.perLargeImage;
  richness += Math.min(signals.totalImages * w.perTotalImage, w.maxTotalImageBonus);
  richness = Math.round(Math.min(richness, 100));

  const band: PhotoRichnessBand = richness >= RICH_MIN ? "rich" : richness <= SPARSE_MAX ? "sparse" : "unclear";

  return { richness, band, signals };
}

// Picks the single image Gate 2 should look at: the one the restaurant CHOSE to
// represent itself. Preference order: og:image / twitter:image (the social hero
// they curated), then the first large hero <img> (srcset or width >= 1200), then
// the first <img> at all. Returns an absolute URL (resolved against baseUrl) or
// null if the page has no usable image. This is the input to the Vision pro-score
// — scoring their proudest image, not a random Google Maps snapshot.
export function extractHeroImageUrl(html: string, baseUrl: string): string | null {
  const abs = (u: string): string | null => {
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return null;
    }
  };

  const og = html.match(
    /<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image(?::url)?|twitter:image)["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i
  );
  if (og?.[1]) return abs(og[1]);
  // Same meta tag with attributes in the other order (content before property).
  const ogAlt = html.match(
    /<meta[^>]+\bcontent\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:image(?::url)?|twitter:image)["']/i
  );
  if (ogAlt?.[1]) return abs(ogAlt[1]);

  // Largest hero <img>: prefer one with a big srcset descriptor, else any <img>.
  for (const m of html.matchAll(/<img\b[^>]*\bsrcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const entries = m[1].split(",").map((s) => s.trim());
    const big = entries.find((e) => {
      const w = e.match(/(\d{3,4})w$/);
      return w && Number(w[1]) >= 1200;
    });
    if (big) return abs(big.split(/\s+/)[0]);
  }
  const firstImg = html.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i);
  if (firstImg?.[1]) return abs(firstImg[1]);

  return null;
}

// URL fragments that mark an image as NOT a photo of the restaurant/food — logos,
// icons, tracking pixels, social badges, payment/reservation chrome. Scoring one
// of these tells us nothing about their photography (this is exactly why the
// first dry run mis-scored Hearth/Petite Boucherie: their og:image is a logo).
const NON_PHOTO_URL_HINTS = [
  "logo", "sprite", "icon", "favicon", "placeholder", "pixel", "1x1", "badge",
  "opentable", "resy", "yelp", "tripadvisor", "doordash", "ubereats", "grubhub",
  "apple-touch", "loader", "spinner", "avatar", ".svg",
];

function isLikelyPhoto(url: string): boolean {
  const u = url.toLowerCase();
  if (NON_PHOTO_URL_HINTS.some((h) => u.includes(h))) return false;
  return true;
}

type Candidate = { url: string; width: number };

// Extracts an ORDERED list of candidate image URLs to hand Gate 2 — largest
// first — so Vision grades the restaurant's actual food/interior photography, not
// whatever single image sits in og:image. og:image is INCLUDED but not
// privileged (it's frequently a logo). Obvious non-photos are filtered by URL.
// Returns absolute URLs, deduped, capped at `limit`.
export function extractImageCandidates(html: string, baseUrl: string, limit = 5): string[] {
  const abs = (u: string): string | null => {
    try {
      return new URL(u, baseUrl).toString();
    } catch {
      return null;
    }
  };
  // Keep the widest width seen per URL.
  const byUrl = new Map<string, number>();
  const add = (rawUrl: string | undefined, width: number) => {
    if (!rawUrl) return;
    const url = abs(rawUrl.trim());
    if (!url || !isLikelyPhoto(url)) return;
    byUrl.set(url, Math.max(byUrl.get(url) ?? 0, width));
  };

  // srcset — take the widest descriptor per set as that image's width.
  for (const m of html.matchAll(/<img\b[^>]*\bsrcset\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    let bestUrl: string | undefined;
    let bestW = 0;
    for (const entry of m[1].split(",")) {
      const parts = entry.trim().split(/\s+/);
      const w = Number((parts[1] ?? "").match(/(\d{3,4})w/)?.[1] ?? 0);
      if (w >= bestW) {
        bestW = w;
        bestUrl = parts[0];
      }
    }
    add(bestUrl, bestW || 800);
  }
  // <img src> with an optional width attribute or filename dimension hint.
  for (const m of html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const tag = m[0];
    const attrW = Number(tag.match(/\bwidth\s*=\s*["']?(\d{3,4})/i)?.[1] ?? 0);
    const fileW = Number(m[1].match(/[-_/](\d{3,4})x\d{3,4}[-_.]/)?.[1] ?? 0);
    add(m[1], Math.max(attrW, fileW, 400));
  }
  // Hero background images — full-bleed by construction; treat as large.
  for (const m of html.matchAll(/background-image\s*:\s*url\(\s*["']?([^"')]+)["']?\s*\)/gi)) {
    add(m[1], 1400);
  }
  // og:image / twitter:image — one candidate, mid priority (often a logo).
  const og =
    html.match(/<meta[^>]+(?:property|name)\s*=\s*["'](?:og:image(?::url)?|twitter:image)["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/i) ??
    html.match(/<meta[^>]+\bcontent\s*=\s*["']([^"']+)["'][^>]*(?:property|name)\s*=\s*["'](?:og:image(?::url)?|twitter:image)["']/i);
  add(og?.[1], 1000);

  return [...byUrl.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([url]) => url);
}

// Photo categories that actually depict the restaurant/food — the only ones
// worth grading for "do they already have professional photography?". `menu`
// (text) and `other` (logos/graphics) are excluded.
export const REAL_PHOTO_CATEGORIES = new Set(["food", "interior", "exterior"]);

export type ScoredImage = { score: number; category: string };

// Reduces several graded candidate images to the single pro-score the reject
// rule should use: the MAX score among REAL photos (their best foot forward). If
// none of the candidates was a real photo (all logos/menus/graphics), returns
// null — meaning "we couldn't actually see their photography", which must NOT be
// treated as a reject (that was the first dry run's logo bug).
export function bestRealPhotoScore(scored: ScoredImage[]): { proScore: number | null; basis: string } {
  const real = scored.filter((s) => REAL_PHOTO_CATEGORIES.has(s.category));
  if (real.length === 0) {
    return { proScore: null, basis: scored.length ? "no real photo among candidates (logos/menus only)" : "no candidates" };
  }
  const best = real.reduce((a, b) => (b.score > a.score ? b : a));
  return { proScore: best.score, basis: `${best.category} ${best.score}/6 (best of ${real.length} real photo${real.length > 1 ? "s" : ""})` };
}

// The professional-photo score at/above which Gate 2's Vision look counts as
// "already professional" (scorePhoto returns 2–6; 6 = already professional).
export const VISION_PRO_THRESHOLD = 5;

export type PhotoFitDecision =
  | { decision: "keep"; skipVision: true; reason: string } // sparse site — kept without paying for Vision
  | { decision: "needs_vision" } // rich/unclear and no Vision score yet — Gate 2 must run
  | { decision: "reject"; reason: string } // BOTH gates agree: already professionally photographed
  | { decision: "keep"; skipVision: false; reason: string }; // Gate 2 ran but didn't confirm a reject

// The combined auto-reject rule. This is the whole decision in one place:
//
//   • sparse                          → KEEP, and don't even call Vision (Gate 2
//                                       skipped — the cost saver on good targets).
//   • rich/unclear, Vision not run    → NEEDS_VISION (caller runs Gate 2, then
//                                       calls this again with the score).
//   • rich AND Vision >= threshold    → REJECT ("already has professional
//                                       photography"). The ONLY path to a reject.
//   • anything else                   → KEEP (unclear never rejects; a rich site
//                                       whose best image Vision rated mediocre is
//                                       a false positive we deliberately spare).
//
// visionProScore is the 2–6 "is this already professional?" score from Gate 2,
// or undefined if Gate 2 hasn't run yet.
export function decidePhotoFit(
  band: PhotoRichnessBand,
  visionProScore?: number
): PhotoFitDecision {
  if (band === "sparse") {
    return { decision: "keep", skipVision: true, reason: "sparse site — likely needs photos; Vision skipped" };
  }
  if (visionProScore === undefined) {
    return { decision: "needs_vision" };
  }
  if (band === "rich" && visionProScore >= VISION_PRO_THRESHOLD) {
    return {
      decision: "reject",
      reason: `Already has professional photography (rich website + Vision pro-score ${visionProScore}/6)`,
    };
  }
  return {
    decision: "keep",
    skipVision: false,
    reason: `Kept: band=${band}, Vision pro-score=${visionProScore}/6 (< ${VISION_PRO_THRESHOLD} or not rich)`,
  };
}
