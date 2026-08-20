// Feedback loop: compare the photo-fit gate's stored signals against your actual
// approve/skip decisions, and report whether the auto-reject threshold matches
// your taste. Read-only.
//
//   bun run scripts/calibrate-threshold.ts
//
// Requires the Phase-2 photo-fit columns (db:push after the schema change) and
// some reviewed leads — until you've approved/skipped a batch in /admin it will
// (correctly) say there isn't enough labeled data yet.

import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { calibrationReport, type CalibrationLead, type Decision } from "@/worker/lib/calibration";

// Enriched leads that carry photo-fit signals (Phase 2 onward).
const rows = await db
  .select({
    id: restaurants.id,
    band: restaurants.websitePhotoBand,
    proScore: restaurants.websiteProScore,
    status: restaurants.enrichmentStatus,
    held: restaurants.held,
    rejectionReason: restaurants.rejectionReason,
  })
  .from(restaurants)
  .where(isNotNull(restaurants.websitePhotoBand));

// Restaurants with an approved-or-sent Touch 1 = leads you WANTED (the positive
// label). Skips delete the draft and set held=true (the negative label).
const approvedRows = rows.length
  ? await db
      .selectDistinct({ rid: outreachJobs.restaurantId })
      .from(outreachJobs)
      .where(
        and(
          eq(outreachJobs.kind, "touch1"),
          sql`${outreachJobs.status} in ('approved','sent')`,
          inArray(
            outreachJobs.restaurantId,
            rows.map((r) => r.id)
          )
        )
      )
  : [];
const approvedIds = new Set(approvedRows.map((r) => r.rid));

function decide(r: (typeof rows)[number]): Decision {
  // A photo-fit reject (the gate's own call) — the human never saw it (censored).
  if (r.status === "rejected" && /professional photography/i.test(r.rejectionReason ?? "")) return "gate_rejected";
  if (approvedIds.has(r.id)) return "approved";
  if (r.held) return "skipped";
  return "pending";
}

const leads: CalibrationLead[] = rows.map((r) => ({
  band: (r.band as CalibrationLead["band"]) ?? null,
  proScore: r.proScore ?? null,
  decision: decide(r),
}));

const report = calibrationReport(leads);

console.log("=== Photo-fit calibration ===\n");
console.log(`leads with photo signals: ${report.counts.total}`);
console.log(
  `  approved: ${report.counts.approved}   skipped: ${report.counts.skipped}   ` +
    `pending: ${report.counts.pending}   gate-rejected (censored): ${report.counts.gateRejected}`
);
console.log(`  labeled (approved+skipped): ${report.labeled}\n`);

console.log("band vs your decision (labeled only):");
console.log("  band      approved  skipped");
for (const b of ["rich", "unclear", "sparse"] as const) {
  const c = report.bandByDecision[b];
  console.log(`  ${b.padEnd(8)}  ${String(c.approved).padStart(8)}  ${String(c.skipped).padStart(7)}`);
}

console.log("\nthreshold what-if (if the gate re-ran on your labeled leads):");
console.log("  T   would-reject skipped(good)   would-reject approved(bad)");
for (const t of report.thresholds) {
  console.log(`  ${t.threshold}   ${String(t.wouldRejectSkipped).padStart(22)}   ${String(t.wouldRejectApproved).padStart(24)}`);
}

console.log(`\n>>> ${report.recommendation}`);
console.log(
  "\nNote: the gate already dropped the clearest 'already-pro' sites before you ever saw them " +
    "(the 'gate-rejected' bucket), so this only tells you whether to reject HARDER, not whether past rejects were right."
);

process.exit(0);
