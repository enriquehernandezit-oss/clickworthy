// Weekly pipeline report, emailed to the operator. A cheap way to keep a pulse
// on the funnel without opening the DB: how many leads sourced, how many
// contacted, reply rate, samples awaiting review, packages sold.

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks, suppressions } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";

export async function runWeeklyStats(): Promise<void> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);

  const byStatus = await db
    .select({ status: restaurants.enrichmentStatus, n: sql<number>`count(*)::int` })
    .from(restaurants)
    .groupBy(restaurants.enrichmentStatus);

  const [{ sent }] = await db
    .select({ sent: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), gte(outreachJobs.sentAt, weekAgo)));

  const [{ replied }] = await db
    .select({ replied: sql<number>`count(*) filter (where ${outreachJobs.repliedAt} >= ${weekAgo})::int` })
    .from(outreachJobs);

  const [{ pendingReview }] = await db
    .select({ pendingReview: sql<number>`count(*)::int` })
    .from(magicLinks)
    .where(eq(magicLinks.reviewStatus, "pending_review"));

  const [{ paid }] = await db
    .select({ paid: sql<number>`count(*) filter (where ${magicLinks.paidAt} is not null)::int` })
    .from(magicLinks);

  const [{ supp }] = await db
    .select({ supp: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(gte(suppressions.createdAt, weekAgo));

  const replyRate = (sent ?? 0) > 0 ? (((replied ?? 0) / (sent ?? 1)) * 100).toFixed(1) : "n/a";

  const body = [
    "Clickworthy — weekly pipeline report",
    "",
    "Restaurants by status:",
    ...byStatus.map((s) => `  ${s.status ?? "unknown"}: ${s.n}`),
    "",
    `Touch 1 sent (7d): ${sent ?? 0}`,
    `Replies (7d): ${replied ?? 0}  (reply rate ${replyRate}%)`,
    `Samples awaiting review: ${pendingReview ?? 0}`,
    `Packages paid (all time): ${paid ?? 0}`,
    `New suppressions (7d): ${supp ?? 0}`,
  ].join("\n");

  await sendAlert("Weekly pipeline report", body);
  console.log("[stats] weekly report sent");
}
