// The photo-fit decision, wired for the pipeline: runs Gate 1 (free structural
// read of the homepage HTML) and, only when needed, Gate 2 (one Vision look at
// the restaurant's own best photo), then applies the auto-reject rule. This is
// the impure orchestration layer over the pure analyzers in websitePhotos.ts —
// it does the image fetches and the Vision calls that the pure module can't.
//
// The whole point: reject restaurants that ALREADY have professional photography
// (they'd never buy the service) before enrichment spends on NeverBounce,
// signature-dish scoring, and a human's review time — but only when BOTH gates
// agree, so a genuine lead is never dropped on a single fuzzy signal.
//
// Dependencies are injectable so the decision logic is unit-tested end to end
// (sparse-skips-Vision, reject-needs-both-gates, logo-only-never-rejects) with
// zero network or API calls — this is the money decision, so it's worth testing.

import { scorePhoto } from "./anthropic";
import {
  analyzeWebsitePhotos,
  extractImageCandidates,
  bestRealPhotoScore,
  decidePhotoFit,
  REAL_PHOTO_CATEGORIES,
  VISION_PRO_THRESHOLD,
  type PhotoRichnessBand,
} from "./websitePhotos";

const IMG_TIMEOUT_MS = 8000;
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_CANDIDATES = 4; // Vision calls per site, worst case (early-stops on a confirmed-pro real photo)

export type PhotoFitVerdict = {
  decision: "keep" | "reject";
  band: PhotoRichnessBand;
  richness: number;
  proScore: number | null; // best real-photo Vision score (2–6), null if none judged / sparse
  dish: string | null; // a signature dish seen on the website (free byproduct of Gate 2)
  imagesScored: number; // how many Vision calls Gate 2 actually made
  // False when we never actually saw the page (no website, or the homepage
  // fetch failed) — the verdict is then "keep by default", NOT a real read of
  // their photography. Callers must not persist `band` as fact when this is
  // false; enrichment stores null instead so scripts/rescreen-backlog.ts picks
  // the lead up later (it targets rows with no band).
  screened: boolean;
  reason: string;
};

export type ScoredImageResult = { score: number; category: string; dish: string | null };

export type PhotoFitDeps = {
  fetchImage: (url: string) => Promise<{ bytes: Buffer; contentType: string } | null>;
  scoreImage: (bytes: Buffer, contentType: string) => Promise<ScoredImageResult>;
};

async function realFetchImage(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), IMG_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClickworthyBot/1.0)", Accept: "image/*" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.startsWith("image/")) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return null;
    return { bytes, contentType: ct };
  } catch {
    return null;
  }
}

const defaultDeps: PhotoFitDeps = {
  fetchImage: realFetchImage,
  scoreImage: (bytes, contentType) => scorePhoto(bytes, contentType),
};

// Runs the two-gate photo-fit assessment over a restaurant's homepage HTML.
// `homepageHtml` is passed in (enrichment already fetched it for email
// discovery); `websiteUrl` is needed to resolve relative image URLs.
export async function assessPhotoFit(
  homepageHtml: string | null,
  websiteUrl: string | null,
  deps: PhotoFitDeps = defaultDeps
): Promise<PhotoFitVerdict> {
  // NO HTML IS NOT A THIN SITE. Analyzing "" yields every signal false and
  // richness 0, which lands in the `sparse` band — i.e. "strong keep, skip
  // Vision", the most confident KEEP this module produces. So a failed homepage
  // fetch silently impersonated our best possible lead and skipped Gate 2
  // entirely. Caught 2026-08-24 on Kitchen Mouse (stored band=sparse,
  // richness=0, while the live page actually scores 55/unclear): 24 leads with
  // real websites were never screened at all, two of them already emailed.
  // Bail out FIRST, before the band is computed, and tell the caller we never
  // looked.
  if (!homepageHtml) {
    const noSite = !websiteUrl;
    return {
      decision: "keep",
      band: "unclear", // never auto-rejects; the honest value is "unknown"
      richness: 0,
      proScore: null,
      dish: null,
      imagesScored: 0,
      screened: false,
      reason: noSite ? "no website to screen" : "homepage fetch failed — photo fit NOT assessed",
    };
  }

  const { band, richness } = analyzeWebsitePhotos(homepageHtml);

  // Gate 1: a sparse/thin site is a strong KEEP — don't even pay for Vision.
  if (band === "sparse") {
    return {
      decision: "keep",
      band,
      richness,
      proScore: null,
      dish: null,
      imagesScored: 0,
      screened: true,
      reason: "sparse website — likely needs photos (Vision skipped)",
    };
  }

  // Gate 2: grade the best real photos the restaurant chose to show, stopping as
  // soon as one confirms professional-grade. Capture a signature dish along the
  // way — enrichment reuses it instead of paying to score Google photos again.
  const candidates = websiteUrl && homepageHtml ? extractImageCandidates(homepageHtml, websiteUrl, MAX_CANDIDATES) : [];
  const graded: { score: number; category: string }[] = [];
  let dish: string | null = null;

  for (const url of candidates) {
    const img = await deps.fetchImage(url);
    if (!img) continue;
    let s: ScoredImageResult;
    try {
      s = await deps.scoreImage(img.bytes, img.contentType);
    } catch {
      continue; // unprocessable image (SVG/corrupt) — try the next candidate
    }
    graded.push({ score: s.score, category: s.category });
    if (!dish && s.dish && s.category === "food") dish = s.dish;
    if (REAL_PHOTO_CATEGORIES.has(s.category) && s.score >= VISION_PRO_THRESHOLD) break;
  }

  const { proScore, basis } = bestRealPhotoScore(graded);

  // No real photo to judge (logos/menus only) → can't confirm "already pro", so
  // KEEP. This is the guard that stopped the first dry run rejecting Hearth on a
  // logo.
  if (proScore === null) {
    return { decision: "keep", band, richness, proScore: null, dish, imagesScored: graded.length, screened: true, reason: `kept — ${basis}` };
  }

  const fit = decidePhotoFit(band, proScore);
  return {
    decision: fit.decision === "reject" ? "reject" : "keep",
    band,
    richness,
    proScore,
    dish,
    imagesScored: graded.length,
    screened: true,
    reason: "reason" in fit ? fit.reason : "",
  };
}
