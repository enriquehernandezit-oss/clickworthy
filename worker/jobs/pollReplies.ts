// Reply poller (runs every few minutes). Reads the Gmail inbox, matches replies
// back to the outreach thread they answer, and for each first-time reply:
//   - "STOP"/opt-out  -> suppress the sender, mark the restaurant, stop.
//   - photo attached  -> store the original, create an awaiting_edit magic link
//                        with a Revenue Impact Card, and alert us to edit it.
//   - no photo        -> record the reply text + alert us to answer it by hand.
// Every branch stores the reply body/sender on the outreach row, so what they
// wrote is readable in /admin instead of living only in Gmail.
//
// Dedup is PER MESSAGE (outreachJobs.lastReplyMessageId), not per thread. It
// used to be per-thread only (skip any thread with repliedAt already set) —
// which meant a SECOND message in an already-replied thread matched nothing
// and was silently dropped: no alert, no record, gone. Now a thread that's
// already been replied to still gets checked; only an already-SEEN message id
// is skipped. The pipeline still only auto-processes the FIRST reply (photo ->
// sample, or alert-for-a-human) — anything after that always surfaces as an
// "existing thread" alert rather than trying to auto-create a second sample.

import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
    // ANY Touch-1 row for this thread — not just unreplied ones (see header
    // comment). Per-message dedup happens below via lastReplyMessageId.
    const [job] = await db
      .select()
      .from(outreachJobs)
      .where(and(eq(outreachJobs.gmailThreadId, threadId), eq(outreachJobs.touchNumber, 1)))
      .limit(1);
    if (!job || job.restaurantId == null) continue;

    // Already handled this exact message — either as the first reply, or as a
    // later one we already alerted on. listInboxMessages() re-lists the same
    // ~7-day inbox window on every run, so this is what keeps an old message
    // from re-triggering forever.
    if (job.repliedAt && job.lastReplyMessageId === messageId) continue;

    // Fetch by message id, NOT thread id — a thread's id equals its FIRST
    // message's id (our own Touch 1), so fetching by threadId would silently
    // pull our own outbound email instead of the customer's reply.
    const full = await getMessage(messageId).catch(() => null);
    if (!full) continue;

    const sender = parseFromEmail(full.from);
    const isFirstReply = job.repliedAt == null;

    // Record the message id + content up front so a mid-run error doesn't
    // cause reprocessing loops, and re-runs recognize this exact message even
    // if something below throws. repliedAt is preserved as the FIRST reply's
    // timestamp on later messages, not overwritten.
    await db
      .update(outreachJobs)
      .set({
        repliedAt: job.repliedAt ?? new Date(),
        status: "replied",
        replyBody: full.bodyText,
        replyFrom: sender,
        lastReplyMessageId: messageId,
      })
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

    // A second (or later) message in a thread already marked replied. The
    // pipeline only auto-handles the FIRST reply (photo -> sample, or an
    // alert to answer by hand); anything after that is a live back-and-forth
    // — always surface it, never try to auto-create a second magic link.
    if (!isFirstReply) {
      await sendAlert(
        "New message in an existing reply thread",
        `${restaurant.name} (${restaurant.city ?? "?"}) — ${sender} — sent another message in a thread ` +
          `already marked replied.\n\n"${full.bodyText.trim().slice(0, 500)}"\n\n` +
          `Read it in /admin (Outreach tab) and continue from your own Gmail inbox.`
      );
      console.log(`[poll] follow-up message from ${sender} — alerted (not auto-processed)`);
      continue;
    }

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
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[poll] failed to store attachment from ${sender}:`, message);
      // This used to be a silent drop: repliedAt was already committed above
      // and lastReplyMessageId now marks this message seen, so without an
      // alert the thread would never be looked at again — the one photo that
      // would have converted this lead, just gone. Now a human gets told.
      await sendAlert(
        "Reply had a photo we couldn't save",
        `${restaurant.name} (${sender}) replied with a photo, but storing it failed: ${message}\n\n` +
          `The photo is still in Gmail — open the thread there and save it manually, or ask them to resend.`
      );
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
