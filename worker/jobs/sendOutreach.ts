// Touch 1 job (nightly). Two phases in one run:
//   1. draftBatch()   — pick the highest-priority queued restaurants and write
//                       a DRAFT outreach row (composed email, not sent). A human
//                       approves drafts in /admin. When outreach_autosend is on,
//                       drafts are written already-approved so phase 2 sends them.
//   2. sendApproved() — send every approved-but-unsent draft via Gmail, respecting
//                       the daily ramp, the pause switch, and the deliverability guard.
//
// SAFETY layers: WORKER_DRY_RUN makes both phases inert (log only, no writes);
// OUTREACH_ENABLED gates real Gmail sending (drafting still runs so you can review
// real drafts first); the outreach_paused DB setting is a panic button on sending.

import { and, asc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, suppressions } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { getSetting } from "@/lib/settings";
import { config } from "../config";
import { sendEmail } from "../lib/gmail";
import { composeTouch1, hasComplianceFooter, normalizeLanguage, type ComposeIdentity } from "../lib/outreachEmail";
import { isSuppressed } from "../lib/suppression";
import { withRetry } from "../lib/retry";
import { isInLocalWindow } from "../lib/sendWindow";

// Max real sends per send-cron tick, per send function. The daily total is
// still bounded by dailyCap()/sentToday(); this just spreads that total across
// the business-hours window instead of emptying the whole approved pile in the
// first in-window tick (a burst from one Gmail account hurts deliverability).
// With the send cron at */20 and a ~3h window (~9 ticks), 6/tick drains a
// 50-cap day comfortably inside the window. Exported so the bump sender shares
// the exact same per-tick ceiling.
export const SEND_BATCH_PER_TICK = 6;

// Domain has been warming on Lemwarm ~1 month, so we start at 30/day rather
// than the cautious 20, still ramping toward the cap.
const RAMP_START = 30;
const RAMP_STEP = 5;
const RAMP_CAP = 50;

// Exposed so the worker can report the live ramp in its boot-info snapshot.
export const RAMP = { start: RAMP_START, step: RAMP_STEP, cap: RAMP_CAP };

// How many Touch 1 drafts may sit awaiting review at once. DELIBERATELY separate
// from the daily SEND cap: in manual-approval mode a human wants to review a full
// batch of drafts up front, while sendApproved() still throttles actual sends to
// dailyCap()/day. (Previously drafting was bounded by the send cap, which froze
// the review pile at ~cap whenever sending was paused.) A ceiling, not a target —
// it just stops the pile growing without bound if drafts never get actioned.
const DRAFT_REVIEW_CAP = 200;

// How many NEW Touch-1 drafts to stage per day in manual-approval mode — the
// size of the fresh batch that lands in your approvals queue each night. The
// point of the photo-fit gates is that this batch is now mostly leads you'll
// actually want, so a tight number beats a 200-deep pile. Best-first (by
// priority), so you always see the strongest leads. Tunable without a deploy via
// the `outreach_daily_draft_target` app-setting; falls back to this default.
const DEFAULT_DAILY_DRAFT_TARGET = 20;

async function dailyDraftTarget(): Promise<number> {
  const override = await getSetting("outreach_daily_draft_target");
  return typeof override === "number" && override > 0 ? Math.floor(override) : DEFAULT_DAILY_DRAFT_TARGET;
}

// New Touch-1 drafts composed so far today (bumps excluded — different budget).
async function draftedToday(): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(and(eq(outreachJobs.kind, "touch1"), gte(outreachJobs.draftedAt, startOfToday())));
  return n ?? 0;
}

function startOfToday(): Date {
  // Midnight AST, the day boundary the whole admin UI displays against — NOT
  // server-local (Railway runs UTC, so `new Date(y,m,d)` used to roll the
  // daily cap over at 8pm AST, mid-evening). AST is UTC-4 year-round (Puerto
  // Rico, no DST), so shift the wall clock back 4h to find "today" in AST,
  // then 00:00 AST of that date is 04:00 UTC. Note: Date.now()/new Date() are
  // fine at runtime in the worker (only the Workflow tool forbids them).
  const ast = new Date(Date.now() - 4 * 3_600_000);
  return new Date(Date.UTC(ast.getUTCFullYear(), ast.getUTCMonth(), ast.getUTCDate(), 4, 0, 0));
}

