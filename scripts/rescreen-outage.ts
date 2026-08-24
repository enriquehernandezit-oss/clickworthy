// Re-screen leads that were enriched while the Anthropic API was DOWN.
//
// Both paid gates fail OPEN by design (a transient blip must not strand a lead
// at `sourced` — see the comments in worker/jobs/enrichRestaurant.ts), which
// means an outage silently turns the pipeline into a pass-through: Gate 2
// Vision can't reject, and the chain check can't reject. Caught live on
// 2026-08-24 — an out-of-credits window queued 18 leads including sweetgreen,
// Lou Malnati's, and Big Bad Breakfast, plus 8 `rich`-band sites that Gate 2
// exists specifically to reject.
//
// Scope is EVERY live lead in the window, not just ones missing a Vision score.
// A null score detects the failed Gate-2 call, but the chain check fails open
// independently and leaves no such trace — the first version of this script
// filtered to rich/unclear bands and so skipped Lou Malnati's, a `sparse`-band
// national chain sitting in `queued`. Sparse leads still get the chain check
// here; assessPhotoFit skips Vision for them on its own, so that stays free.
//
// NOT idempotent for sparse leads (they have no proScore to mark them as
// re-screened), so pass a tight window rather than re-running broadly.
//
//   bun run scripts/rescreen-outage.ts             # DRY RUN — verdicts only, no writes
//   bun run scripts/rescreen-outage.ts --commit    # apply rejections + cancel drafts
//   bun run scripts/rescreen-outage.ts 6           # look back 6h (default 24)
//
// Costs real money on --commit AND on a dry run: it re-runs Gate 2 Vision and
// the chain check per lead. That's the point — it buys back exactly the checks
// the outage skipped.

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { assessPhotoFit } from "@/worker/lib/photoFit";
import { checkHospitalityGroup } from "@/worker/lib/anthropic";
import { fetchHomepageHtml } from "@/worker/lib/emailDiscovery";
import { isKnownChain } from "@/worker/lib/chains";

const commit = process.argv.includes("--commit");
const hoursArg = Number(process.argv.find((a) => /^\d+$/.test(a)));
const hours = Number.isFinite(hoursArg) && hoursArg > 0 ? hoursArg : 24;

type Row = typeof restaurants.$inferSelect;

// Candidates: every still-live lead from the window. Deliberately NOT narrowed
// to leads missing a Vision score — see the header: that misses sparse-band
// leads, whose chain check failed just as silently but leaves no trace.
const rows: Row[] = await db
  .select()
  .from(restaurants)
  .where(
    and(
      inArray(restaurants.enrichmentStatus, ["queued", "needs_manual_email", "call_list"]),
      sql`${restaurants.createdAt} > now() - (${hours} * interval '1 hour')`
    )
  );

console.log(
  `Re-screening ${rows.length} live lead(s) enriched in the last ${hours}h — ` +
    `re-running the photo-fit gate and the chain check that failed open.` +
    (commit ? " (COMMIT — writing)\n" : " (dry run)\n")
);

if (rows.length === 0) {
  console.log("Nothing to re-screen.");
  process.exit(0);
}

type Verdict = {
  r: Row;
  action: "keep" | "reject_chain" | "reject_photo";
  reason: string;
  band?: string | null;
  richness?: number | null;
  proScore?: number | null;
};

const verdicts: Verdict[] = [];

