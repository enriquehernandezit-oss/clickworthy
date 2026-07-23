// Touch 2 sender. Picks up magic links a human APPROVED in /admin (review_status
// = approved, enhanced sample present, not yet sent) and emails the restaurant
// their enhanced photo plus the conversion link. Runs on the reply-poll cadence.
//
// Gated by OUTREACH_ENABLED like Touch 1 — even though this is a solicited
// message, we keep all Gmail sending behind one switch during testing.

import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks, restaurants, outreachJobs } from "@/db/schema";
import { config } from "../config";
import { sendEmail } from "../lib/gmail";
import { composeTouch2 } from "../lib/outreachEmail";
import { withRetry } from "../lib/retry";

export async function runSendTouch2(): Promise<void> {
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
    const { subject, body } = composeTouch2({ restaurantName: r.name, magicLinkUrl, language });

    if (!enabled) {
      console.log(`[touch2] (dry) -> ${r.email} | ${magicLinkUrl}`);
      continue;
    }

    try {
      const sent = await withRetry(() => sendEmail({ to: r.email!, subject, body, fromName: "Clickworthy" }), {
        label: `gmail touch2 ${r.email}`,
        attempts: 2,
      });
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
