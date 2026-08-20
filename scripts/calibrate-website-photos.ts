// Calibration pass for the website-photo fit gate (worker/lib/websitePhotos.ts).
// Pulls real sourced restaurant websites, fetches each homepage, runs Gate 1
// (the free structural analyzer), and reports the richness/band distribution —
// then cross-tabs the band against signals of your REAL approve/reject taste:
//   - held = true          -> a lead you pulled out at approval (≈ a reject).
//                             If Gate 1 calls these "rich", that's a correct catch.
//   - status queued/contacted, not held -> a lead you kept. A "rich" here is a
//                             potential FALSE POSITIVE (we'd wrongly drop it).
//
// Read-only: never writes. No Anthropic / NeverBounce spend — Gate 1 is free;
// this only re-fetches homepages (the same fetch email discovery already does).
//
//   bun run scripts/calibrate-website-photos.ts        # up to 60 sites
//   bun run scripts/calibrate-website-photos.ts 120    # custom sample size

import { isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { analyzeWebsitePhotos, RICH_MIN, SPARSE_MAX, type PhotoRichnessBand } from "@/worker/lib/websitePhotos";

const FETCH_TIMEOUT_MS = 8000;
const CONCURRENCY = 8;

const arg = Number(process.argv[2]);
const sampleSize = Number.isFinite(arg) && arg > 0 ? Math.floor(arg) : 60;

async function fetchHomepage(url: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ClickworthyBot/1.0)" },
      redirect: "follow",
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("text/html") && !ct.includes("text/plain")) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// Minimal concurrency pool so we don't open 60 sockets at once.
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

type Row = {
  id: number;
  name: string;
  city: string | null;
  website: string | null;
  enrichmentStatus: string | null;
  held: boolean | null;
};

// The bucket we compare the band against — our best proxy for real taste.
function tasteBucket(r: Row): "rejected_by_you" | "kept" | "other" {
  if (r.held) return "rejected_by_you";
  if (r.enrichmentStatus === "queued" || r.enrichmentStatus === "contacted") return "kept";
  return "other"; // sourced/needs_manual_email/rejected-by-chain — no clean human verdict
}

const rows: Row[] = await db
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

console.log(`Sampled ${rows.length} restaurants with a website (bands: sparse<=${SPARSE_MAX} | unclear | rich>=${RICH_MIN})\n`);
if (rows.length === 0) {
  console.log("No restaurants with a website in the DB — nothing to calibrate against.");
  process.exit(0);
}

const analyzed = await mapPool(rows, CONCURRENCY, async (r) => {
  const html = r.website ? await fetchHomepage(r.website) : null;
  if (html === null) return { r, ok: false as const };
  return { r, ok: true as const, a: analyzeWebsitePhotos(html) };
});

const ok = analyzed.filter((x): x is Extract<typeof x, { ok: true }> => x.ok);
const failed = analyzed.length - ok.length;

// --- Band distribution ---
const bandCount: Record<PhotoRichnessBand, number> = { rich: 0, unclear: 0, sparse: 0 };
for (const x of ok) bandCount[x.a.band]++;
const pct = (n: number) => (ok.length ? ((n / ok.length) * 100).toFixed(0) : "0").padStart(3);

console.log("=== Band distribution (fetched OK) ===");
console.log(`  rich    ${String(bandCount.rich).padStart(3)}  (${pct(bandCount.rich)}%)  -> reject CANDIDATES (Vision must still confirm)`);
console.log(`  unclear ${String(bandCount.unclear).padStart(3)}  (${pct(bandCount.unclear)}%)  -> kept, ranked, defer to Vision`);
console.log(`  sparse  ${String(bandCount.sparse).padStart(3)}  (${pct(bandCount.sparse)}%)  -> kept free (no Vision spend)`);
console.log(`  (fetch failed / non-HTML: ${failed})\n`);

// --- Cross-tab: band vs your real taste (held / kept) ---
const cross: Record<string, Record<PhotoRichnessBand, number>> = {
  rejected_by_you: { rich: 0, unclear: 0, sparse: 0 },
  kept: { rich: 0, unclear: 0, sparse: 0 },
  other: { rich: 0, unclear: 0, sparse: 0 },
};
for (const x of ok) cross[tasteBucket(x.r)][x.a.band]++;

console.log("=== Band vs your taste (held = you rejected; kept = queued/contacted) ===");
console.log("  bucket            rich  unclear  sparse");
for (const b of ["rejected_by_you", "kept", "other"] as const) {
  const c = cross[b];
  console.log(`  ${b.padEnd(16)} ${String(c.rich).padStart(4)}  ${String(c.unclear).padStart(7)}  ${String(c.sparse).padStart(6)}`);
}
console.log(
  "\n  Read: 'rich' in the rejected_by_you row = correct auto-catches.\n" +
    "        'rich' in the kept row = would-be FALSE POSITIVES — the number to keep near zero."
);

// --- Per-site detail (sorted by richness desc) ---
console.log("\n=== Per-site (richness desc) ===");
const detail = ok
  .map((x) => ({ ...x.r, richness: x.a.richness, band: x.a.band, s: x.a.signals, bucket: tasteBucket(x.r) }))
  .sort((a, b) => b.richness - a.richness);
for (const d of detail) {
  const flags = [d.s.ogImage && "og", d.s.proPlatform && "cms", d.s.galleryPage && "gal", d.s.instagramFeed && "ig", `L${d.s.largeImages}`]
    .filter(Boolean)
    .join(",");
  const mark = d.bucket === "rejected_by_you" ? "REJd" : d.bucket === "kept" ? "kept" : "—";
  console.log(
    `  ${String(d.richness).padStart(3)} ${d.band.padEnd(7)} ${mark.padEnd(5)} ${(d.name ?? "?").slice(0, 34).padEnd(34)} ${(d.city ?? "").slice(0, 12).padEnd(12)} [${flags}]`
  );
}

process.exit(0);
