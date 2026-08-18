// Nightly sourcing health report, emailed to the operator a couple hours after
// the sourcing cron (so per-restaurant enrichment has finished). Tells you at a
// glance whether the run worked WITHOUT opening the DB: how many leads were
// sourced, how many got a verified email (NeverBounce health), how many got an
// owner-photo score / signature dish (scoring health), and the status split.
//
// Complements the existing "sourcing found no new restaurants" alert (which
// fires immediately on a zero-lead run) — this is the positive daily heartbeat.

import { gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { config } from "../config";

export { SOURCING_REPORT_QUEUE } from "@/lib/queues";

export async function runSourcingReport(): Promise<void> {
  const { subject, body, sourced, verified } = await buildSourcingReport();
  await sendAlert(subject, body);
  console.log(`[report] nightly sourcing report sent (${sourced} sourced, ${verified} verified)`);
}

// Split from the send so the content can be previewed/tested without emailing.
export async function buildSourcingReport(): Promise<{
  subject: string;
  body: string;
  sourced: number;
  verified: number;
}> {
  const hours = config.sourcingReportLookbackHours;
  // gte() with a Date, not an interpolated sql`` template — the driver can't
  // serialize a Date dropped into a raw template (see weeklyStats.ts).
  const since = new Date(Date.now() - hours * 3_600_000);

  const [agg] = await db
    .select({
      n: sql<number>`count(*)::int`,
      withEmail: sql<number>`count(${restaurants.email})::int`,
      withScore: sql<number>`count(${restaurants.avgPhotoScore})::int`,
      withDish: sql<number>`count(${restaurants.signatureDish})::int`,
    })
    .from(restaurants)
    .where(gte(restaurants.createdAt, since));

  const byStatus = await db
    .select({ status: restaurants.enrichmentStatus, n: sql<number>`count(*)::int` })
    .from(restaurants)
    .where(gte(restaurants.createdAt, since))
    .groupBy(restaurants.enrichmentStatus);

  const [{ queued }] = await db
    .select({ queued: sql<number>`count(*)::int` })
    .from(restaurants)
    .where(sql`${restaurants.enrichmentStatus} = 'queued'`);

  const verdict =
    agg.n === 0
      ? "No new leads — the cron may not have run, the target cities are tapped out, or Places is failing. Check the worker logs."
      : agg.withEmail === 0
        ? `${agg.n} sourced but 0 verified emails — NeverBounce or email discovery may be failing. Investigate before trusting the run.`
        : `${agg.n} sourced, ${agg.withEmail} with verified emails, ${agg.withScore} photo-scored — pipeline looks healthy.`;

  const body = [
    `Clickworthy — nightly sourcing report (leads sourced in the last ${hours}h)`,
    "",
    verdict,
    "",
    `Sourced:             ${agg.n}`,
    `With verified email: ${agg.withEmail}   (NeverBounce working if > 0)`,
    `With photo score:    ${agg.withScore}   (owner-photo scoring)`,
    `With signature dish: ${agg.withDish}`,
    "",
    "New leads by status:",
    ...byStatus
      .sort((a, b) => Number(b.n) - Number(a.n))
      .map((s) => `  ${s.status ?? "unknown"}: ${s.n}`),
    "",
    `Total queued (all time): ${queued}`,
  ].join("\n");

  return { subject: "Nightly sourcing report", body, sourced: agg.n, verified: agg.withEmail };
}