// Daily cap ramps 20 -> 50 over a week+ of sending, protecting deliverability.
// Exported so the bump sender shares the SAME cap — the sending domain cares
// about total emails/day, not the Touch 1 vs. bump split.
export async function dailyCap(): Promise<number> {
  // A manual override in app_settings wins over the ramp formula. Handy when
  // you want to throttle during list-warmup or open the tap all the way on a
  // proven list. Positive int only — null means "use the formula".
  const override = await getSetting("outreach_daily_cap");
  if (typeof override === "number" && override > 0) return Math.floor(override);

  const [{ first }] = await db
    .select({ first: sql<Date | null>`min(${outreachJobs.sentAt})` })
    .from(outreachJobs);
  if (!first) return RAMP_START;
  const days = Math.floor((Date.now() - new Date(first).getTime()) / 86_400_000);
  return Math.min(RAMP_CAP, RAMP_START + RAMP_STEP * days);
}

// Counts BOTH Touch 1 and bump sends today (both carry touchNumber 1), so the
// shared daily cap covers total volume. Exported for the bump sender.
export async function sentToday(): Promise<number> {
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

// Exported so /admin/controls can compute and display the same rate + verdict
// without going near the send loop.
export const DELIVERABILITY = { sampleMin: SUPPRESSION_SAMPLE_MIN, rateMax: SUPPRESSION_RATE_MAX };

// Throttle for the deliverability alert — see the comment at its send site.
const DELIVERABILITY_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
let lastDeliverabilityAlertAt = 0;

// Exported so other send phases (bump) can gate on the same guard without
// duplicating it.
export async function deliverabilityHealthy(): Promise<boolean> {
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
    // Alert at most once every 6 hours. This guard trips on EVERY run while the
    // condition holds, and the condition persists until a human intervenes — so
    // once the send job moved from daily to every 20 minutes (2026-08-24), an
    // un-throttled alert would have sent 72 identical emails a day and buried
    // the signal it exists to raise. Same in-memory cooldown shape as
    // maybeAlertApiError in worker/lib/anthropic.ts; the worker is long-lived,
    // and a reboot re-arming the alert is acceptable. Sending still stops every
    // run regardless of whether the alert fires.
    const now = Date.now();
    if (now - lastDeliverabilityAlertAt >= DELIVERABILITY_ALERT_COOLDOWN_MS) {
      lastDeliverabilityAlertAt = now;
      await sendAlert(
        "Outreach auto-paused — high opt-out/bounce rate",
        `Suppression rate over the last 7 days is ${(rate * 100).toFixed(1)}% ` +
          `(${supp}/${sends}), above the ${SUPPRESSION_RATE_MAX * 100}% threshold. ` +
          "Touch 1 sending is paused until this clears. Review the list and copy before resuming."
      ).catch(() => {}); // an alert failure must not mask the pause itself
    }
    return false;
  }
  return true;
}

export async function runSendOutreach(): Promise<void> {
  const autosend = await getSetting("outreach_autosend");
  await draftBatch(autosend);
  await sendApproved();
}

// How many touch-1 rows are already drafted or approved-but-unsent — the review
// pile. Subtracting these from the cap keeps the pile bounded at ~cap so it
// can't grow without limit while approvals lag.
async function pendingCount(): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outreachJobs)
    .where(
      and(
        // kind, not touchNumber — a pending BUMP also carries touchNumber 1 and
        // must not eat into Touch 1's own drafting budget.
        eq(outreachJobs.kind, "touch1"),
        isNull(outreachJobs.sentAt),
        sql`${outreachJobs.status} in ('draft','approved')`
      )
    );
  return n ?? 0;
}

