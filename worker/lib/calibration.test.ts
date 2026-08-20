// Tests for the calibration logic (worker/lib/calibration.ts). Run with `bun test`.

import { expect, test, describe } from "bun:test";
import { calibrationReport, type CalibrationLead } from "./calibration";

function lead(band: CalibrationLead["band"], proScore: number | null, decision: CalibrationLead["decision"]): CalibrationLead {
  return { band, proScore, decision };
}

describe("calibrationReport — counts and coverage", () => {
  test("tallies decisions and band cross-tab", () => {
    const r = calibrationReport([
      lead("sparse", null, "approved"),
      lead("unclear", 4, "approved"),
      lead("rich", 4, "skipped"),
      lead("rich", 6, "gate_rejected"),
      lead("unclear", 3, "pending"),
    ]);
    expect(r.counts).toEqual({ total: 5, approved: 2, skipped: 1, pending: 1, gateRejected: 1 });
    expect(r.labeled).toBe(3);
    expect(r.bandByDecision.rich.skipped).toBe(1);
    expect(r.bandByDecision.sparse.approved).toBe(1);
  });

  test("too little labeled data → no threshold recommendation", () => {
    const r = calibrationReport([lead("rich", 5, "approved"), lead("rich", 4, "skipped")]);
    expect(r.recommendation).toContain("too few");
  });
});

describe("calibrationReport — threshold what-if", () => {
  // 20 labeled leads: a clean signal where the human skips rich pro=4 leads and
  // approves everything else. Lowering the threshold to 4 should be recommended.
  const cleanSignal: CalibrationLead[] = [
    ...Array.from({ length: 8 }, () => lead("rich", 4, "skipped")), // human dislikes these
    ...Array.from({ length: 12 }, () => lead("sparse", null, "approved")), // and likes these
  ];

  test("recommends the lowest safe tightening when skips are cleanly explained", () => {
    const r = calibrationReport(cleanSignal);
    const t4 = r.thresholds.find((t) => t.threshold === 4)!;
    expect(t4.wouldRejectSkipped).toBe(8);
    expect(t4.wouldRejectApproved).toBe(0);
    expect(r.recommendation).toContain("threshold 4");
  });

  test("does not recommend tightening that would drop approved leads", () => {
    // Human APPROVED rich pro=5 leads — a threshold of 5 would wrongly drop them.
    const conflicted: CalibrationLead[] = [
      ...Array.from({ length: 10 }, () => lead("rich", 5, "approved")),
      ...Array.from({ length: 10 }, () => lead("rich", 5, "skipped")),
    ];
    const r = calibrationReport(conflicted);
    const t5 = r.thresholds.find((t) => t.threshold === 5)!;
    expect(t5.wouldRejectApproved).toBe(10); // would drop wanted leads
    expect(r.recommendation.toLowerCase()).toContain("approved");
  });

  test("well-matched threshold → suggests no change", () => {
    // Human keeps and approves the rich/high-pro leads the gate kept — no skips
    // among them, so nothing to tighten.
    const wellMatched: CalibrationLead[] = [
      ...Array.from({ length: 16 }, () => lead("unclear", 5, "approved")),
      ...Array.from({ length: 4 }, () => lead("sparse", null, "skipped")),
    ];
    const r = calibrationReport(wellMatched);
    expect(r.recommendation.toLowerCase()).toContain("no change");
  });
});
