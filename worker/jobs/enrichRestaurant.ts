// Enrichment job (one per sourced restaurant): discover + verify a contact
// email, decide whether it's a chain/hospitality group, score its listing
// photos with Claude Vision (aggregates only — no photo bytes/URLs stored),
// compute a priority score, and set the restaurant's final pipeline status.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { config } from "../config";
import { priceLevelToInt, fetchPhotoBytes } from "../lib/places";
import { fetchHomepageHtml } from "../lib/emailDiscovery";
import { findVerifiedEmail } from "../lib/findEmail";
import { scorePhoto, checkHospitalityGroup } from "../lib/anthropic";
import { assessPhotoFit } from "../lib/photoFit";
import { priorityScore } from "../lib/priority";
import { classifyWebsite } from "../lib/websitePlatform";

export { ENRICH_QUEUE } from "@/lib/queues";

export type EnrichJobData = {
  restaurantId: number;
  photoNames: string[]; // transient Google photo refs, used immediately then discarded
};

// Final pipeline statuses set by this job:
//   queued            -> passed everything, has a contactable email, ready for EMAIL outreach
//   needs_manual_email-> HAS a website but no email auto-found (Jose can find the address; email segment)
//   call_list         -> NO website at all -> no email path; phone segment (Jose calls; has a phone number)
//   rejected          -> disqualified (chain / hospitality group / already-pro photos)
type FinalStatus = "queued" | "needs_manual_email" | "call_list" | "rejected";

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

  // 1. Fetch the homepage ONCE — it drives both the photo-fit gates and email
  //    discovery (same page, one download).
  const homepageHtml = restaurant.website ? await fetchHomepageHtml(restaurant.website) : null;

  // 2. Photo-fit gates. Reject restaurants that ALREADY have professional
  //    photography BEFORE paying for NeverBounce / dish scoring / a human's
  //    review — but only when the free structural read AND a Vision look at their
  //    own best photo agree (worker/lib/photoFit.ts). Sparse sites skip Vision.
  const fit = await assessPhotoFit(homepageHtml, restaurant.website);
  // Fit signals stored on every enriched lead (kept or rejected) — the feedback
  // loop reads them back against approve/skip decisions (scripts/calibrate-threshold.ts).
  // When the gate never actually saw the page (fetch failed / no website),
  // store NULL rather than the placeholder band — otherwise an unscreened lead
  // is indistinguishable from a genuinely-thin one, which is exactly how 24
  // leads with real websites ended up recorded as "sparse, richness 0" and
  // treated as our best targets. Null also makes them automatic candidates for
  // scripts/rescreen-backlog.ts, which targets rows with no band.
  const fitSignals = fit.screened
    ? {
        websitePhotoBand: fit.band,
        websitePhotoRichness: fit.richness,
        websiteProScore: fit.proScore,
      }
    : { websitePhotoBand: null, websitePhotoRichness: null, websiteProScore: null };
  if (fit.decision === "reject") {
    await db
      .update(restaurants)
      .set({
        ...fitSignals,
        isHospitalityGroup: false,
        enrichmentStatus: "rejected",
        rejectionReason: fit.reason,
      })
      .where(eq(restaurants.id, restaurant.id));
    console.log(`[enrich] "${restaurant.name}" -> rejected (photo-fit: ${fit.reason})`);
    return;
  }

  // 3. Email discovery (reusing the homepage) + NeverBounce verification.
  //    Four free extractors first; if they find nothing, a few standard
  //    mailboxes on the restaurant's own domain are verified as a fallback.
  //    Only a NeverBounce-contactable address is ever kept (see findEmail.ts).
  let email: string | null = null;
  let emailRank: number | null = null;
  let emailSource: string | null = null;
  if (restaurant.website) {
    // null homepage (fetch failed) -> pass undefined so discovery retries its
    // own fetch rather than skipping outright.
    const { found } = await findVerifiedEmail(restaurant.website, homepageHtml ?? undefined);
    if (found) {
      email = found.email;
      emailRank = found.rank;
      emailSource = found.source; // 'website' | 'guessed' — kept for calibration
    }
  }

  // 4. Chain / hospitality-group disqualifier (Claude + up to 3 web searches).
  //    Catches what the static denylist structurally cannot: a restaurant whose
  //    NAME gives no hint it belongs to a group (verified live — 9 of 14
  //    approved drafts were groups). ownerFirstName is a byproduct of the same
  //    call; without it Touch 1 falls back to a generic "Hi there," greeting
  //    (worker/lib/outreachEmail.ts).
  //
  //    RUNS LAST, AND ONLY ON EMAILABLE LEADS. It used to be step 1, which meant
  //    paying ~$0.07 to vet every candidate that cleared the free filters —
  //    ~68/night — when only ~4-8 of those ever get a verified email. Measured
  //    over Aug 20-23: 273 checks, $16-22, to protect ~20 actual sends. Gating on
  //    `email` cuts that to ~$0.55/night (~$120/mo) and loses nothing that
  //    matters: a chain only costs us something when we EMAIL it (sender
  //    reputation + a slot under the daily cap), and ownerFirstName is only ever
  //    read for leads that get emailed. `call_list` / `needs_manual_email` leads
  //    skip the check — a human works those by hand, and the free denylist
  //    (worker/lib/chains.ts) still ran at the filter stage for everyone.
  //
  //    FAILS OPEN. External API + web searches is the most failure-prone step, so
  //    a transient timeout must not throw the whole job: pg-boss would leave the
  //    restaurant stranded at `sourced` and a retry would re-pay for every step
  //    above. On error we log and continue as "not a group" — a human reviews
  //    every draft anyway, so letting a possible chain reach review beats
  //    silently losing the lead.
  let ownerFirstName: string | null = null;
  if (config.enableChainCheck && email) {
    try {
      const group = await checkHospitalityGroup(restaurant.name, restaurant.city ?? "");
      if (group.isGroup) {
        await db
          .update(restaurants)
          .set({
            ...fitSignals,
            email,
            emailRank,
            emailSource,
            isHospitalityGroup: true,
            enrichmentStatus: "rejected",
            rejectionReason: `Chain / hospitality group: ${group.reasoning}`,
          })
          .where(eq(restaurants.id, restaurant.id));
        console.log(`[enrich] "${restaurant.name}" rejected: hospitality group (${group.reasoning})`);
        return;
      }
      ownerFirstName = group.ownerFirstName;
    } catch (err) {
      console.warn(
        `[enrich] chain check FAILED for "${restaurant.name}" — continuing as independent:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // 5. Signature dish + photo score. Prefer a dish Gate 2 already saw on the
  //    website (free — those images were scored for the fit check); only fall
  //    back to scoring Google photos when the website gave us nothing.
  //
  //    The paid Google fallback runs ONLY for a lead that has a verified email.
  //    The dish exists for exactly one purpose: the Touch 1 cold email. A
  //    call_list lead (no website) has no email path at all, and a
  //    needs_manual_email lead has no address yet — neither sends a
  //    dish-personalized email, so scoring their Google photos for a dish spends
  //    on something structurally unusable. Measured 2026-08-24: 92 of 106
  //    all-time Google Vision calls (87%) were on emailless leads. A website
  //    dish (fit.dish above) is still kept for free regardless, and if Jose
  //    later adds an address the no-dish template handles the missing dish
  //    cleanly (worker/lib/outreachEmail.ts). avgPhotoScore is a minor priority
  //    signal that only ranks the send queue — which emailless leads aren't in —
  //    so nothing that affects outreach is lost.
  let signatureDish = fit.dish;
  let avgPhotoScore: number | null = null;
  let photosScored = 0;
  if (!signatureDish && email) {
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

  // 7. Final status routes the lead to its outreach SEGMENT:
  //    - a contactable email  -> queued          (Segment B: email photo outreach)
  //    - has a website with a real mailbox that MIGHT exist, no email found ->
  //      needs_manual_email (still an email lead — Jose finds the address)
  //    - no website, OR the "website" is a social/ordering page with no
  //      mailbox of its own -> call_list (Segment A: phone)
  //
  //    The social/ordering-page case is why classifyWebsite runs here, not just
  //    on discovery/routing above: discovery ALREADY tries and fails to find an
  //    address on these (isNonOwnedHost skips guessing them), so `email` is
  //    correctly null — but the old rule then sent them to needs_manual_email
  //    just because `restaurant.website` was non-null, sending Jose to "find
  //    the address" on a page where no address can exist. Measured 2026-08-25:
  //    15 of 119 needs_manual_email leads were exactly this — Instagram,
  //    Facebook, or an ordering-platform URL. `free_subdomain` (Weebly/Wix/etc)
  //    stays needs_manual_email on purpose: a real mailbox can still exist there.
  const platformTier = restaurant.website ? classifyWebsite(restaurant.website).tier : "none";
  const isDeadEndWebsite = platformTier === "social_only" || platformTier === "ordering_platform";
  const finalStatus: FinalStatus = email
    ? "queued"
    : restaurant.website && !isDeadEndWebsite
      ? "needs_manual_email"
      : "call_list";

  await db
    .update(restaurants)
    .set({
      ...fitSignals,
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
