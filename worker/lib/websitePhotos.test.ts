// Tests for the Gate-1 website-photo analyzer and the combined auto-reject rule
// (worker/lib/websitePhotos.ts). Run with `bun test`.
//
// The fixtures below are trimmed but structurally faithful stand-ins for the
// kinds of restaurant homepages the sourcing pipeline actually downloads:
//   • a high-end, professionally-photographed Squarespace site (SHOULD reject)
//   • a photo-forward BentoBox site with a live IG feed (SHOULD reject)
//   • a bare, dated site with a couple of tiny images (must NEVER reject)
//   • a middling site that's ambiguous from structure alone (defer to Vision)
// The point of the suite is to prove the auto-reject is HIGH-CONFIDENCE: a lead
// is only dropped when the free structural gate AND an independent Vision score
// both say "already professional."

import { expect, test, describe } from "bun:test";
import {
  analyzeWebsitePhotos,
  decidePhotoFit,
  extractHeroImageUrl,
  extractImageCandidates,
  bestRealPhotoScore,
} from "./websitePhotos";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// High-end steakhouse on Squarespace: og:image, gallery link, IG feed embed,
// several 1600w+ hero/gallery images. This is the exact "great pictures on their
// website" case the owner is frustrated about.
const PRO_STEAKHOUSE = `<!doctype html><html><head>
  <meta property="og:image" content="https://images.squarespace-cdn.com/hero-2500.jpg">
  <meta name="twitter:image" content="https://images.squarespace-cdn.com/hero-2500.jpg">
  <link rel="stylesheet" href="https://static1.squarespace.com/site.css">
</head><body>
  <header style="background-image: url('https://images.squarespace-cdn.com/format=2500w/hero.jpg')"></header>
  <nav><a href="/menu">Menu</a><a href="/gallery">Gallery</a><a href="/reservations">Book</a></nav>
  <section class="gallery">
    <img srcset="plate-800w.jpg 800w, plate-1600w.jpg 1600w, plate-2000w.jpg 2000w" alt="dry-aged ribeye">
    <img srcset="bar-1200w.jpg 1200w, bar-2400w.jpg 2400w" alt="the bar">
    <img src="https://images.squarespace-cdn.com/dining-1600x1067-room.jpg" width="1600" height="1067">
  </section>
  <blockquote class="instagram-media" data-instgrm-permalink="https://instagram.com/p/abc">…</blockquote>
  <script async src="//www.instagram.com/embed.js"></script>
  <footer><a href="mailto:info@example.com">info@example.com</a></footer>
</body></html>`;

// Photo-forward taquería on BentoBox with an Instagram feed widget and a photos
// page. Rich, but a different platform/marker set than the steakhouse.
const PRO_TAQUERIA = `<!doctype html><html><head>
  <meta property="og:image" content="https://images.getbento.com/og-hero.jpg">
</head><body>
  <div class="hero" style="background-image:url('https://images.getbento.com/hero-1920x1080.jpg')"></div>
  <a href="/photos">Photos</a>
  <img src="tacos_2048.jpg" width="2048" height="1365" alt="birria tacos">
  <img srcset="salsa-1600w.jpg 1600w" alt="salsa flight">
  <div class="instafeed" data-instgrm></div>
  <div id="snapwidget-instagram"></div>
</body></html>`;

// A real target: an old, thin site. One small logo, one small storefront photo,
// no og:image, no gallery, no IG feed, no pro platform. This restaurant plausibly
// needs us — it must survive.
const BARE_DINER = `<!doctype html><html><head><title>Joe's Diner</title></head><body>
  <img src="logo.gif" width="180" height="60" alt="Joe's Diner">
  <h1>Joe's Diner</h1>
  <p>Open 7am–3pm. Call (305) 555-0134.</p>
  <img src="storefront.jpg" width="420" height="280" alt="our place">
  <p>Email us: hello@joesdiner.example</p>
</body></html>`;

// Ambiguous middle: has an og:image and a few medium images, but no gallery
// page, no IG feed, no pro-platform CDN. Structure alone can't call it — this is
// exactly what Gate 2 (Vision) exists to resolve.
const UNCLEAR_BISTRO = `<!doctype html><html><head>
  <meta property="og:image" content="https://bistro.example/social.jpg">
</head><body>
  <img src="front-1300x900.jpg" width="1300" height="900" alt="patio">
  <img src="dish.jpg" width="900" height="600" alt="a dish">
  <img src="team.jpg" width="800" height="600" alt="the team">
  <p>Contact: info@bistro.example</p>
</body></html>`;

// ---------------------------------------------------------------------------
// Gate 1 — structural band classification
// ---------------------------------------------------------------------------

