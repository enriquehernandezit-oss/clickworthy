// End-to-end tests for the wired photo-fit decision (worker/lib/photoFit.ts),
// with the image fetch + Vision scoring INJECTED so the whole auto-reject path
// runs with zero network/API. This is the money decision — a wrong reject drops
// a paying lead, a wrong keep wastes spend — so every branch is pinned here.
// Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { assessPhotoFit, type PhotoFitDeps, type ScoredImageResult } from "./photoFit";

// A rich site (og:image + pro CMS + gallery + big images) — Gate 1 defers to Gate 2.
const RICH_HTML = `<!doctype html><html><head>
  <meta property="og:image" content="https://images.squarespace-cdn.com/hero-2500.jpg">
</head><body>
  <a href="/gallery">Gallery</a>
  <img srcset="plate-1600w.jpg 1600w, plate-2400w.jpg 2400w" alt="dish">
  <img srcset="room-1600w.jpg 1600w" alt="room">
</body></html>`;

// An unclear site — Gate 1 can't decide, but the rule must NEVER reject unclear.
const UNCLEAR_HTML = `<!doctype html><html><head>
  <meta property="og:image" content="https://bistro.example/social.jpg">
</head><body>
  <img src="front-1300x900.jpg" width="1300" height="900" alt="patio">
  <img src="dish.jpg" width="900" height="600" alt="dish">
</body></html>`;

// A sparse site — Gate 1 keeps it and Gate 2 must not run at all.
const SPARSE_HTML = `<html><body><img src="logo.gif" width="180" height="60"></body></html>`;

// Builds deps whose scoreImage returns a scripted queue of results (one per
// image scored), and counts how many times fetch/score were called.
function deps(queue: ScoredImageResult[]): PhotoFitDeps & { calls: () => number } {
  let i = 0;
  let calls = 0;
  return {
    fetchImage: async () => ({ bytes: Buffer.from("x"), contentType: "image/jpeg" }),
    scoreImage: async () => {
      calls++;
      return queue[Math.min(i++, queue.length - 1)];
    },
    calls: () => calls,
  };
}

describe("assessPhotoFit — the auto-reject decision", () => {
  test("sparse site: keep, and Gate 2 (Vision) never runs", async () => {
    const d = deps([{ score: 6, category: "food", dish: "x" }]);
    const v = await assessPhotoFit(SPARSE_HTML, "https://x.example/", d);
    expect(v.decision).toBe("keep");
    expect(v.band).toBe("sparse");
    expect(d.calls()).toBe(0); // no Vision spend on our best targets
  });

  test("rich + best real photo is professional (>=5): REJECT", async () => {
    const v = await assessPhotoFit(RICH_HTML, "https://x.example/", deps([{ score: 6, category: "food", dish: "birria tacos" }]));
    expect(v.decision).toBe("reject");
    expect(v.proScore).toBe(6);
    expect(v.reason.toLowerCase()).toContain("professional");
  });

  test("rich but best real photo is mediocre (<5): KEEP (false positive spared)", async () => {
    const v = await assessPhotoFit(RICH_HTML, "https://x.example/", deps([{ score: 4, category: "food", dish: "tacos" }]));
    expect(v.decision).toBe("keep");
    expect(v.proScore).toBe(4);
  });

  // 2026-08-25: decidePhotoFit's reject rule requires band === "rich", so
  // unclear can NEVER be rejected regardless of Vision's opinion — Vision is
  // now skipped for it entirely rather than paid for and ignored (measured:
  // 41 needs_manual_email leads had band=unclear, every one Vision-scored,
  // zero decisions it could have changed).
  test("unclear NEVER rejects, and Vision never runs for it", async () => {
    const d = deps([{ score: 6, category: "food", dish: "x" }]);
    const v = await assessPhotoFit(UNCLEAR_HTML, "https://x.example/", d);
    expect(v.band).toBe("unclear");
    expect(v.decision).toBe("keep");
    expect(v.screened).toBe(true); // Gate 1 DID run — this isn't a fetch failure
    expect(v.proScore).toBeNull();
    expect(v.dish).toBeNull();
    expect(v.imagesScored).toBe(0);
    expect(d.calls()).toBe(0); // no Vision spend — the whole point of the skip
  });

  test("rich but only logos/menus scored (no real photo): KEEP, proScore null", async () => {
    const v = await assessPhotoFit(RICH_HTML, "https://x.example/", deps([
      { score: 2, category: "other", dish: null },
      { score: 3, category: "menu", dish: null },
    ]));
    expect(v.decision).toBe("keep");
    expect(v.proScore).toBeNull();
  });

  test("captures a signature dish from a website food photo (free byproduct)", async () => {
    // First image is a mediocre food photo -> kept, but its dish is captured for
    // the cold email so enrichment can skip scoring Google photos.
    const v = await assessPhotoFit(RICH_HTML, "https://x.example/", deps([{ score: 4, category: "food", dish: "ropa vieja" }]));
    expect(v.decision).toBe("keep");
    expect(v.dish).toBe("ropa vieja");
  });

  test("early-stops Vision once a real photo confirms professional", async () => {
    // First candidate is a 6/6 food photo -> should stop, not score all 3+.
    const d = deps([
      { score: 6, category: "food", dish: "x" },
      { score: 6, category: "interior", dish: null },
      { score: 6, category: "exterior", dish: null },
    ]);
    const v = await assessPhotoFit(RICH_HTML, "https://x.example/", d);
    expect(v.decision).toBe("reject");
    expect(d.calls()).toBe(1); // stopped after the first confirmed-pro photo
  });
});

