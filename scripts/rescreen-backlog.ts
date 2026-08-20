// Re-screen the PRE-GATE backlog. Restaurants sourced before the photo-fit gate,
// the 20-800 review ceiling, and the franchise denylist existed were never
// checked by any of that logic — so the approvals queue is full of famous,
// already-professionally-photographed places (Eataly, STK, Republique) that
// should never be emailed. This re-runs today's screening over every such row
// and rejects the ones that no longer qualify, cancelling their pending drafts.
//
//   bun run scripts/rescreen-backlog.ts            # DRY RUN — lists every verdict, no writes
//   bun run scripts/rescreen-backlog.ts --commit   # apply: reject + cancel drafts + store signals
//
// Targets enrichmentStatus queued/needs_manual_email with NO website_photo_band
// (i.e. never gate-screened). Cheapest-first: hard filters (free, stored columns)
// kill most; only survivors trigger a homepage fetch + photo-fit Vision.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { passesHardFilters } from "@/worker/lib/filters";
import { assessPhotoFit } from "@/worker/lib/photoFit";
import { fetchHomepageHtml } from "@/worker/lib/emailDiscovery";
import type { Place } from "@/worker/lib/places";

// Railway Postgres closes idle connections; postgres-js surfaces that as an async
// error/rejection that would otherwise crash the process mid-run. Swallow those
// so the (resumable) loop keeps going — the band-IS-NULL query means a re-run
// resumes exactly where a dropped write left off.
process.on("unhandledRejection", (e) => console.error("  [ignored] unhandledRejection:", e instanceof Error ? e.message : e));
process.on("uncaughtException", (e) => console.error("  [ignored] uncaughtException:", e instanceof Error ? e.message : e));

const commit = process.argv.includes("--commit");
const CONCURRENCY = 4;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Reverse of priceLevelToInt — the stored int back to the Places enum string the
// hard filter reads.
function intToPriceEnum(n: number | null): string | undefined {
  switch (n) {
    case 1: return "PRICE_LEVEL_INEXPENSIVE";
    case 2: return "PRICE_LEVEL_MODERATE";
    case 3: return "PRICE_LEVEL_EXPENSIVE";
    case 4: return "PRICE_LEVEL_VERY_EXPENSIVE";
    default: return undefined;
  }
}

type Row = typeof restaurants.$inferSelect;

// Reconstruct the minimal Place the hard filter needs from a stored row.
function toPlace(r: Row): Place {
  return {
    id: r.googlePlaceId ?? "",
    displayName: { text: r.name },
    rating: r.rating ?? undefined,
    userRatingCount: r.reviewCount ?? undefined,
    priceLevel: intToPriceEnum(r.priceLevel),
    businessStatus: r.temporarilyClosed ? "CLOSED_TEMPORARILY" : "OPERATIONAL",
    websiteUri: r.website ?? undefined,
  };
}

async function mapPool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
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
  .select()
  .from(restaurants)
  .where(
    and(
      inArray(restaurants.enrichmentStatus, ["queued", "needs_manual_email"]),
      isNull(restaurants.websitePhotoBand) // never gate-screened
    )
  );

console.log(`Re-screening ${rows.length} pre-gate leads${commit ? " (COMMIT — writing)" : " (dry run)"}.\n`);

type Verdict = {
  r: Row;
  action: "keep" | "reject_filter" | "reject_photo";
  reason: string;
  band?: string; richness?: number; proScore?: number | null;
};

const verdicts: Verdict[] = await mapPool(rows, CONCURRENCY, async (r) => {
  // 1. Hard filters (chain + 20-800 reviews + price + operational) — free.
  const hard = passesHardFilters(toPlace(r));
  if (!hard.pass) return { r, action: "reject_filter", reason: hard.reason };

  // 2. Photo-fit gate — only for filter survivors. One fetch; Vision only if
  //    the site isn't sparse.
  const html = r.website ? await fetchHomepageHtml(r.website) : null;
  const fit = await assessPhotoFit(html, r.website);
  await sleep(80);
  if (fit.decision === "reject") {
    return { r, action: "reject_photo", reason: fit.reason, band: fit.band, richness: fit.richness, proScore: fit.proScore };
  }
  return { r, action: "keep", reason: "survives re-screen", band: fit.band, richness: fit.richness, proScore: fit.proScore };
});

