// Enrichment job (one per sourced restaurant): discover + verify a contact
// email, decide whether it's a chain/hospitality group, score its listing
// photos with Claude Vision (aggregates only — no photo bytes/URLs stored),
// compute a priority score, and set the restaurant's final pipeline status.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { priceLevelToInt, fetchPhotoBytes } from "../lib/places";
import { discoverEmail } from "../lib/emailDiscovery";
import { verifyEmail, isContactable } from "../lib/neverbounce";
import { scorePhoto, checkHospitalityGroup } from "../lib/anthropic";
import { priorityScore } from "../lib/priority";

export const ENRICH_QUEUE = "enrich-restaurant";

export type EnrichJobData = {
  restaurantId: number;
  photoNames: string[]; // transient Google photo refs, used immediately then discarded
};

// Final pipeline statuses set by this job:
//   queued            -> passed everything, has a contactable email, ready for outreach
//   needs_manual_email-> passed everything but no email found (Jose's manual list)
//   rejected          -> disqualified (chain / hospitality group)
type FinalStatus = "queued" | "needs_manual_email" | "rejected";

async function scorePhotos(
  photoNames: string[]
): Promise<{ avg: number | null; count: number; signatureDish: string | null }> {
  if (photoNames.length === 0) return { avg: null, count: 0, signatureDish: null };

  const scores: number[] = [];
  const dishes: { dish: string; score: number }[] = [];
  for (const name of photoNames) {
    try {
      const { bytes, contentType } = await fetchPhotoBytes(name);
      const result = await scorePhoto(bytes, contentType);
      scores.push(result.score);
      if (result.dish) dishes.push({ dish: result.dish, score: result.score });
      // bytes intentionally go out of scope here — never persisted.
    } catch (err) {
      console.warn(`[enrich] photo score failed for ${name}:`, err instanceof Error ? err.message : err);
    }
  }

  // Signature dish = the dish from the best-looking food photo (most confidently
  // a real, nameable dish). Used verbatim in the cold email's opening line.
  const signatureDish = dishes.sort((a, b) => b.score - a.score)[0]?.dish ?? null;

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

  // 1. Chain / hospitality-group disqualifier (Claude + web search). Do this
  //    first — if it's a group we can skip the email + photo work entirely.
  const group = await checkHospitalityGroup(restaurant.name, restaurant.city ?? "");
  if (group.isGroup) {
    await db
      .update(restaurants)
      .set({ isHospitalityGroup: true, enrichmentStatus: "rejected" })
      .where(eq(restaurants.id, restaurant.id));
    console.log(`[enrich] "${restaurant.name}" rejected: hospitality group (${group.reasoning})`);
    return;
  }

  // 2. Email discovery + NeverBounce verification.
  let email: string | null = null;
  let emailRank: number | null = null;
  let emailSource: string | null = null;
  if (restaurant.website) {
    const discovered = await discoverEmail(restaurant.website);
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

  // 3. Photo scoring (aggregates only) + the signature dish for the cold email.
  const { avg: avgPhotoScore, count, signatureDish } = await scorePhotos(data.photoNames);

  // 4. Priority score from all signals.
  const score = priorityScore({
    rating: restaurant.rating,
    reviewCount: restaurant.reviewCount,
    priceLevelInt: restaurant.priceLevel ?? priceLevelToInt(undefined),
    deliveryEnabled: Boolean(restaurant.deliveryEnabled),
    photoCount: restaurant.photoCount,
    avgPhotoScore,
  });

  // 5. Final status. Ready to auto-contact only with BOTH a contactable email
  //    and a signature dish (the cold email's personalization hinges on the
  //    dish — a generic Touch 1 is a deleted Touch 1). Otherwise it waits for a
  //    human (manual email lookup or a hand-picked dish).
  const finalStatus: FinalStatus = email && signatureDish ? "queued" : "needs_manual_email";

  await db
    .update(restaurants)
    .set({
      email,
      emailRank,
      emailSource,
      signatureDish,
      contactFirstName: group.ownerFirstName,
      avgPhotoScore,
      photoCount: count > 0 ? count : restaurant.photoCount,
      priorityScore: score,
      isHospitalityGroup: false,
      enrichmentStatus: finalStatus,
    })
    .where(eq(restaurants.id, restaurant.id));

  console.log(
    `[enrich] "${restaurant.name}" -> ${finalStatus} ` +
      `(priority ${score}, dish ${signatureDish ?? "none"}, email ${email ?? "none"})`
  );
}
