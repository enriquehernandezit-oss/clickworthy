// Reply poller (runs every few minutes). Reads the Gmail inbox, matches replies
// back to the outreach thread they answer, and for each first-time reply:
//   - "STOP"/opt-out  -> suppress the sender, mark the restaurant, stop.
//   - photo attached  -> store the original, create an awaiting_edit magic link
//                        with a Revenue Impact Card, and alert us to edit it.
//   - no photo        -> record the reply text + alert us to answer it by hand.
// Every branch stores the reply body/sender on the outreach row, so what they
// wrote is readable in /admin instead of living only in Gmail.
//
// Dedup is at the thread level: we set outreachJobs.repliedAt on the Touch 1
// row and skip threads already marked replied.

import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { config } from "../config";
import { listInboxMessages, getMessage, getAttachmentBytes } from "../lib/gmail";
import { isOptOut } from "../lib/outreachEmail";
import { addSuppression } from "../lib/suppression";
import { storeImageBytes } from "@/lib/storage";
import { generateRevenueImpactCopy } from "../lib/anthropic";

function parseFromEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

function token(): string {
  return randomBytes(24).toString("hex");
}

export async function runReplyPoll(): Promise<void> {
  let messages: { id: string; threadId: string }[];
  try {
    messages = await listInboxMessages();
  } catch (err) {
    console.warn("[poll] Gmail list failed (is Gmail configured?):", err instanceof Error ? err.message : err);
    return;
  }

  for (const { id: messageId, threadId } of messages) {
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

    // Fetch by message id, NOT thread id — a thread's id equals its FIRST
    // message's id (our own Touch 1), so fetching by threadId would silently
    // pull our own outbound email instead of the customer's reply.
    const full = await getMessage(messageId).catch(() => null);
    if (!full) continue;

    const sender = parseFromEmail(full.from);

    // Mark replied first so a mid-run error doesn't cause reprocessing loops.
    // Store what they wrote in the same update — every branch below (opt-out,
    // no-photo, photo) leaves a readable record in /admin.
    await db
      .update(outreachJobs)
      .set({ repliedAt: new Date(), status: "replied", replyBody: full.bodyText, replyFrom: sender })
      .where(eq(outreachJobs.id, job.id));

    // Opt-out.
    if (isOptOut(full.bodyText)) {
      await addSuppression(sender, "opt_out");
      await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, job.restaurantId));
      console.log(`[poll] opt-out from ${sender} — suppressed`);
      continue;
    }

    const [restaurant] = await db.select().from(restaurants).where(eq(restaurants.id, job.restaurantId)).limit(1);
    if (!restaurant) continue;

    const image = full.imageAttachments[0];
    if (!image) {
      // A real human wrote back with a question or interest — the pipeline only
      // auto-handles photo replies and STOP, so this needs YOU, today.
      await sendAlert(
        "New reply — needs your answer",
        `${restaurant.name} (${restaurant.city ?? "?"}) — ${sender} — replied to Touch 1 without a photo.\n\n` +
          `"${full.bodyText.trim().slice(0, 500)}"\n\n` +
          `Read it in /admin (Outreach tab) and answer from your own Gmail inbox — nothing is sent automatically.`
      );
      console.log(`[poll] reply from ${sender} with no photo — recorded + alerted`);
      continue;
    }

    // Store the emailed original (customer-supplied, so storing it is fine).
    const linkToken = token();
    let originalUrl: string;
    try {
      const bytes = await getAttachmentBytes(messageId, image.attachmentId);
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

    await db.insert(magicLinks).values({
      token: linkToken,
      restaurantId: restaurant.id,
      revenueImpactCopy: revenueCopy,
      freeSampleOriginalUrl: originalUrl,
      qualifyingPhotoCount: Math.max(0, (restaurant.photoCount ?? 1) - 1),
      // Awaits a human: Enrique/Jose edit the photo by hand in /admin (optionally
      // starting from a one-click Claid pass), upload the finished version, and
      // approve — which is what sends Touch 2. No auto-enhancement.
      reviewStatus: "awaiting_edit",
      expiresAt: new Date(Date.now() + 30 * 86_400_000), // 30-day link
    });

    // Notify us so the same-day turnaround actually happens.
    await sendAlert(
      "New reply — photo ready to edit",
      `${restaurant.name} (${sender}) replied with a photo. Edit it in /admin and approve to send it back.`
    );
    console.log(`[poll] sample received from ${restaurant.name} -> ${linkToken} (awaiting edit)`);
  }
}
