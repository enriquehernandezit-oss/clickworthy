// Touch 1.5 bump. One-time, same-thread follow-up to a Touch 1 that got no
// reply after 3-4 days. Two phases, mirroring sendOutreach.ts's Touch 1 shape:
//   1. draftBumps()        — compose a DRAFT bump for each eligible restaurant.
//                            Never sends — a human approves or denies it in
//                            Approvals. The approved copy promises we won't
//                            follow up again, so the one-bump-EVER guard blocks
//                            re-drafting once ANY bump row exists for a
//                            restaurant, in any status (including denied).
//   2. sendApprovedBumps() — send every approved-but-unsent bump, resolving the
//                            thread fresh at send time (drafting and approval
//                            can be days apart).

import { and, asc, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs } from "@/db/schema";
import { config } from "../config";
import { getSetting } from "@/lib/settings";
import { sendAlert } from "@/lib/alerts";
import { sendEmail } from "../lib/gmail";
import { threadToReplyInto } from "./sendTouch2";
import { deliverabilityHealthy, dailyCap, sentToday, approvedTouch1Pending } from "./sendOutreach";
import { composeBump, hasComplianceFooter, normalizeLanguage, type ComposeIdentity } from "../lib/outreachEmail";
import { isSuppressed } from "../lib/suppression";
import { withRetry } from "../lib/retry";
import { isInLocalWindow } from "../lib/sendWindow";

const BUMP_AFTER_DAYS_DEFAULT = 3;

// Per-tick send cap for bumps — SEPARATE from Touch 1's (do NOT reuse
// SEND_BATCH_PER_TICK=6, which is sized for the 20-min send cron). Bumps run
// on the reply-poll cron every 4 minutes (5x faster), so 6/tick there would
// empty a 50/day cap in ~36 min — a burst the per-tick cap exists to prevent.
// 2/tick on a */4 cron = at most 1 send/2min, ~30/hour, well-paced across the
// business-hours window while the shared daily cap still bounds the total.
const BUMP_BATCH_PER_TICK = 2;

export async function runSendBumps(): Promise<void> {
  await draftBumps();
  await sendApprovedBumps();
}

// Phase 1: compose a draft bump for each Touch-1-sent, never-replied,
// past-cutoff restaurant that doesn't already have a bump row. Never sends.
async function draftBumps(): Promise<void> {
  const configured = await getSetting("bump_after_days");
  const days = Number.isFinite(configured) && configured > 0 ? configured : BUMP_AFTER_DAYS_DEFAULT;
  const cutoff = new Date(Date.now() - days * 86_400_000);

  // kind, not just touchNumber/status — once a bump itself has been sent, it
  // ALSO carries touchNumber 1 + status 'sent', and without this it would
  // reappear here as a false "candidate" on every later run (the one-bump-ever
  // guard below would still catch it, but there's no reason to rely on that
  // backstop when the root query can just be precise).
  const due = await db
    .select({ restaurantId: outreachJobs.restaurantId })
    .from(outreachJobs)
    .where(
      and(
        eq(outreachJobs.kind, "touch1"),
        eq(outreachJobs.status, "sent"),
        isNull(outreachJobs.repliedAt),
        lte(outreachJobs.sentAt, cutoff)
      )
    );

  if (due.length === 0) return;
  console.log(`[bump] ${due.length} candidate(s) to review for drafting` + (config.dryRun ? " [DRY RUN — no writes]" : ""));

  const [template, senderNameSetting, postalAddressSetting, signatureSetting] = await Promise.all([
    getSetting("outreach_bump_template"),
    getSetting("outreach_sender_name"),
    getSetting("outreach_postal_address"),
    getSetting("outreach_signature"),
  ]);
  const identity: ComposeIdentity = { senderName: senderNameSetting, postalAddress: postalAddressSetting, signature: signatureSetting };

  for (const row of due) {
    if (row.restaurantId == null) continue;

    // One bump EVER: skip if any bump row already exists for this restaurant,
    // in ANY status. Includes denied/cancelled deliberately — the bump's own
    // copy promises we won't follow up again, and that's a promise worth
    // keeping even past a draft that was denied rather than sent.
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(outreachJobs)
      .where(and(eq(outreachJobs.restaurantId, row.restaurantId), eq(outreachJobs.kind, "bump")));
    if ((n ?? 0) > 0) continue;

    const [r] = await db.select().from(restaurants).where(eq(restaurants.id, row.restaurantId)).limit(1);
    if (!r || !r.email || r.suppressed) continue;
    if (await isSuppressed(r.email)) continue;

    const language = normalizeLanguage(r.language);
    let body: string;
    try {
      body = composeBump({
        restaurantName: r.name,
        firstName: r.contactFirstName,
        dish: r.signatureDish ?? (language === "es" ? "plato" : "dish"),
        city: r.city,
        language,
        template,
        identity,
      });
    } catch (err) {
      // This job reruns every 4 minutes — a bad template must skip this one
      // restaurant, not wedge the whole cron forever.
      console.error(`[bump] compose FAILED for ${r.name} (id ${r.id}):`, err instanceof Error ? err.message : err);
      continue;
    }

    if (config.dryRun) {
      console.log(`[bump] (dry) would draft -> ${r.email}`);
      continue;
    }

    await db.insert(outreachJobs).values({
      restaurantId: r.id,
      kind: "bump",
      touchNumber: 1,
      emailContent: body,
      draftedAt: new Date(),
      status: "draft",
    });
    console.log(`[bump] drafted -> ${r.email} (${r.name})`);
  }
}

