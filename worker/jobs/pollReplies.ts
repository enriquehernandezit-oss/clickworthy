// Reply poller (runs every few minutes). Reads the Gmail inbox, matches replies
// back to the outreach thread they answer, and for each first-time reply:
//   - "STOP"/opt-out  -> suppress the sender, mark the restaurant, stop.
//   - photo attached  -> store the original, create a pending-review magic link
//                        with a Revenue Impact Card, and queue enhancement.
//   - no photo        -> just record the reply (a human can follow up).
//
// Dedup is at the thread level: we set outreachJobs.repliedAt on the Touch 1
// row and skip threads already marked replied.

import { randomBytes } from "node:crypto";
import type { PgBoss } from "pg-boss";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks } from "@/db/schema";
import { config } from "../config";
import { listInboxMessages, getMessage, getAttachmentBytes } from "../lib/gmail";
import { isOptOut } from "../lib/outreachEmail";
import { addSuppression } from "../lib/suppression";
import { storeImageBytes } from "@/lib/storage";
import { generateRevenueImpactCopy } from "../lib/anthropic";
import { PROCESS_SAMPLE_QUEUE, type ProcessSampleJobData } from "./processFreeSample";

function parseFromEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

function token(): string {
  return randomBytes(24).toString("hex");
}

export async function runReplyPoll(boss: PgBoss): Promise<void> {
  let messages: { id: string; threadId: string }[];
  try {
    messages = await listInboxMessages();
  } catch (err) {
    console.warn("[poll] Gmail list failed (is Gmail configured?):", err instanceof Error ? err.message : err);
    return;
  }

  for (const { threadId } of messages) {
    // Find the Touch 1 outreach for this thread that hasn't been marked replied.
    const [job] = await db
      .select()
      .from(outreachJobs)
      .where(
        and(
          eq(outreachJobs.gmailThreadId, threadId),
          eq(outreachJobs.touchNumber, 1),
          isNull(outreachJobs.repliedAt)
        )
      )
      .limit(1);
    if (!job || job.restaurantId == null) continue;

    const full = await getMessage(threadId).catch(() => null);
    if (!full) continue;

    const sender = parseFromEmail(full.from);

    // Mark replied first so a mid-run error doesn't cause reprocessing loops.
    await db.update(outreachJobs).set({ repliedAt: new Date(), status: "replied" }).where(eq(outreachJobs.id, job.id));

    // Opt-out.
    if (isOptOut(full.bodyText)) {
      await addSuppression(sender, "opt_out");
      await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, job.restaurantId));
      console.log(`[poll] opt-out from ${sender} — suppressed`);
      continue;
    }

    const image = full.imageAttachments[0];
    if (!image) {
      console.log(`[poll] reply from ${sender} with no photo — recorded, no sample generated`);
      continue;
    }

    const [restaurant] = await db.select().from(restaurants).where(eq(restaurants.id, job.restaurantId)).limit(1);
    if (!restaurant) continue;

    // Store the emailed original (customer-supplied, so storing it is fine).
    const linkToken = token();
    let originalUrl: string;
    try {
      const bytes = await getAttachmentBytes(threadId, image.attachmentId);
      originalUrl = await storeImageBytes({
        groupKey: linkToken,
        name: `original-${image.filename}`,
        bytes,
        contentType: image.mimeType,
        appOrigin: config.appOrigin,
      });
    } catch (err) {
      console.error(`[poll] failed to store attachment from ${sender}:`, err instanceof Error ? err.message : err);
      continue;
    }

    // Revenue Impact Card copy (generated once, stored on the link).
    let revenueCopy: string | null = null;
    try {
      revenueCopy = await generateRevenueImpactCopy({
        name: restaurant.name,
        city: restaurant.city ?? "",
        rating: restaurant.rating,
        reviewCount: restaurant.reviewCount,
        priceLevel: restaurant.priceLevel,
        deliveryEnabled: Boolean(restaurant.deliveryEnabled),
        avgPhotoScore: restaurant.avgPhotoScore,
        language: restaurant.language ?? "en",
      });
    } catch (err) {
      console.warn(`[poll] revenue copy failed for ${restaurant.name}:`, err instanceof Error ? err.message : err);
    }

    const [link] = await db
      .insert(magicLinks)
      .values({
        token: linkToken,
        restaurantId: restaurant.id,
        revenueImpactCopy: revenueCopy,
        freeSampleOriginalUrl: originalUrl,
        qualifyingPhotoCount: Math.max(0, (restaurant.photoCount ?? 1) - 1),
        reviewStatus: "pending_review",
        expiresAt: new Date(Date.now() + 30 * 86_400_000), // 30-day link
      })
      .returning({ id: magicLinks.id });

    // Queue the Claid enhancement of the sample.
    const data: ProcessSampleJobData = { magicLinkId: link.id };
    await boss.send(PROCESS_SAMPLE_QUEUE, data);
    console.log(`[poll] sample received from ${restaurant.name} -> magic link ${linkToken} (pending review)`);
  }
}
