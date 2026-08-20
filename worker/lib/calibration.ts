// The feedback loop's brain: given each enriched lead's stored photo-fit signals
// (band + Gate-2 pro-score) AND the human's eventual decision on it (approved vs
// skipped in /admin), work out whether the auto-reject threshold matches the
// operator's actual taste — and what threshold would match it better.
//
// Pure and deterministic so it's unit-tested with synthetic data; the DB I/O
// lives in scripts/calibrate-threshold.ts.
//
// IMPORTANT censoring caveat baked into the interpretation: leads the gate
// already REJECTED never became drafts, so the human never labeled them. The
// only leads with a human decision are ones the gate KEPT. So this calibration
// answers "am I keeping leads the human then skips?" (→ maybe reject harder),
// not "were my rejects correct?" (unobservable). The thresholds it evaluates are
// therefore about tightening, and it says so.

export type Decision = "approved" | "skipped" | "pending" | "gate_rejected";

export type CalibrationLead = {
  band: "rich" | "unclear" | "sparse" | null;
  proScore: number | null; // Gate-2 best real-photo score (2–6), null if sparse/unjudged
  decision: Decision;
};

export type ThresholdWhatIf = {
  threshold: number;
  // Among leads the human LABELED (approved/skipped), how the gate at this
  // threshold would have acted if it re-ran now (reject = band rich & pro>=T):
  wouldRejectSkipped: number; // human skipped these too → the gate agreeing = good (saved review)
  wouldRejectApproved: number; // human APPROVED these → the gate would have wrongly dropped a wanted lead
};

export type CalibrationReport = {
  counts: { total: number; approved: number; skipped: number; pending: number; gateRejected: number };
  labeled: number; // approved + skipped
  bandByDecision: Record<"rich" | "unclear" | "sparse", { approved: number; skipped: number }>;
  thresholds: ThresholdWhatIf[];
  recommendation: string;
};

const MIN_LABELED_FOR_RECO = 15; // below this, any recommendation is noise
const CANDIDATE_THRESHOLDS = [4, 5, 6];

export function calibrationReport(leads: CalibrationLead[]): CalibrationReport {
  const counts = { total: leads.length, approved: 0, skipped: 0, pending: 0, gateRejected: 0 };
  const bandByDecision = {
    rich: { approved: 0, skipped: 0 },
    unclear: { approved: 0, skipped: 0 },
    sparse: { approved: 0, skipped: 0 },
  };

  for (const l of leads) {
    if (l.decision === "approved") counts.approved++;
    else if (l.decision === "skipped") counts.skipped++;
    else if (l.decision === "pending") counts.pending++;
    else if (l.decision === "gate_rejected") counts.gateRejected++;

    if ((l.decision === "approved" || l.decision === "skipped") && l.band && l.band in bandByDecision) {
      bandByDecision[l.band][l.decision]++;
    }
  }

  const labeled = counts.approved + counts.skipped;

  const thresholds: ThresholdWhatIf[] = CANDIDATE_THRESHOLDS.map((threshold) => {
    let wouldRejectSkipped = 0;
    let wouldRejectApproved = 0;
    for (const l of leads) {
      const isLabeled = l.decision === "approved" || l.decision === "skipped";
      if (!isLabeled) continue;
      const wouldReject = l.band === "rich" && l.proScore != null && l.proScore >= threshold;
      if (!wouldReject) continue;
      if (l.decision === "skipped") wouldRejectSkipped++;
      else wouldRejectApproved++;
    }
    return { threshold, wouldRejectSkipped, wouldRejectApproved };
  });

  return { counts, labeled, bandByDecision, thresholds, recommendation: recommend(labeled, thresholds) };
}

function recommend(labeled: number, thresholds: ThresholdWhatIf[]): string {
  if (labeled < MIN_LABELED_FOR_RECO) {
    return (
      `Only ${labeled} reviewed lead(s) carry photo signals so far — too few to recommend a threshold. ` +
      `Keep reviewing batches; revisit after ~${MIN_LABELED_FOR_RECO}+ approve/skip decisions.`
    );
  }
  // Prefer the LOWEST threshold that would auto-reject some leads the human
  // skipped WITHOUT catching any the human approved — i.e. tighten only as far
  // as your own decisions clearly support.
  const clean = thresholds
    .filter((t) => t.wouldRejectApproved === 0 && t.wouldRejectSkipped > 0)
    .sort((a, b) => a.threshold - b.threshold)[0];
  if (clean) {
    return (
      `At threshold ${clean.threshold}, the gate would auto-reject ${clean.wouldRejectSkipped} lead(s) you skipped and ` +
      `0 you approved — a safe tightening. Consider VISION_PRO_THRESHOLD=${clean.threshold} (current default 5).`
    );
  }
  const anyCatch = thresholds.some((t) => t.wouldRejectSkipped > 0);
  if (!anyCatch) {
    return `You aren't skipping the rich/high-pro-score leads the gate keeps — the current threshold (5) looks well-matched; no change suggested.`;
  }
  return (
    `Every threshold that catches leads you skipped would also drop leads you approved — your skips aren't cleanly ` +
    `explained by the photo signal. Keep the default (5) and look elsewhere (dish/price/city) for what drives your skips.`
  );
}
