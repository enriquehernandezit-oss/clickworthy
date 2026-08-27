// Find a CONTACTABLE email for a restaurant: run the (free) extractors over its
// site, then — only if those come up empty — verify a few standard guesses.
// This is the impure orchestration layer over emailDiscovery.ts's pure parsing,
// mirroring how photoFit.ts wraps websitePhotos.ts.
//
// The invariant that keeps deliverability safe: NOTHING is returned unless
// NeverBounce says it's contactable. A guess used to clear exactly the same bar
// as a scraped address; since 2026-08-27 it clears a STRICTER one — a `catchall`
// verdict is accepted for a scraped address but rejected for a guess, because an
// accept-all domain says yes to any address we invent (see isContactable in
// neverbounce.ts for the measured bounce numbers behind that split).
//
// Shared by worker/jobs/enrichRestaurant.ts and scripts/backfill-emails.ts so
// the nightly path and the backfill can never drift apart.

import { config } from "../config";
import { discoverEmail, guessEmailCandidates } from "./emailDiscovery";
import { verifyEmail, isContactable } from "./neverbounce";

export type FoundEmail = {
  email: string;
  rank: number;              // 1 (best) .. 4; guesses come back as 3
  source: "website" | "guessed";
  checks: number;            // NeverBounce calls spent (cost visibility)
};

export type FindEmailDeps = {
  // `guessed` is passed through to isContactable, which applies a stricter bar
  // to invented addresses than to ones found on the site.
  verify: (email: string, opts: { guessed: boolean }) => Promise<boolean>;
};

const defaultDeps: FindEmailDeps = {
  verify: async (email, opts) => isContactable(await verifyEmail(email), opts),
};

export async function findVerifiedEmail(
  websiteUrl: string,
  homepageHtml?: string | null,
  deps: FindEmailDeps = defaultDeps
): Promise<{ found: FoundEmail | null; checks: number }> {
  let checks = 0;

  // 1. Scraped address (four extractors, all free).
  const discovered = await discoverEmail(websiteUrl, homepageHtml);
  if (discovered) {
    try {
      checks++;
      if (await deps.verify(discovered.email, { guessed: false })) {
        return { found: { email: discovered.email, rank: discovered.rank, source: "website", checks }, checks };
      }
    } catch (err) {
      // NeverBounce unreachable: stop here rather than burning guesses against a
      // broken verifier (which would return "unverified" for everything).
      console.warn(`[email] verify failed for ${discovered.email}:`, err instanceof Error ? err.message : err);
      return { found: null, checks };
    }
  }

  // 2. Verified guesses — only for a domain the restaurant actually owns.
  const guesses = guessEmailCandidates(websiteUrl).slice(0, config.emailGuessLimit);
  for (const guess of guesses) {
    try {
      checks++;
      if (await deps.verify(guess, { guessed: true })) {
        // rank 3 = "preferred mailbox, not proven to be on the site" — a guess is
        // never rank 1, so a scraped address always outranks it downstream.
        return { found: { email: guess, rank: 3, source: "guessed", checks }, checks };
      }
    } catch (err) {
      console.warn(`[email] verify failed for guess ${guess}:`, err instanceof Error ? err.message : err);
      break; // verifier is down — don't hammer it
    }
  }

  return { found: null, checks };
}
