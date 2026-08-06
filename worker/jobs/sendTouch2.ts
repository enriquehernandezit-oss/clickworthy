// Touch 2 sender. Picks up magic links a human APPROVED in /admin (review_status
// = approved, enhanced sample present, not yet sent) and emails the restaurant
// their enhanced photo plus the conversion link. Runs on the reply-poll cadence.
//
// Gated by OUTREACH_ENABLED like Touch 1 — even though this is a solicited
// message, we keep all Gmail sending behind one switch during testing.

import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants, outreachJobs } from "@/db/schema";
import { config } from "../config";
import { getSetting } from "@/lib/settings";
import { sendEmail, getThreadTail } from "../lib/gmail";
import { composeTouch2, senderName } from "../lib/outreachEmail";
import { withRetry } from "../lib/retry";

// The conversation this restaurant is already in. Touch 1 and the bump share a
// thread, so the most recent job with a thread id points at the right one.
// Returns nulls on any failure — a missing thread must never block delivery of
// a photo someone is waiting for; we just send it standalone instead.
async function threadToReplyInto(
  restaurantId: number
): Promise<{ threadId: string | null; inReplyTo: string | null }> {
  const [prior] = await db
    .select({ threadId: outreachJobs.gmailThreadId })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.restaurantId, restaurantId), isNotNull(outreachJobs.gmailThreadId)))
    .orderBy(desc(outreachJobs.sentAt))
    .limit(1);

  if (!prior?.threadId) return { threadId: null, inReplyTo: null };

  try {
    const { messageId } = await getThreadTail(prior.threadId);
    return { threadId: prior.threadId, inReplyTo: messageId };
  } catch (err) {
    console.warn(`[touch2] thread lookup failed for ${prior.threadId}:`, err instanceof Error ? err.message : err);
    return { threadId: prior.threadId, inReplyTo: null };
  }
}

export async function runSendTouch2(): Promise<void> {
  if (await getSetting("outreach_paused")) {
    console.warn("[touch2] outreach_paused — skipping.");
    return;
  }
  const enabled = process.env.OUTREACH_ENABLED === "true" && !config.dryRun;

  const ready = await db
    .select()
    .from(magicLinks)
    .where(
      and(
        eq(magicLinks.reviewStatus, "approved"),
        isNotNull(magicLinks.freeSampleEnhancedUrl),
        isNull(magicLinks.touch2SentAt)
      )
    );

  if (ready.length === 0) return;
  console.log(`[touch2] ${ready.length} approved sample(s) ready (sending ${enabled ? "ENABLED" : "DISABLED — log only"})`);

  for (const link of ready) {
    if (link.restaurantId == null) continue;
    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, link.restaurantId)).limit(1);
    if (!r || !r.email) continue;

    const language = r.language ?? "en";
    const magicLinkUrl = `${config.appOrigin.replace(/\/$/, "")}/l/${link.token}`;
    const { subject, body } = composeTouch2({
      restaurantName: r.name,
      firstName: r.contactFirstName,
      dish: r.signatureDish ?? (language === "es" ? "plato" : "dish"),
      funnelUrl: magicLinkUrl,
      bookingUrl: process.env.NEXT_PUBLIC_BOOKING_URL ?? null,
      language,
    });

    if (!enabled) {
      console.log(`[touch2] (dry) -> ${r.email} | ${magicLinkUrl}`);
      continue;
    }

    try {
      // Land in the thread they replied in. The approved Touch 2 subject is
      // kept as-is (it's locked copy) — In-Reply-To/References carry the
      // threading, and Gmail additionally honours threadId directly.
      const { threadId, inReplyTo } = await threadToReplyInto(r.id);
      const sent = await withRetry(
        () =>
          sendEmail({
            to: r.email!,
            subject,
            body,
            fromName: senderName(),
            threadId: threadId ?? undefined,
            inReplyTo,
          }),
        { label: `gmail touch2 ${r.email}`, attempts: 2 }
      );
      await db.update(magicLinks).set({ touch2SentAt: new Date() }).where(eq(magicLinks.id, link.id));
      await db.insert(outreachJobs).values({
        restaurantId: r.id,
        touchNumber: 2,
        emailContent: body,
        sentAt: new Date(),
        status: "sent",
        gmailMessageId: sent.id,
        gmailThreadId: sent.threadId,
      });
      console.log(`[touch2] sent -> ${r.email} (${r.name})`);
    } catch (err) {
      console.error(`[touch2] FAILED -> ${r.email}:`, err instanceof Error ? err.message : err);
    }
  }
}