// ---------------------------------------------------------------------------
// Regression: a FAILED homepage fetch used to be analyzed as "" — every signal
// false, richness 0, band `sparse` — i.e. the single most confident KEEP this
// module produces, with Gate 2 skipped entirely. Caught 2026-08-24 on Kitchen
// Mouse (stored sparse/richness 0; the live page actually scores 55/unclear).
// 24 leads with real websites had never been screened, two already emailed.
// ---------------------------------------------------------------------------

describe("assessPhotoFit — an unfetched page is never mistaken for a thin one", () => {
  test("null HTML with a website is reported as NOT screened, not as sparse", async () => {
    const d = deps([]);
    const v = await assessPhotoFit(null, "https://kitchenmousela.com/", d);
    expect(v.screened).toBe(false);
    expect(v.band).not.toBe("sparse"); // the bug: 'sparse' claimed a read we never made
    expect(v.decision).toBe("keep"); // still fail-open — we just don't lie about why
    expect(v.reason).toContain("fetch failed");
    expect(d.calls()).toBe(0); // nothing to score, so nothing paid for
  });

  test("no website at all is also flagged unscreened, with its own reason", async () => {
    const v = await assessPhotoFit(null, null, deps([]));
    expect(v.screened).toBe(false);
    expect(v.decision).toBe("keep");
    expect(v.reason).toContain("no website");
  });

  test("a genuinely thin page IS screened and still bands sparse", async () => {
    // One tiny image, no og:image, no gallery, no platform -> really is sparse.
    const thin = `<html><body><img src="/a.jpg" width="120"></body></html>`;
    const v = await assessPhotoFit(thin, "https://x.example/", deps([]));
    expect(v.screened).toBe(true);
    expect(v.band).toBe("sparse");
    expect(v.decision).toBe("keep");
  });

  test("every screened path reports screened=true", async () => {
    const rich = await assessPhotoFit(RICH_HTML, "https://x.example/", deps([{ score: 6, category: "food", dish: null }]));
    expect(rich.screened).toBe(true);
    const kept = await assessPhotoFit(RICH_HTML, "https://x.example/", deps([{ score: 3, category: "food", dish: null }]));
    expect(kept.screened).toBe(true);
  });
});