describe("analyzeWebsitePhotos — band classification", () => {
  test("professional Squarespace site → rich", () => {
    const a = analyzeWebsitePhotos(PRO_STEAKHOUSE);
    expect(a.band).toBe("rich");
    expect(a.signals.ogImage).toBe(true);
    expect(a.signals.proPlatform).toBe(true);
    expect(a.signals.galleryPage).toBe(true);
    expect(a.signals.instagramFeed).toBe(true);
    expect(a.signals.largeImages).toBeGreaterThanOrEqual(4);
    expect(a.richness).toBeGreaterThanOrEqual(60);
  });

  test("photo-forward BentoBox site → rich", () => {
    const a = analyzeWebsitePhotos(PRO_TAQUERIA);
    expect(a.band).toBe("rich");
    expect(a.signals.proPlatform).toBe(true);
    expect(a.signals.instagramFeed).toBe(true);
  });

  // Regression: Kitchen Mouse (Owner.com) scored 55/unclear because its platform
  // wasn't recognized, so Gate 2 never confirmed what Enrique spotted by eye —
  // a professional site with good photos. Added 2026-08-24 with SpotHopper,
  // Webflow and Duda after scanning 148 real lead homepages.
  test("site builders added from the 2026-08-24 scan are recognized", () => {
    const cases: [string, string][] = [
      ["Owner.com", `<img srcset="/pluto-images/funnel/images/abc?w=1920 1920w">`],
      ["Owner.com CDN", `<img src="https://static-content.owner.com/funnel/images/x">`],
      ["SpotHopper", `<script src="https://cdn.spotapps.co/site.js"></script>`],
      ["Webflow", `<img src="https://assets.website-files.com/abc/hero.jpg">`],
      ["Duda", `<img src="https://irp.cdn-website.com/abc/hero.jpg">`],
    ];
    for (const [label, html] of cases) {
      expect(analyzeWebsitePhotos(html).signals.proPlatform, label).toBe(true);
    }
  });

  // These were measured as too COMMON to discriminate (WordPress 54/148, Toast
  // 48/148, generic CDNs 14/148). Treating them as "pro platform" would flip a
  // third of all sites to `rich` and pay for Vision on each. Pinned so the
  // exclusion is deliberate rather than an oversight someone later "fixes".
  test("common CMS / ordering widgets / generic CDNs are NOT pro-platform signals", () => {
    const cases: [string, string][] = [
      ["wordpress", `<link href="/wp-content/uploads/2024/x.css">`],
      ["elementor", `<div class="elementor-widget"></div>`],
      ["toast ordering", `<a href="https://www.toasttab.com/local/order/x">Order</a>`],
      ["cloudfront", `<img src="https://d1abc.cloudfront.net/x.jpg">`],
      ["godaddy", `<img src="https://img1.wsimg.com/isteam/x.jpg">`],
    ];
    for (const [label, html] of cases) {
      expect(analyzeWebsitePhotos(html).signals.proPlatform, label).toBe(false);
    }
  });

  test("bare dated diner → sparse", () => {
    const a = analyzeWebsitePhotos(BARE_DINER);
    expect(a.band).toBe("sparse");
    expect(a.signals.ogImage).toBe(false);
    expect(a.signals.galleryPage).toBe(false);
    expect(a.signals.instagramFeed).toBe(false);
    expect(a.signals.largeImages).toBe(0);
  });

  test("middling bistro → unclear (structure can't decide)", () => {
    const a = analyzeWebsitePhotos(UNCLEAR_BISTRO);
    expect(a.band).toBe("unclear");
  });

  test("empty / junk HTML → sparse, never throws", () => {
    expect(analyzeWebsitePhotos("").band).toBe("sparse");
    expect(analyzeWebsitePhotos("<html></html>").band).toBe("sparse");
    expect(analyzeWebsitePhotos("not even html").band).toBe("sparse");
  });

  test("a bare footer Instagram LINK is not counted as a feed", () => {
    const html = `<html><body><a href="https://instagram.com/joes">Follow us</a></body></html>`;
    expect(analyzeWebsitePhotos(html).signals.instagramFeed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Gate 2 input — pick the image the restaurant chose to represent itself
// ---------------------------------------------------------------------------

describe("extractHeroImageUrl", () => {
  test("prefers og:image, resolved to an absolute URL", () => {
    const url = extractHeroImageUrl(PRO_TAQUERIA, "https://taqueria.example/");
    expect(url).toBe("https://images.getbento.com/og-hero.jpg");
  });

  test("resolves a relative og:image against the site base", () => {
    const html = `<meta property="og:image" content="/img/hero.jpg">`;
    expect(extractHeroImageUrl(html, "https://joes.example/home")).toBe("https://joes.example/img/hero.jpg");
  });

  test("falls back to a large srcset image when there is no og:image", () => {
    const html = `<body><img srcset="small.jpg 400w, big.jpg 1600w" alt="x"></body>`;
    expect(extractHeroImageUrl(html, "https://x.example/")).toBe("https://x.example/big.jpg");
  });

  test("falls back to the first <img> when nothing larger exists", () => {
    const html = `<body><img src="logo.png"></body>`;
    expect(extractHeroImageUrl(html, "https://x.example/")).toBe("https://x.example/logo.png");
  });

  test("returns null for an image-less page", () => {
    expect(extractHeroImageUrl("<p>no images here</p>", "https://x.example/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Gate 2 input v2 — score BEST-OF several real photos, not a single logo
// ---------------------------------------------------------------------------

describe("extractImageCandidates", () => {
  test("returns multiple candidates, largest first, og:image not privileged", () => {
    const c = extractImageCandidates(PRO_STEAKHOUSE, "https://steak.example/");
    expect(c.length).toBeGreaterThanOrEqual(3);
    // Ordered widest-first: the 2400w bar image leads; the og:image hero (weighted
    // 1000, and often a logo) must NOT be first.
    expect(c[0]).toContain("bar-2400w.jpg");
    expect(c[0]).not.toContain("hero-2500.jpg");
    expect(c.some((u) => u.includes("plate-2000w.jpg"))).toBe(true);
  });

  test("filters out logos, icons, svg, and reservation-widget chrome", () => {
    const html = `<body>
      <img src="/assets/logo.svg" width="200">
      <img src="/opentable-badge.png" width="300">
      <img src="/img/ribeye-1600x1067.jpg" width="1600">
      <img src="/favicon-icon.png">
    </body>`;
    const c = extractImageCandidates(html, "https://x.example/");
    expect(c.some((u) => u.includes("ribeye"))).toBe(true);
    expect(c.some((u) => u.includes("logo"))).toBe(false);
    expect(c.some((u) => u.includes("opentable"))).toBe(false);
    expect(c.some((u) => u.includes("favicon"))).toBe(false);
  });

  test("dedupes repeated URLs and caps at the limit", () => {
    const html = Array.from({ length: 10 }, (_, i) => `<img src="/p${i}.jpg" width="1300">`).join("") + `<img src="/p0.jpg" width="1300">`;
    const c = extractImageCandidates(html, "https://x.example/", 5);
    expect(c.length).toBe(5);
    expect(new Set(c).size).toBe(5); // no duplicates
  });
});

describe("bestRealPhotoScore", () => {
  test("takes the MAX score among real photos, ignoring logos/menus", () => {
    const r = bestRealPhotoScore([
      { score: 2, category: "other" }, // a logo — must be ignored
      { score: 4, category: "food" },
      { score: 6, category: "interior" },
      { score: 5, category: "menu" }, // menu text — ignored
    ]);
    expect(r.proScore).toBe(6);
  });

  test("returns null when every candidate was a logo/menu (can't judge → never reject)", () => {
    const r = bestRealPhotoScore([
      { score: 2, category: "other" },
      { score: 3, category: "menu" },
    ]);
    expect(r.proScore).toBeNull();
  });

  test("null pro-score does not reject: rich + unjudged → needs_vision/keep, never reject", () => {
    const { proScore } = bestRealPhotoScore([{ score: 2, category: "other" }]);
    // decidePhotoFit is only called with a real number; a null means we DON'T
    // have a pro verdict, so the caller keeps the lead. Assert the contract:
    expect(proScore).toBeNull();
    // And a real mediocre food photo (the fixed Hearth/Petite Boucherie case):
    expect(decidePhotoFit("rich", bestRealPhotoScore([{ score: 6, category: "food" }]).proScore!).decision).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// The combined auto-reject rule — BOTH gates must agree
// ---------------------------------------------------------------------------

describe("decidePhotoFit — high-confidence auto-reject", () => {
  test("sparse site is kept WITHOUT paying for Vision", () => {
    const d = decidePhotoFit("sparse");
    expect(d.decision).toBe("keep");
    expect(d).toMatchObject({ skipVision: true });
  });

  test("rich site with no Vision score yet → needs_vision (Gate 2 must run)", () => {
    expect(decidePhotoFit("rich").decision).toBe("needs_vision");
    expect(decidePhotoFit("unclear").decision).toBe("needs_vision");
  });

  test("rich + Vision says professional (>=5) → REJECT", () => {
    expect(decidePhotoFit("rich", 6).decision).toBe("reject");
    expect(decidePhotoFit("rich", 5).decision).toBe("reject");
  });

  test("rich BUT Vision says mediocre (4) → KEEP (structural false positive spared)", () => {
    const d = decidePhotoFit("rich", 4);
    expect(d.decision).toBe("keep");
    expect(d).toMatchObject({ skipVision: false });
  });

  test("unclear NEVER auto-rejects, even if Vision scores it high", () => {
    expect(decidePhotoFit("unclear", 6).decision).toBe("keep");
  });

  test("end-to-end: pro steakhouse + pro Vision → reject; bare diner → keep, no Vision", () => {
    const steak = analyzeWebsitePhotos(PRO_STEAKHOUSE);
    // Gate 1 defers; Gate 2 (Vision on their own hero) confirms it's pro.
    expect(decidePhotoFit(steak.band).decision).toBe("needs_vision");
    expect(decidePhotoFit(steak.band, 6).decision).toBe("reject");

    const diner = analyzeWebsitePhotos(BARE_DINER);
    const dinerDecision = decidePhotoFit(diner.band);
    expect(dinerDecision.decision).toBe("keep");
    expect(dinerDecision).toMatchObject({ skipVision: true });
  });
});
