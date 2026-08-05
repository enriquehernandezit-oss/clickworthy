// Touch 1.5 bump. One-time, same-thread follow-up to a Touch 1 that got no
// reply after 3–4 days. The approved copy promises we won't follow up again, so
// the one-bump-max guard is enforced here: we only bump restaurants that have a
// Touch 1 but no bump row yet. Runs on the reply-cycle cadence.

import { and, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { config } from "../config";
import { getSetting } from "@/lib/settings";
import { sendEmail, getThreadingInfo } from "../lib/gmail";
import { composeBump } from "../lib/outreachEmail";
import { isSuppressed } from "../lib/suppression";
import { withRetry } from "../lib/retry";

const BUMP_AFTER_DAYS = 3;

export async function runSendBumps(): Promise<void> {
  if (await getSetting("outreach_paused")) {
    console.warn("[bump] outreach_paused — skipping.");
    return;
  }
  const enabled = process.env.OUTREACH_ENABLED === "true" && !config.dryRun;
  const cutoff = new Date(Date.now() - BUMP_AFTER_DAYS * 86_400_000);

  // Touch 1 rows older than the cutoff, never replied, whose restaurant has no
  // bump row yet and isn't suppressed.
  const due = await db
    .select({
      jobId: outreachJobs.id,
      restaurantId: outreachJobs.restaurantId,
      threadId: outreachJobs.gmailThreadId,
      messageId: outreachJobs.gmailMessageId,
    })
    .from(outreachJobs)
    .where(
      and(
        eq(outreachJobs.touchNumber, 1),
        eq(outreachJobs.status, "sent"), // 'bumped'/'replied' excluded
        isNull(outreachJobs.repliedAt),
        lte(outreachJobs.sentAt, cutoff)
      )
    );

  if (due.length === 0) return;
  console.log(`[bump] ${due.length} candidate(s) (sending ${enabled ? "ENABLED" : "DISABLED — log only"})`);

  for (const row of due) {
    if (row.restaurantId == null) continue;

    // One bump ever: skip if any bump row already exists for this restaurant.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(outreachJobs)
      .where(and(eq(outreachJobs.restaurantId, row.restaurantId), eq(outreachJobs.status, "bumped")));
    if ((n ?? 0) > 0) continue;

    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, row.restaurantId)).limit(1);
    if (!r || !r.email || r.suppressed) continue;
    if (await isSuppressed(r.email)) continue;

    const language = r.language ?? "en";
    const body = composeBump({ firstName: r.contactFirstName, language });

    if (!enabled) {
      console.log(`[bump] (dry) -> ${r.email}`);
      continue;
    }

    try {
      const { messageId: inReplyTo, subject: originalSubject } = row.messageId
        ? await getThreadingInfo(row.messageId)
        : { messageId: null, subject: null };
      // Same thread as the original Touch 1: threadId + In-Reply-To/References
      // handle Gmail-to-Gmail threading; a proper "Re: ..." subject (rather than
      // empty) keeps it threaded in non-Gmail clients too, which key off Subject.
      const subject = originalSubject
        ? originalSubject.toLowerCase().startsWith("re:")
          ? originalSubject
          : `Re: ${originalSubject}`
        : "";
      const sent = await withRetry(
        () =>
          sendEmail({
            to: r.email!,
            subject,
            body,
            fromName: "Clickworthy",
            threadId: row.threadId ?? undefined,
            inReplyTo,
          }),
        { label: `gmail bump ${r.email}`, attempts: 2 }
      );
      await db.insert(outreachJobs).values({
        restaurantId: r.id,
        touchNumber: 1,
        emailContent: body,
        sentAt: new Date(),
        status: "bumped",
        gmailMessageId: sent.id,
        gmailThreadId: sent.threadId,
      });
      console.log(`[bump] sent -> ${r.email} (${r.name})`);
    } catch (err) {
      console.error(`[bump] FAILED -> ${r.email}:`, err instanceof Error ? err.message : err);
    }
  }
}
