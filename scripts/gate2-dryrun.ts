// Gate-2 dry run for the website-photo fit gate. For every restaurant Gate 1
// bands as "rich" (worker/lib/websitePhotos.ts), fetch the ONE image the
// restaurant chose to represent itself (og:image / hero) and run the existing
// Claude Vision pro-score on it (scorePhoto: 2 = poor .. 6 = already pro). Then
// apply the real reject rule (decidePhotoFit) and report how many would actually
// be auto-rejected vs. spared — the true auto-reject rate on real images.
//
// Spends ONE Vision call per rich site (~17). No NeverBounce, no DB writes.
//
//   bun run scripts/gate2-dryrun.ts        # up to 60 sampled, rich ones scored
//   bun run scripts/gate2-dryrun.ts 120    # widen the sample

import { isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import {
  analyzeWebsitePhotos,
  extractImageCandidates,
  bestRealPhotoScore,
  decidePhotoFit,
  VISION_PRO_THRESHOLD,
  type ScoredImage,
} from "@/worker/lib/websitePhotos";
import { scorePhoto } from "@/worker/lib/anthropic";

const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 6;
const MAX_IMAGE_BYTES = 8_000_000;
const MAX_CANDIDATES = 4; // Vision calls per site, worst case (early-stops on a confirmed-pro real photo)

const arg = Number(process.argv[2]);
const sampleSize = Number.isFinite(arg) && arg > 0 ? Math.floor(arg) : 60;

async function fetchWithTimeout(url: string, accept: string): Promise<Response | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClickworthyBot/1.0)", Accept: accept },
      redirect: "follow",
    });
    clearTimeout(timer);
    return res;
  } catch {
    return null;
  }
}

async function fetchHomepage(url: string): Promise<string | null> {
  const res = await fetchWithTimeout(url, "text/html");
  if (!res || !res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.includes("text/html") && !ct.includes("text/plain")) return null;
  return await res.text();
}

async function fetchImage(url: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const res = await fetchWithTimeout(url, "image/*");
  if (!res || !res.ok) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (!ct.startsWith("image/")) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
  return { bytes: buf, contentType: ct };
}

async function mapPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    })
  );
  return out;
}

const rows = await db
  .select({
    id: restaurants.id,
    name: restaurants.name,
    city: restaurants.city,
    website: restaurants.website,
    enrichmentStatus: restaurants.enrichmentStatus,
    held: restaurants.held,
  })
  .from(restaurants)
  .where(isNotNull(restaurants.website))
  .orderBy(restaurants.id)
  .limit(sampleSize);

// Re-run Gate 1 to find the rich cohort (same as the calibration pass).
console.log(`Fetching ${rows.length} homepages to re-find the "rich" cohort...`);
const withHtml = await mapPool(rows, CONCURRENCY, async (r) => ({ r, html: r.website ? await fetchHomepage(r.website) : null }));
const rich = withHtml
  .filter((x) => x.html !== null)
  .map((x) => ({ ...x, band: analyzeWebsitePhotos(x.html!).band }))
  .filter((x) => x.band === "rich");

console.log(`Gate 1 flagged ${rich.length} rich sites. Running the Vision pro-score on each...\n`);

const scored = await mapPool(rich, CONCURRENCY, async ({ r, html }) => {
  const candidates = extractImageCandidates(html!, r.website!, MAX_CANDIDATES);
  const graded: ScoredImage[] = [];
  let scannedReal = false;
  for (const url of candidates) {
    const img = await fetchImage(url);
    if (!img) continue;
    try {
      const s = await scorePhoto(img.bytes, img.contentType);
      graded.push({ score: s.score, category: s.category });
      // Early stop: once a REAL photo scores at the pro threshold, we've already
      // confirmed "already professional" — no need to spend on more candidates.
      if (["food", "interior", "exterior"].includes(s.category)) {
        scannedReal = true;
        if (s.score >= VISION_PRO_THRESHOLD) break;
      }
    } catch {
      // skip an unprocessable image (SVG/corrupt) and try the next candidate
    }
  }
  const { proScore, basis } = bestRealPhotoScore(graded);
  return { r, candidates: candidates.length, graded: graded.length, proScore, basis, scannedReal };
});

let rejects = 0;
let sparedRealMediocre = 0;
let unjudged = 0;

console.log("=== Gate 2 results v2 (best real photo per site) ===");
console.log("  proScore  decision  basis                                   restaurant");
for (const x of scored.sort((a, b) => (b.proScore ?? -1) - (a.proScore ?? -1))) {
  const keptMark =
    x.r.held ? "  <-- you had held" : x.r.enrichmentStatus === "queued" || x.r.enrichmentStatus === "contacted" ? "  <-- you KEPT this" : "";
  if (x.proScore === null) {
    unjudged++;
    console.log(`     —      keep*     ${x.basis.slice(0, 38).padEnd(38)}  ${(x.r.name ?? "?").slice(0, 30)}${keptMark}`);
    continue;
  }
  const decision = decidePhotoFit("rich", x.proScore).decision;
  if (decision === "reject") rejects++;
  else sparedRealMediocre++;
  console.log(
    `     ${x.proScore}/6    ${decision === "reject" ? "REJECT" : "keep  "}    ${x.basis.slice(0, 38).padEnd(38)}  ${(x.r.name ?? "?").slice(0, 30)}${keptMark}`
  );
}

console.log(
  `\nOf ${rich.length} rich sites: ${rejects} auto-rejected (best real photo >= ${VISION_PRO_THRESHOLD}), ` +
    `${sparedRealMediocre} spared (real photos but best is mediocre), ${unjudged} unjudged (no real photo found — kept, marked *).`
);
console.log(
  `\nInterpretation:\n` +
    `  - REJECT = we'd stop paying to draft. Names should look genuinely well-photographed.\n` +
    `  - keep   = Gate 2 spared a structurally-rich site whose actual best photo isn't pro (the safety net).\n` +
    `  - keep*  = we could not find a real photo to grade (logos/menus only). Never auto-rejected on that.`
);

process.exit(0);
