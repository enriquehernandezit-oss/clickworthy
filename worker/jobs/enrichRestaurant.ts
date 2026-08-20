// Enrichment job (one per sourced restaurant): discover + verify a contact
// email, decide whether it's a chain/hospitality group, score its listing
// photos with Claude Vision (aggregates only — no photo bytes/URLs stored),
// compute a priority score, and set the restaurant's final pipeline status.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "../config";
import { priceLevelToInt, fetchPhotoBytes } from "../lib/places";
import { discoverEmail, fetchHomepageHtml } from "../lib/emailDiscovery";
import { verifyEmail, isContactable } from "../lib/neverbounce";
import { scorePhoto, checkHospitalityGroup } from "../lib/anthropic";
import { assessPhotoFit } from "../lib/photoFit";
import { priorityScore } from "../lib/priority";

export { ENRICH_QUEUE } from "@/lib/queues";

export type EnrichJobData = {
  restaurantId: number;
  photoNames: string[]; // transient Google photo refs, used immediately then discarded
};

// Final pipeline statuses set by this job:
//   queued            -> passed everything, has a contactable email, ready for outreach
//   needs_manual_email-> passed everything but no email found (Jose's manual list)
//   rejected          -> disqualified (chain / hospitality group / already-pro photos)
type FinalStatus = "queued" | "needs_manual_email" | "rejected";

// Photo scoring is the dominant per-restaurant cost (a Google fetch + a Claude
// Vision call each), so it's ADAPTIVE: score photos one at a time and stop the
// moment we have a signature dish — which is the only thing the cold email
// actually needs. Restaurants' Google photos are usually food-forward, so the
// typical cost is 1–2 photos; `limit` is just the worst-case ceiling for the
// unlucky case where the first few photos are storefront/interior shots.
async function scorePhotos(
  photoNames: string[],
  limit: number
): Promise<{ avg: number | null; count: number; signatureDish: string | null }> {
  if (photoNames.length === 0) return { avg: null, count: 0, signatureDish: null };

  const scores: number[] = [];
  let signatureDish: string | null = null;
  for (const name of photoNames.slice(0, limit)) {
    try {
      const { bytes, contentType } = await fetchPhotoBytes(name);
      const result = await scorePhoto(bytes, contentType);
      scores.push(result.score);
      // bytes intentionally go out of scope here — never persisted.
      if (result.dish) {
        // First real dish found — that's the personalization we came for. Stop
        // spending on further Vision calls.
        signatureDish = result.dish;
        break;
      }
    } catch (err) {
      console.warn(`[enrich] photo score failed for ${name}:`, err instanceof Error ? err.message : err);
    }
  }

  if (scores.length === 0) return { avg: null, count: 0, signatureDish };
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { avg: Math.round(avg * 100) / 100, count: scores.length, signatureDish };
}