// Phase 1: compose drafts for the top queued restaurants. Writes nothing in a
// dry run (fixes the old quirk where suppress/needs_manual_email mutations still
// fired). Restaurants stay `queued` while drafted — the NOT EXISTS guard below
// stops a second run from drafting them again.
async function draftBatch(autosend: boolean): Promise<void> {
  const pending = await pendingCount();

  // Two regimes:
  //  - Manual approval (default): stage a full batch for review up to
  //    DRAFT_REVIEW_CAP, independent of the daily send cap — sendApproved()
  //    throttles the actual sends, so a human can work a big pile at their pace.
  //  - Autosend: a draft is written already-approved and WILL send, so pace
  //    drafting to the daily send cap. Otherwise one run would auto-approve up
  //    to DRAFT_REVIEW_CAP emails at once and bank a large backlog that sends
  //    (composed against a possibly-since-changed template) days later.
  let room: number;
  if (autosend) {
    const cap = await dailyCap();
    const already = await sentToday();
    room = Math.max(0, cap - already - pending);
  } else {
    // Manual mode: stage at most `target` NEW drafts today (best-first), and never
    // let the review pile exceed DRAFT_REVIEW_CAP overall. Both bounds apply.
    const target = await dailyDraftTarget();
    const madeToday = await draftedToday();
    room = Math.max(0, Math.min(DRAFT_REVIEW_CAP - pending, target - madeToday));
  }

  console.log(
    `[draft] pending ${pending}, drafting up to ${room}` +
      (autosend ? " [AUTOSEND — paced to daily cap]" : ` [manual — daily target / ${DRAFT_REVIEW_CAP} pile cap]`) +
      (config.dryRun ? " [DRY RUN — no writes]" : "")
  );
  if (room === 0) return;

  // Fetched once per batch, not per restaurant — one round-trip, and every
  // restaurant in this run composes against the identical template/identity.
  const [template, nodishTemplate, senderNameSetting, postalAddressSetting, signatureSetting] = await Promise.all([
    getSetting("outreach_touch1_template"),
    getSetting("outreach_touch1_nodish_template"),
    getSetting("outreach_sender_name"),
    getSetting("outreach_postal_address"),
    getSetting("outreach_signature"),
  ]);
  const identity: ComposeIdentity = { senderName: senderNameSetting, postalAddress: postalAddressSetting, signature: signatureSetting };

  const candidates = await db
    .select()
    .from(restaurants)
    .where(
      and(
        eq(restaurants.enrichmentStatus, "queued"),
        eq(restaurants.suppressed, false),
        eq(restaurants.held, false),
        isNotNull(restaurants.email),
        // No LIVE touch-1 row (drafted/approved/sent) for this EMAIL — don't
        // double-draft. Keyed on the address, not the restaurant id, because two
        // sibling locations routinely share one mailbox: caught 2026-08-24, when
        // Emiliano's Restaurant and La Casa De Los Pollos Rostizados both reached
        // `contacted` on foodemilianos3324@gmail.com (that owner got two cold
        // opens from us), and Kitchen Mouse Cafe + Kitchen Mouse The Bakery were
        // both drafted to info@kitchenmousela.com. One inbox, one cold open —
        // anything else reads as spam and burns the domain's reputation.
        // A `cancelled` row is excluded so un-holding a restaurant whose draft
        // was cancelled at send time can produce a fresh Touch 1.
        sql`not exists (
          select 1 from ${outreachJobs} o
          join ${restaurants} r2 on r2.id = o.restaurant_id
          where o.touch_number = 1 and o.status <> 'cancelled'
            and lower(r2.email) = lower(${restaurants.email})
        )`
      )
    )
    .orderBy(sql`${restaurants.priorityScore} desc nulls last`)
    .limit(room);

  // The query above can't see rows this same loop is about to create, so two
  // candidates sharing a mailbox would both pass it. Track what we've drafted
  // to in this batch and skip the second one.
  const draftedTo = new Set<string>();

  for (const r of candidates) {
    const email = r.email!;

    if (draftedTo.has(email.toLowerCase())) {
      console.log(`[draft] skip ${r.name} — ${email} already drafted to earlier in this batch`);
      continue;
    }

    if (await isSuppressed(email)) {
      if (!config.dryRun) await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, r.id));
      console.log(`[draft] skip ${email} — suppressed`);
      continue;
    }

    // Leads WITH a dish get the dish-personalized template; leads without one
    // get the no-dish template (the dish copy would read wrong for them). Both
    // are editable on /admin/photo/templates.
    const language = normalizeLanguage(r.language);
    let composed: { subject: string; body: string };
    try {
      composed = composeTouch1({
        restaurantName: r.name,
        firstName: r.contactFirstName,
        dish: r.signatureDish ?? "",
        city: r.city,
        language,
        subjectVariant: r.id,
        template: r.signatureDish ? template : nodishTemplate,
        identity,
      });
    } catch (err) {
      // A malformed template must not take down the whole nightly batch — skip
      // this one restaurant and keep going. Templates are already validated at
      // save time, so this is a last-resort net, not the primary defense.
      console.error(`[draft] compose FAILED for ${r.name} (id ${r.id}):`, err instanceof Error ? err.message : err);
      continue;
    }
    const { subject, body } = composed;

    if (config.dryRun) {
      // Mark it in the dry run too, so the log shows the same skips a real run
      // would perform rather than a rosier picture.
      draftedTo.add(email.toLowerCase());
      console.log(`[draft] (dry) would draft -> ${email} | ${subject}`);
      continue;
    }

    const now = new Date();
    await db.insert(outreachJobs).values({
      restaurantId: r.id,
      touchNumber: 1,
      kind: "touch1",
      subject,
      emailContent: body,
      draftedAt: now,
      status: autosend ? "approved" : "draft",
      approvedAt: autosend ? now : null,
    });
    draftedTo.add(email.toLowerCase());
    console.log(`[draft] ${autosend ? "auto-approved" : "drafted"} -> ${email} (${r.name})`);
  }
}