// Sequential on purpose: each lead costs a Vision call plus up to 3 web
// searches, and this only ever runs over a single outage window (tens of rows,
// not thousands). Keeping it serial makes the spend legible in the log.
for (const r of rows) {
  const label = `${r.name}${r.city ? ` (${r.city})` : ""}`;

  // Free check first — the static denylist may have grown since this lead was
  // sourced (it did, the same day), so re-applying it costs nothing and can
  // save a paid call entirely.
  if (isKnownChain(r.name, r.website)) {
    verdicts.push({ r, action: "reject_chain", reason: `known chain (denylist): ${r.name}` });
    console.log(`  ✗ ${label} — known chain (free denylist, no API call)`);
    continue;
  }

  try {
    const html = r.website ? await fetchHomepageHtml(r.website) : null;
    const fit = await assessPhotoFit(html, r.website);

    if (fit.decision === "reject") {
      verdicts.push({ r, action: "reject_photo", reason: fit.reason, band: fit.band, richness: fit.richness, proScore: fit.proScore });
      console.log(`  ✗ ${label} — photo-fit: ${fit.reason}`);
      continue;
    }

    // Only leads that survive the photo gate are worth a paid chain check —
    // same ordering logic as enrichRestaurant: never pay for a check on a lead
    // something cheaper already disqualified.
    const group = await checkHospitalityGroup(r.name, r.city ?? "");
    if (group.isGroup) {
      verdicts.push({ r, action: "reject_chain", reason: `Chain / hospitality group: ${group.reasoning}`, band: fit.band, richness: fit.richness, proScore: fit.proScore });
      console.log(`  ✗ ${label} — group: ${group.reasoning.slice(0, 90)}`);
      continue;
    }

    verdicts.push({ r, action: "keep", reason: "passed both gates", band: fit.band, richness: fit.richness, proScore: fit.proScore });
    console.log(`  ✓ ${label} — keep (band ${fit.band}, pro ${fit.proScore ?? "n/a"})`);
  } catch (err) {
    // An error here means we STILL couldn't verify — leave the lead untouched
    // rather than guessing in either direction, and report it so it can be
    // re-run. Never silently keep something we failed to check.
    console.error(`  ! ${label} — re-screen FAILED, left untouched: ${err instanceof Error ? err.message : err}`);
  }
}

const rejected = verdicts.filter((v) => v.action !== "keep");
const keep = verdicts.filter((v) => v.action === "keep");

console.log(`\n--- ${verdicts.length} screened: ${keep.length} keep, ${rejected.length} reject ---`);
for (const v of rejected) console.log(`  reject: ${v.r.name} — ${v.reason.slice(0, 100)}`);

if (!commit) {
  console.log("\nDry run — nothing written. Re-run with --commit to apply.");
  process.exit(0);
}

let cancelled = 0, applied = 0, failed = 0;
for (const v of rejected) {
  try {
    await db
      .update(restaurants)
      .set({
        enrichmentStatus: "rejected",
        rejectionReason: `Outage re-screen: ${v.reason}`,
        isHospitalityGroup: v.action === "reject_chain",
        ...(v.band ? { websitePhotoBand: v.band, websitePhotoRichness: v.richness ?? null, websiteProScore: v.proScore ?? null } : {}),
      })
      .where(eq(restaurants.id, v.r.id));
    // Cancel any draft this lead already produced, so a rejected restaurant
    // can't still be sitting in Approvals waiting to be sent.
    const res = await db
      .update(outreachJobs)
      .set({ status: "cancelled" })
      .where(
        and(
          isNull(outreachJobs.sentAt),
          eq(outreachJobs.restaurantId, v.r.id),
          sql`${outreachJobs.status} not in ('cancelled','sent')`
        )
      )
      .returning({ id: outreachJobs.id });
    cancelled += res.length;
    applied++;
  } catch (e) {
    failed++;
    console.error(`  write failed for ${v.r.name}:`, e instanceof Error ? e.message : e);
  }
}

// Survivors: persist the fit signals so they're indistinguishable from leads
// enriched by a healthy pipeline (and so a re-run skips them next time).
for (const v of keep) {
  try {
    await db
      .update(restaurants)
      .set({ websitePhotoBand: v.band ?? null, websitePhotoRichness: v.richness ?? null, websiteProScore: v.proScore ?? null })
      .where(eq(restaurants.id, v.r.id));
    applied++;
  } catch (e) {
    failed++;
    console.error(`  tag failed for ${v.r.name}:`, e instanceof Error ? e.message : e);
  }
}

console.log(`\nApplied ${applied}/${verdicts.length}: ${cancelled} draft(s) cancelled.` + (failed ? ` ${failed} FAILED — re-run --commit.` : " Done."));
process.exit(failed ? 1 : 0);