// Phase 2: send approved-but-unsent bumps, up to the remaining daily cap.
// Re-checks the safety-critical fields at send time because a draft can sit
// approved for days.
async function sendApprovedBumps(): Promise<void> {
  const enabled = process.env.OUTREACH_ENABLED === "true" && !config.dryRun;

  // Bumps share Touch 1's daily cap — same domain, same reputation track, and
  // sentToday() already counts both (both are touchNumber 1). But Touch 1 is
  // the priority path (new email-ready leads), and bumps tick 5x faster (reply
  // cron */4 vs send cron */20), so without reserving headroom a bump backlog
  // could consume the whole cap before Touch 1's tick even fires — zero Touch 1
  // sent that day. So bumps only draw from what's left AFTER every
  // already-approved Touch 1 has a slot. If Touch 1 fills the cap, bumps wait.
  const cap = await dailyCap();
  const already = await sentToday();
  const touch1Reserved = await approvedTouch1Pending();
  const remaining = Math.max(0, cap - already - touch1Reserved);

  if (remaining === 0) {
    console.log(
      `[bump] no bump budget this run — ${already}/${cap} sent today, ${touch1Reserved} approved Touch 1 reserved ahead of bumps.`
    );
    return;
  }

  // Fetch generous, then apply the same business-hours gate + per-tick cap as
  // Touch 1 (see sendApproved). Bumps run on the reply-poll cron (every 4 min,
  // 24/7), so this gate — not a cron window — is what keeps a bump from firing
  // at 6am the recipient's time.
  const approved = await db
    .select({ job: outreachJobs, r: restaurants })
    .from(outreachJobs)
    .innerJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(and(eq(outreachJobs.status, "approved"), eq(outreachJobs.kind, "bump"), isNull(outreachJobs.sentAt)))
    .orderBy(asc(outreachJobs.approvedAt))
    .limit(500);

  const now = Date.now();
  const inWindow = approved.filter(({ r }) => isInLocalWindow(r.city, now));
  const ready = inWindow.slice(0, Math.min(remaining, BUMP_BATCH_PER_TICK));

  console.log(
    `[bump] ${approved.length} approved, ${inWindow.length} in send-window, sending ${ready.length} this tick ` +
      `(bump budget ${remaining} after ${touch1Reserved} Touch 1 reserved; sending ${enabled ? "ENABLED" : "DISABLED — log only"})`
  );
  if (ready.length === 0) return;

  if (!enabled) {
    for (const { job, r } of ready) console.log(`[bump] (dry) would send -> ${r.email} | job ${job.id}`);
    return;
  }

  if (await getSetting("outreach_paused")) {
    console.warn("[bump] outreach_paused — skipping all sends this run.");
    return;
  }

  // Same reputation-track guard Touch 1 uses — bumps share the same sending
  // domain, so a spike in opt-outs/bounces should pause this too.
  if (!(await deliverabilityHealthy())) {
    console.warn("[bump] paused this run — deliverability guard tripped.");
    return;
  }

  const senderNameSetting = await getSetting("outreach_sender_name");

  for (const { job, r } of ready) {
    const email = r.email;
    if (!email || r.suppressed || r.held || (await isSuppressed(email))) {
      await db.update(outreachJobs).set({ status: "cancelled" }).where(eq(outreachJobs.id, job.id));
      console.log(`[bump] cancelled draft ${job.id} (${r.name}) — suppressed/held/no email`);
      continue;
    }

    // Same CAN-SPAM guard as Touch 1, now checked at send time (the bump has
    // no compliance check at draft time — matches Touch 1's own pattern).
    if (!job.emailContent || !hasComplianceFooter(job.emailContent)) {
      await db.update(outreachJobs).set({ status: "cancelled" }).where(eq(outreachJobs.id, job.id));
      await sendAlert(
        "Blocked send — missing CAN-SPAM footer",
        `Bump to ${email} (${r.name}) was cancelled instead of sent: its body is missing the postal ` +
          `address or the STOP opt-out line. Check the postal address and bump template on ` +
          `/admin/photo/templates, then approve a fresh one.`
      );
      console.error(`[bump] BLOCKED draft ${job.id} (${r.name}) — missing compliance footer`);
      continue;
    }

    try {
      // Resolved fresh, not from the original Touch 1 at draft time — drafting
      // and approval can be days apart, so the thread's actual latest state
      // (e.g. a reply that came in since) is what should drive threading. A
      // proper "Re: ..." subject (not just threadId/In-Reply-To) keeps this
      // threaded in non-Gmail clients too, which key off Subject.
      const { threadId, inReplyTo, subject: origSubject } = await threadToReplyInto(r.id);
      const subject = origSubject
        ? origSubject.toLowerCase().startsWith("re:")
          ? origSubject
          : `Re: ${origSubject}`
        : "";
      const sent = await withRetry(
        () =>
          sendEmail({
            to: email,
            subject,
            body: job.emailContent ?? "",
            fromName: senderNameSetting,
            threadId: threadId ?? undefined,
            inReplyTo,
          }),
        { label: `gmail bump ${email}`, attempts: 2 }
      );
      await db
        .update(outreachJobs)
        .set({ status: "sent", sentAt: new Date(), gmailMessageId: sent.id, gmailThreadId: sent.threadId })
        .where(eq(outreachJobs.id, job.id));
      console.log(`[bump] sent -> ${email} (${r.name})`);
    } catch (err) {
      console.error(`[bump] FAILED -> ${email} (${r.name}):`, err instanceof Error ? err.message : err);
    }
  }
}
