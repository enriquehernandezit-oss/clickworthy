// Free-sample enhancement job. Runs the customer's emailed photo through Claid
// (AI Edit + upscale, the same pipeline as /enhance) using the finalized
// outreach prompt, persists the result durably, and stores it on the magic link
// — which stays in `pending_review` until a human approves it in /admin.
//
// We deliberately do NOT auto-send Touch 2 here: the plan gates the enhanced
// sample behind human review so a bad AI result never reaches a prospect.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl } from "@/lib/storage";
import { config } from "../config";
import { FINALIZED_ENHANCEMENT_PROMPT } from "../lib/prompts";

export const PROCESS_SAMPLE_QUEUE = "process-free-sample";

export type ProcessSampleJobData = { magicLinkId: number };

export async function runProcessFreeSample(data: ProcessSampleJobData): Promise<void> {
  const [link] = await db.select().from(magicLinks).where(eq(magicLinks.id, data.magicLinkId)).limit(1);
  if (!link || !link.freeSampleOriginalUrl) {
    console.warn(`[sample] magic link ${data.magicLinkId} missing or has no original; skipping`);
    return;
  }

  try {
    const claidUrl = await enhancePhoto(link.freeSampleOriginalUrl, FINALIZED_ENHANCEMENT_PROMPT);
    const durableUrl = await persistEnhancedFromUrl(link.token, 0, claidUrl, config.appOrigin);

    await db.update(magicLinks).set({ freeSampleEnhancedUrl: durableUrl }).where(eq(magicLinks.id, link.id));
    console.log(`[sample] enhanced sample ready for review — link ${link.token}`);
  } catch (err) {
    // TODO(Phase 4): alert us via Resend — a reply came in but we couldn't
    // produce the sample, so a warm lead is stuck.
    console.error(`[sample] enhancement failed for link ${link.token}:`, err instanceof Error ? err.message : err);
  }
}
