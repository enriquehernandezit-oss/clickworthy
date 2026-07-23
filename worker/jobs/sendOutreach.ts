// Touch 1 send job (nightly). Picks the highest-priority queued restaurants
// that have a contactable email, respects a daily volume ramp, and sends the
// cold email via Gmail. Recording each send in `outreachJobs` (with Gmail
// message + thread ids) is what lets the reply poller match replies later.
//
// SAFETY: sending is OFF unless OUTREACH_ENABLED=true. With it off (the default)
// this logs exactly what it WOULD send and changes nothing — so the pipeline is
// fully testable before real cold email goes out, and before Jose's approved
// Touch 1 copy replaces the generated placeholder.

import { and, desc, eq, gte, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, suppressions } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { config } from "../config";
import { sendEmail } from "../lib/gmail";
import { generateTouch1Body } from "../lib/anthropic";
import { composeTouch1 } from "../lib/outreachEmail";
import { isSuppressed } from "../lib/suppression";
import { withRetry } from "../lib/retry";

const RAMP_START = 20;
const RAMP_STEP = 5;
const RAMP_CAP = 50;

function startOfToday(): Date {
  // Note: Date.now()/new Date() are fine at runtime in the worker (this is not a
  // workflow script); only the Workflow tool forbids them.
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// Daily cap ramps 20 -> 50 over a week+ of sending, protecting deliverability.
async function dailyCap(): Promise<number> {
  const [{ first }] = await db
    .select({ first: sql<Date | null>`min(${outreachJobs.sentAt})` })
    .from(outreachJobs);
  if (!first) return RAMP_START;
  const days = Math.floor((Date.now() - new Date(first).getTime()) / 86_400_000);
  return Math.min(RAMP_CAP, RAMP_START + RAMP_STEP * days);
}

async function sentToday(): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), gte(outreachJobs.sentAt, startOfToday())));
  return n ?? 0;
}

// Deliverability guard: if too many recent recipients opted out or bounced,
// something is off (bad list, spammy copy) — auto-pause sending and alert
// rather than keep burning the domain's reputation. Only kicks in once there's
// a meaningful sample.
const SUPPRESSION_SAMPLE_MIN = 20;
const SUPPRESSION_RATE_MAX = 0.08; // 8%

async function deliverabilityHealthy(): Promise<boolean> {
  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const [{ sends }] = await db
    .select({ sends: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.touchNumber, 1), gte(outreachJobs.sentAt, weekAgo)));
  if ((sends ?? 0) < SUPPRESSION_SAMPLE_MIN) return true; // not enough data yet

  const [{ supp }] = await db
    .select({ supp: sql<number>`count(*)::int` })
    .from(suppressions)
    .where(gte(suppressions.createdAt, weekAgo));

  const rate = (supp ?? 0) / (sends ?? 1);
  if (rate > SUPPRESSION_RATE_MAX) {
    await sendAlert(
      "Outreach auto-paused — high opt-out/bounce rate",
      `Suppression rate over the last 7 days is ${(rate * 100).toFixed(1)}% ` +
        `(${supp}/${sends}), above the ${SUPPRESSION_RATE_MAX * 100}% threshold. ` +
        "Touch 1 sending is paused this run. Review the list and copy before resuming."
    );
    return false;
  }
  return true;
}

export async function runSendOutreach(): Promise<void> {
  const cap = await dailyCap();
  const already = await sentToday();
  const remaining = Math.max(0, cap - already);

  const enabled = process.env.OUTREACH_ENABLED === "true" && !config.dryRun;
  console.log(
    `[send] daily cap ${cap}, already sent ${already}, remaining ${remaining} ` +
      `(sending ${enabled ? "ENABLED" : "DISABLED — log only"})`
  );
  if (remaining === 0) return;

  // Auto-pause if the domain's opt-out/bounce rate has spiked.
  if (enabled && !(await deliverabilityHealthy())) {
    console.warn("[send] paused this run — deliverability guard tripped.");
    return;
  }

  const candidates = await db
    .select()
    .from(restaurants)
    .where(
      and(
        eq(restaurants.enrichmentStatus, "queued"),
        eq(restaurants.suppressed, false),
        isNotNull(restaurants.email)
      )
    )
    .orderBy(desc(restaurants.priorityScore))
    .limit(remaining);

  for (const r of candidates) {
    const email = r.email!;
    if (await isSuppressed(email)) {
      await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, r.id));
      continue;
    }

    const language = r.language ?? "en";
    const generatedBody = await generateTouch1Body({
      name: r.name,
      city: r.city ?? "",
      rating: r.rating,
      reviewCount: r.reviewCount,
      language,
      worstCategory: null,
    });
    const { subject, body } = composeTouch1({ restaurantName: r.name, generatedBody, language });

    if (!enabled) {
      console.log(`[send] (dry) -> ${email} | ${subject}`);
      continue;
    }

    try {
      const sent = await withRetry(() => sendEmail({ to: email, subject, body, fromName: "Clickworthy" }), {
        label: `gmail touch1 ${email}`,
        attempts: 2,
      });
      await db.insert(outreachJobs).values({
        restaurantId: r.id,
        touchNumber: 1,
        emailContent: body,
        sentAt: new Date(),
        status: "sent",
        gmailMessageId: sent.id,
        gmailThreadId: sent.threadId,
      });
      await db
        .update(restaurants)
        .set({ enrichmentStatus: "contacted", lastContactedAt: new Date() })
        .where(eq(restaurants.id, r.id));
      console.log(`[send] sent -> ${email} (${r.name})`);
    } catch (err) {
      console.error(`[send] FAILED -> ${email} (${r.name}):`, err instanceof Error ? err.message : err);
    }
  }
}