const keep = verdicts.filter((v) => v.action === "keep");
const rejFilter = verdicts.filter((v) => v.action === "reject_filter");
const rejPhoto = verdicts.filter((v) => v.action === "reject_photo");
const rejected = [...rejFilter, ...rejPhoto];

// How many pending drafts would be cancelled (rejected restaurants only).
const rejectedIds = rejected.map((v) => v.r.id);
const [{ n: draftsToCancel }] = rejectedIds.length
  ? await db
      .select({ n: sql<number>`count(*)::int` })
      .from(outreachJobs)
      .where(and(eq(outreachJobs.kind, "touch1"), isNull(outreachJobs.sentAt), inArray(outreachJobs.restaurantId, rejectedIds), sql`${outreachJobs.status} <> 'cancelled'`))
  : [{ n: 0 }];

console.log("=== REJECTS (filters) ===");
for (const v of rejFilter.sort((a, b) => (b.r.reviewCount ?? 0) - (a.r.reviewCount ?? 0)))
  console.log(`  ✗ ${String(v.r.reviewCount ?? "?").padStart(6)}rev  ${(v.r.name ?? "?").slice(0, 32).padEnd(32)} — ${v.reason}`);
console.log("\n=== REJECTS (already-pro photos) ===");
for (const v of rejPhoto) console.log(`  ✗ ${String(v.r.reviewCount ?? "?").padStart(6)}rev  ${(v.r.name ?? "?").slice(0, 32).padEnd(32)} — ${v.reason}`);
console.log("\n=== SURVIVORS ===");
for (const v of keep) console.log(`  ✓ ${String(v.r.reviewCount ?? "?").padStart(6)}rev  ${(v.r.name ?? "?").slice(0, 32).padEnd(32)} [${v.band}${v.proScore != null ? ` pro=${v.proScore}` : ""}] (${v.r.enrichmentStatus})`);

console.log(
  `\nSummary: ${rows.length} screened -> ${keep.length} survive, ${rejFilter.length} filter-rejected, ` +
    `${rejPhoto.length} photo-rejected. ${draftsToCancel} pending drafts would be cancelled.`
);

if (!commit) {
  console.log("\nDry run — nothing written. Re-run with --commit to apply.");
  process.exit(0);
}

// --- Apply (per-row try/catch: a dropped connection skips one row, and the
//     band-IS-NULL query makes a re-run resume exactly where this left off). ---
let cancelled = 0, applied = 0, failed = 0;
for (const v of rejected) {
  try {
    await db.update(restaurants).set({
      enrichmentStatus: "rejected",
      rejectionReason: `Re-screen: ${v.reason}`,
      ...(v.band ? { websitePhotoBand: v.band, websitePhotoRichness: v.richness ?? null, websiteProScore: v.proScore ?? null } : {}),
    }).where(eq(restaurants.id, v.r.id));
    const res = await db.update(outreachJobs).set({ status: "cancelled" })
      .where(and(eq(outreachJobs.kind, "touch1"), isNull(outreachJobs.sentAt), eq(outreachJobs.restaurantId, v.r.id), sql`${outreachJobs.status} <> 'cancelled'`))
      .returning({ id: outreachJobs.id });
    cancelled += res.length; applied++;
  } catch (e) { failed++; console.error(`  write failed for ${v.r.name}:`, e instanceof Error ? e.message : e); }
}
// Survivors: store the fit signals so they're indistinguishable from new-pipeline leads.
for (const v of keep) {
  try {
    await db.update(restaurants).set({
      websitePhotoBand: v.band ?? null, websitePhotoRichness: v.richness ?? null, websiteProScore: v.proScore ?? null,
    }).where(eq(restaurants.id, v.r.id));
    applied++;
  } catch (e) { failed++; console.error(`  tag failed for ${v.r.name}:`, e instanceof Error ? e.message : e); }
}

console.log(`\nApplied ${applied}/${rejected.length + keep.length}: ${cancelled} drafts cancelled.` + (failed ? ` ${failed} FAILED — re-run --commit to finish them.` : " Done."));
process.exit(failed ? 1 : 0);