export async function runEnrichment(data: EnrichJobData): Promise<void> {
  const [restaurant] = await db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, data.restaurantId))
    .limit(1);

  if (!restaurant) {
    console.warn(`[enrich] restaurant ${data.restaurantId} not found; skipping`);
    return;
  }

  // 1. Chain / hospitality-group disqualifier (Claude + web search). Off by
  //    default under the wide-net strategy — it's a paid disqualifier (~6¢/call)
  //    and we'd rather email a franchise than pay to exclude it. When enabled,
  //    a group verdict short-circuits the rest of the (paid) enrichment.
  //    ownerFirstName is a byproduct of this call; without it, Touch 1 falls
  //    back to a generic "Hi there," greeting (see worker/lib/outreachEmail.ts).
  let ownerFirstName: string | null = null;
  if (config.enableChainCheck) {
    const group = await checkHospitalityGroup(restaurant.name, restaurant.city ?? "");
    if (group.isGroup) {
      await db
        .update(restaurants)
        .set({
          isHospitalityGroup: true,
          enrichmentStatus: "rejected",
          rejectionReason: `Chain / hospitality group: ${group.reasoning}`,
        })
        .where(eq(restaurants.id, restaurant.id));
      console.log(`[enrich] "${restaurant.name}" rejected: hospitality group (${group.reasoning})`);
      return;
    }
    ownerFirstName = group.ownerFirstName;
  }

  // 2. Fetch the homepage ONCE — it drives both the photo-fit gates and email
  //    discovery (same page, one download).
  const homepageHtml = restaurant.website ? await fetchHomepageHtml(restaurant.website) : null;

  // 3. Photo-fit gates. Reject restaurants that ALREADY have professional
  //    photography BEFORE paying for NeverBounce / dish scoring / a human's
  //    review — but only when the free structural read AND a Vision look at their
  //    own best photo agree (worker/lib/photoFit.ts). Sparse sites skip Vision.
  const fit = await assessPhotoFit(homepageHtml, restaurant.website);
  if (fit.decision === "reject") {
    await db
      .update(restaurants)
      .set({
        contactFirstName: ownerFirstName,
        isHospitalityGroup: false,
        enrichmentStatus: "rejected",
        rejectionReason: fit.reason,
      })
      .where(eq(restaurants.id, restaurant.id));
    console.log(`[enrich] "${restaurant.name}" -> rejected (photo-fit: ${fit.reason})`);
    return;
  }

  // 4. Email discovery (reusing the homepage) + NeverBounce verification.
  let email: string | null = null;
  let emailRank: number | null = null;
  let emailSource: string | null = null;
  if (restaurant.website) {
    // null homepage (fetch failed) -> pass undefined so discoverEmail retries its
    // own fetch rather than skipping outright.
    const discovered = await discoverEmail(restaurant.website, homepageHtml ?? undefined);
    if (discovered) {
      try {
        const verdict = await verifyEmail(discovered.email);
        if (isContactable(verdict)) {
          email = discovered.email;
          emailRank = discovered.rank;
          emailSource = "website";
        }
      } catch (err) {
        console.warn(`[enrich] NeverBounce failed for ${discovered.email}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  // 5. Signature dish + photo score. Prefer a dish Gate 2 already saw on the
  //    website (free — those images were scored for the fit check); only fall
  //    back to scoring Google photos when the website gave us nothing. Google
  //    scoring is also where avgPhotoScore (a priority signal) comes from, so a
  //    website-dish lead trades that minor signal for the saved Vision calls.
  let signatureDish = fit.dish;
  let avgPhotoScore: number | null = null;
  let photosScored = 0;
  if (!signatureDish) {
    const g = await scorePhotos(data.photoNames, config.photoScoreLimit);
    signatureDish = g.signatureDish;
    avgPhotoScore = g.avg;
    photosScored = g.count;
  }

  // 6. Priority score from all signals.
  const score = priorityScore({
    rating: restaurant.rating,
    reviewCount: restaurant.reviewCount,
    priceLevelInt: restaurant.priceLevel ?? priceLevelToInt(undefined),
    deliveryEnabled: Boolean(restaurant.deliveryEnabled),
    photoCount: restaurant.photoCount,
    avgPhotoScore,
  });

  // 7. Final status. A contactable email is all that's required to queue; a
  //    missing email holds a lead as needs_manual_email.
  const finalStatus: FinalStatus = email ? "queued" : "needs_manual_email";

  await db
    .update(restaurants)
    .set({
      email,
      emailRank,
      emailSource,
      signatureDish,
      contactFirstName: ownerFirstName,
      avgPhotoScore,
      // photosScored (how many we ran Vision on), NOT photoCount — leave the
      // raw Places photo count set at sourcing intact as the priority signal.
      photosScored,
      priorityScore: score,
      isHospitalityGroup: false,
      enrichmentStatus: finalStatus,
    })
    .where(eq(restaurants.id, restaurant.id));

  console.log(
    `[enrich] "${restaurant.name}" -> ${finalStatus} ` +
      `(band ${fit.band}, priority ${score}, dish ${signatureDish ?? "none"}, email ${email ?? "none"})`
  );
}