// Phase 2: send every approved-but-unsent draft, oldest approval first, up to the
// remaining daily cap. Re-checks the safety-critical fields at send time because
// a draft can sit approved for days before this runs.
async function sendApproved(): Promise<void> {
  const cap = await dailyCap();
  const already = await sentToday();
  const remaining = Math.max(0, cap - already);

  const enabled = process.env.OUTREACH_ENABLED === "true" && !config.dryRun;

  // kind, not touchNumber — a bump is ALSO touchNumber 1. Getting this wrong
  // would let an approved bump get picked up here and sent via sendEmail() with
  // no threadId: a brand-new, unthreaded cold email duplicating what the
  // recipient already got. Bumps send from sendApprovedBumps() only.
  //
  // Fetch WITHOUT the tight cap limit (a generous 500 guard) so the
  // business-hours filter below has the full approved pile to choose from — if
  // the oldest-approved rows are all out-of-window (e.g. LA leads at 10am AST),
  // limiting to `remaining` first could starve the in-window ones behind them.
  const approved = await db
    .select({ job: outreachJobs, r: restaurants })
    .from(outreachJobs)
    .innerJoin(restaurants, eq(outreachJobs.restaurantId, restaurants.id))
    .where(and(eq(outreachJobs.status, "approved"), eq(outreachJobs.kind, "touch1"), isNull(outreachJobs.sentAt)))
    .orderBy(asc(outreachJobs.approvedAt))
    .limit(500);

  // Business-hours gate: only send to recipients whose LOCAL time is inside
  // the 9am–12pm Mon–Fri window right now. Out-of-window rows aren't cancelled
  // — they simply wait for a later tick when their city's window opens.
  const now = Date.now();
  const inWindow = approved.filter(({ r }) => isInLocalWindow(r.city, now));
  // Then the two volume ceilings: the daily cap headroom and the per-tick cap.
  const ready = inWindow.slice(0, Math.min(remaining, SEND_BATCH_PER_TICK));

  console.log(
    `[send] ${approved.length} approved, ${inWindow.length} in send-window, sending ${ready.length} this tick ` +
      `(remaining cap ${remaining} (sending ${enabled ? "ENABLED" : "DISABLED — log only"}))`
  );
  if (ready.length === 0) return;

  if (!enabled) {
    for (const { job, r } of ready) console.log(`[send] (dry) would send -> ${r.email} | ${job.subject}`);
    return;
  }

  if (await getSetting("outreach_paused")) {
    console.warn("[send] outreach_paused — skipping all sends this run.");
    return;
  }

  // Auto-pause if the domain's opt-out/bounce rate has spiked. Runs at SEND time,
  // so an approved batch reviewed days later still passes through the guard.
  if (!(await deliverabilityHealthy())) {
    console.warn("[send] paused this run — deliverability guard tripped.");
    return;
  }

  const senderNameSetting = await getSetting("outreach_sender_name");

  for (const { job, r } of ready) {
    const email = r.email;
    // Re-check the fields that can change between draft and send.
    if (!email || r.suppressed || r.held || (await isSuppressed(email))) {
      await db.update(outreachJobs).set({ status: "cancelled" }).where(eq(outreachJobs.id, job.id));
      console.log(`[send] cancelled draft ${job.id} (${r.name}) — suppressed/held/no email`);
      continue;
    }

    // Pre-send CAN-SPAM guard. Catches any way the footer could be missing by
    // the time a draft reaches send — a hand-edit via set_content that deleted
    // it, a postal address that was never configured, anything — and refuses
    // to send rather than ship a non-compliant email. Nothing checked this
    // before; sendApproved() sent job.emailContent verbatim.
    if (!job.emailContent || !hasComplianceFooter(job.emailContent)) {
      await db.update(outreachJobs).set({ status: "cancelled" }).where(eq(outreachJobs.id, job.id));
      await sendAlert(
        "Blocked send — missing CAN-SPAM footer",
        `Touch 1 to ${email} (${r.name}) was cancelled instead of sent: its body is missing the postal ` +
          `address or the STOP opt-out line. Check the postal address and Touch 1 template on ` +
          `/admin/photo/templates, then redraft.`
      );
      console.error(`[send] BLOCKED draft ${job.id} (${r.name}) — missing compliance footer`);
      continue;
    }

    try {
      const sent = await withRetry(
        () => sendEmail({ to: email, subject: job.subject ?? "", body: job.emailContent ?? "", fromName: senderNameSetting }),
        { label: `gmail touch1 ${email}`, attempts: 2 }
      );
      // ONE update flips the row to sent + sets all three ids together — the
      // invariant every downstream consumer relies on.
      await db
        .update(outreachJobs)
        .set({ status: "sent", sentAt: new Date(), gmailMessageId: sent.id, gmailThreadId: sent.threadId })
        .where(eq(outreachJobs.id, job.id));
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
