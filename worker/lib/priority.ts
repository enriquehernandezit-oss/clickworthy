// Priority scoring (PROJECT_CONTEXT Section 7). Higher score = contact sooner.
// These are signals that BUMP priority, never hard filters — every restaurant
// that passed the hard filters still qualifies regardless of its score.
//
// Signals combined:
//   - Delivery enabled            -> bump (delivery clicks are the ROI story)
//   - Fewer owner photos          -> bump (more headroom to help)
//   - Lower rating within <=4.0   -> bump
//   - Lower avg Claude photo score-> bump (worse photos = more upside)
//   - Price/review weighting: priority rises as reviews fall toward 1 and as
//     price is <= $$$ (a $$ place with 40 reviews outranks a $$$ with 480).

export type PriorityInputs = {
  rating: number | null; // any rating (wide net — no ceiling); the curve still bumps lower ratings
  reviewCount: number | null; // >= 20 after filtering (no upper bound)
  priceLevelInt: number | null; // 1–4
  deliveryEnabled: boolean;
  photoCount: number | null; // owner-uploaded photo count
  avgPhotoScore: number | null; // 2–6 mean Claude Vision score (may be null pre-scoring)
};

// Returns a score roughly in [0, 100]. Weights are intentionally simple and
// tunable; the ordering is what matters, not the absolute value.
export function priorityScore(i: PriorityInputs): number {
  let score = 0;

  // Lower rating within the qualifying band → more upside. Map 4.0→0, 2.0→20.
  if (i.rating !== null) {
    score += clamp((4.0 - i.rating) * 10, 0, 20);
  }

  // Fewer reviews → higher priority. Map 30 reviews→~18, 500→~1.
  if (i.reviewCount !== null) {
    score += clamp(20 * (1 - (i.reviewCount - 30) / (500 - 30)), 0, 20);
  }

  // Price <= $$$ gets priority; cheaper ranks a touch higher.
  if (i.priceLevelInt !== null) {
    score += i.priceLevelInt <= 3 ? clamp(15 - (i.priceLevelInt - 1) * 4, 0, 15) : 0;
  }

  // Delivery enabled → flat bump.
  if (i.deliveryEnabled) score += 15;

  // Fewer owner photos → more headroom. Map 0 photos→15, 30+→0.
  if (i.photoCount !== null) {
    score += clamp(15 * (1 - i.photoCount / 30), 0, 15);
  }

  // Worse average photo quality → more upside. Map score 6→0, 2→15.
  if (i.avgPhotoScore !== null) {
    score += clamp((6 - i.avgPhotoScore) * 3.75, 0, 15);
  }

  return Math.round(score * 100) / 100;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
