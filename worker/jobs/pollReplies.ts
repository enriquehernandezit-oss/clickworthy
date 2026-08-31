// Reply poller (runs every few minutes). Reads the Gmail inbox, matches replies
// back to the outreach thread they answer (Touch 1 or a manual one-off — see
// REPLYABLE_KINDS), and for each first-time reply:
//   - unambiguous opt-out -> suppress, AND alert (never silent — see below).
//   - photo attached  -> store the original, create an awaiting_edit magic link
//                        with a Revenue Impact Card, and alert us to edit it.
//   - no photo        -> record the reply text + alert us to answer it by hand.
// Every branch stores the reply body/sender on the outreach row, so what they
// wrote is readable in /admin instead of living only in Gmail.
//
// Opt-outs are mostly a HUMAN call now. The footer stopped asking people to
// reply "STOP" (see OPT_OUT_LINE in ../lib/outreachEmail.ts), so almost nobody
// sends a keyword — they write a sentence, which lands in the no-photo branch
// for the operator to read and act on from /admin/photo/outreach. isOptOut()
// still auto-suppresses the unambiguous cases ("unsubscribe", "remove me"),
// because honoring those instantly is free and CAN-SPAM-safe.
//
// Dedup is PER MESSAGE (outreachJobs.lastReplyMessageId), not per thread. It
// used to be per-thread only (skip any thread with repliedAt already set) —
// which meant a SECOND message in an already-replied thread matched nothing
// and was silently dropped: no alert, no record, gone. Now a thread that's
// already been replied to still gets checked; only an already-SEEN message id
// is skipped. The pipeline still only auto-processes the FIRST reply (photo ->
// sample, or alert-for-a-human) — anything after that always surfaces as an
// "existing thread" alert rather than trying to auto-create a second sample.
//
// Staleness: this is the ONLY thing that sees a "STOP" reply, and CAN-SPAM
// requires an opt-out be honored within 10 business days. runReplyPoll() self
// -checks on every tick and pages if Gmail hasn't been successfully read in
// over an hour — see checkReplyPollStaleness() below and getReplyPollHealth()
// in lib/pipelineHealth.ts for the dashboard/script-facing read side.

import { randomBytes } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks } from "@/db/schema";
import { sendAlert } from "@/lib/alerts";
import { getSetting, setSetting } from "@/lib/settings";
import { getReplyPollHealth } from "@/lib/pipelineHealth";
import { config } from "../config";
import { listInboxMessages, getMessage, getAttachmentBytes } from "../lib/gmail";
import { isOptOut, isBounceNotification, extractBouncedRecipient } from "../lib/outreachEmail";
import { addSuppression } from "../lib/suppression";
import { storeImageBytes } from "@/lib/storage";
import { generateRevenueImpactCopy } from "../lib/anthropic";

// Which outbound kinds a reply can land against. `manual` is the hand-written
// one-off from /admin/photo/restaurants/[id] (kind 'manual', touchNumber 0) —
// it sends via the same Gmail mailbox and threads like anything else, but the
// poller used to match `kind='touch1'` ONLY, so every reply to a manual email
// was invisible: no record, no alert, and an opt-out request in one would
// never have been honored (a CAN-SPAM exposure, not just a lost lead).
// Flagged in AUDIT.md; widened 2026-08-31.
//
// `bump` is deliberately absent: a bump replies INTO the Touch 1 thread and
// carries that same gmailThreadId, so the Touch 1 row already matches it.
// Listing it here would just make the lookup ambiguous between two rows.
const REPLYABLE_KINDS = ["touch1", "manual"] as const;

function parseFromEmail(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1] : from).trim().toLowerCase();
}

function token(): string {
  return randomBytes(24).toString("hex");
}

// Re-page every 4h a stale spell continues, instead of every ~4-minute tick —
// this runs at the top of EVERY poll, so without a cooldown a broken Gmail
// token would fire hundreds of identical alert emails a day.
const REPLY_POLL_ALERT_COOLDOWN_MINUTES = 240;

// Own try/catch so a hiccup in the alert path itself (a DB blip reading the
// heartbeat, Resend down) can never block the actual reply poll below — the
// thing this is supposed to be protecting shouldn't depend on it.
async function checkReplyPollStaleness(): Promise<void> {
  try {
    const [health, lastAlertAt] = await Promise.all([getReplyPollHealth(), getSetting("reply_poll_last_alert")]);
    if (!health.stale) return;

    const minutesSinceAlert = lastAlertAt ? (Date.now() - Date.parse(lastAlertAt)) / 60_000 : Infinity;
    if (minutesSinceAlert < REPLY_POLL_ALERT_COOLDOWN_MINUTES) return;

    await sendAlert(
      "Reply poller hasn't succeeded in over an hour",
      `The last successful Gmail check-in was ${Math.round(health.minutesSinceRun!)} minutes ago (${health.lastRunAt}). ` +
        `Nothing is detecting "STOP" opt-outs or new photo replies while this is down — and Gmail's own ` +
        `search only covers the last 7 days, so a long enough gap loses a reply for good, not just delays ` +
        `it. Check the worker logs and the Gmail service-account auth (GOOGLE_SERVICE_ACCOUNT_JSON / ` +
        `GMAIL_SENDER).`
    );
    await setSetting("reply_poll_last_alert", new Date().toISOString());
  } catch (err) {
    console.warn("[poll] staleness check failed:", err instanceof Error ? err.message : err);
  }
}

// Bounces are found by SEARCHING for them, not by waiting for one to show up in
// a thread we already know about. See extractBouncedRecipient() in
// outreachEmail.ts for why: DSNs routinely arrive as their own Gmail thread, so
// the main loop below — which requires a matching gmailThreadId before it looks
// at a message at all — never saw them. This sweep runs first and independently.
//
// The query is narrow on purpose (a targeted list costs one call and returns
// only a handful of messages), then isBounceNotification() makes the real
// decision — the search is a cheap prefilter, not the classifier.
const BOUNCE_QUERY =
  'in:inbox newer_than:7d (from:mailer-daemon OR from:postmaster OR subject:"Delivery Status Notification")';

async function sweepBounces(): Promise<void> {
  let candidates: { id: string; threadId: string }[];
  try {
    candidates = await listInboxMessages(BOUNCE_QUERY);
  } catch (err) {
    console.warn("[poll] bounce sweep list failed:", err instanceof Error ? err.message : err);
    return;
  }

  for (const { id } of candidates) {
    const full = await getMessage(id).catch(() => null);
    if (!full || !isBounceNotification(full.from, full.bodyText)) continue;

    const failed = extractBouncedRecipient(full.bodyText);
    if (!failed) {
      // Parsed nothing — better to say so than to suppress a guess. If this
      // shows up in the logs, the DSN format needs a new pattern.
      console.warn(`[poll] bounce ${id} — couldn't parse the failed recipient out of the body`);
      continue;
    }

    const [victim] = await db
      .select({ id: restaurants.id, name: restaurants.name, suppressed: restaurants.suppressed })
      .from(restaurants)
      .where(sql`lower(${restaurants.email}) = ${failed}`)
      .limit(1);

    if (!victim) {
      console.log(`[poll] bounce for ${failed} — no restaurant on file with that address, ignoring`);
      continue;
    }
    // Already handled. This is also what keeps the sweep cheap on re-runs: the
    // same DSN stays in the inbox for its whole 7-day window and is re-listed
    // every 4 minutes, but does no work after the first time.
    if (victim.suppressed) continue;

    await addSuppression(failed, "bounce");
    await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, victim.id));
    // Correct the outreach row's story too, so the reply rate and the
    // deliverability guard both count this as what it was.
    await db
      .update(outreachJobs)
      .set({ status: "bounced" })
      .where(
        and(eq(outreachJobs.restaurantId, victim.id), eq(outreachJobs.kind, "touch1"), eq(outreachJobs.status, "sent"))
      );
    console.log(`[poll] BOUNCE (sweep) ${failed} (${victim.name}) — suppressed`);
  }
}

export async function runReplyPoll(): Promise<void> {
  await checkReplyPollStaleness();
  await sweepBounces();

  let messages: { id: string; threadId: string }[];
  try {
    messages = await listInboxMessages();
  } catch (err) {
    console.warn("[poll] Gmail list failed (is Gmail configured?):", err instanceof Error ? err.message : err);
    return;
  }

  // Proof the poller is actually alive, not just that the worker booted (see
  // getReplyPollHealth in lib/pipelineHealth.ts). Clears any pending alert
  // cooldown too, so a LATER outage pages again instead of staying silent
  // because of a stale lastAlert from an episode that already recovered.
  await setSetting("reply_poll_last_run", new Date().toISOString());
  await setSetting("reply_poll_last_alert", null);

  for (const { id: messageId, threadId } of messages) {
    // ANY Touch-1 row for this thread — not just unreplied ones (see header
    // comment). Per-message dedup happens below via lastReplyMessageId. kind,
    // not touchNumber — a bump replies into this SAME thread and also carries
    // touchNumber 1, which without this would make the match ambiguous.
    const [job] = await db
      .select()
      .from(outreachJobs)
      .where(and(eq(outreachJobs.gmailThreadId, threadId), inArray(outreachJobs.kind, REPLYABLE_KINDS)))
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

    // A BOUNCE, not a reply. Must be handled before the `replied` write below:
    // a delivery failure arrives in the same thread as the message that failed,
    // so recording it as a reply inflates the reply rate (the pipeline's only
    // "reply" across 42 sends was a mailer-daemon bounce), queues a pointless
    // draft for a human to answer, and — worst — leaves the dead address
    // un-suppressed, invisible to the deliverability guard.
    //
    // Suppress the address we actually SENT to (from the restaurant row), never
    // `sender` — that's mailer-daemon's own address, which would suppress the
    // robot instead of the dead mailbox.
    if (isBounceNotification(sender, full.bodyText)) {
      const [bounced] = await db.select().from(restaurants).where(eq(restaurants.id, job.restaurantId)).limit(1);
      if (bounced?.email) {
        await addSuppression(bounced.email, "bounce");
        await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, bounced.id));
      }
      await db
        .update(outreachJobs)
        .set({ status: "bounced", lastReplyMessageId: messageId })
        .where(eq(outreachJobs.id, job.id));
      console.log(`[poll] BOUNCE for ${bounced?.email ?? "(unknown address)"} (${bounced?.name ?? job.restaurantId}) — suppressed, not counted as a reply`);
      continue;
    }

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

    // Opt-out. Still auto-suppresses — honoring an unambiguous request
    // instantly is both the right thing and the CAN-SPAM-safe thing (10
    // business days is the ceiling, not a target). What changed 2026-08-31 is
    // that it is no longer SILENT: suppression removes a lead from the
    // pipeline permanently, so the operator is told every time it happens.
    // Previously this branch suppressed and `continue`d with only a console
    // line, meaning a lead could vanish with no trace anywhere the operator
    // looks. Paired with dropping bare "no" from isOptOut(), the ambiguous
    // cases now reach a human instead of being decided by a keyword list.
    if (isOptOut(full.bodyText)) {
      const [optedOut] = await db
        .select({ name: restaurants.name, city: restaurants.city })
        .from(restaurants)
        .where(eq(restaurants.id, job.restaurantId))
        .limit(1);
      await addSuppression(sender, "opt_out");
      await db.update(restaurants).set({ suppressed: true }).where(eq(restaurants.id, job.restaurantId));
      await sendAlert(
        "Opt-out — restaurant suppressed automatically",
        `${optedOut?.name ?? `restaurant ${job.restaurantId}`} (${optedOut?.city ?? "?"}) — ${sender} — asked to be ` +
          `removed, so they've been suppressed and will never be contacted again.\n\n` +
          `They wrote:\n"${full.bodyText.trim().slice(0, 500)}"\n\n` +
          `No action needed. If this was a misread, undo it on /admin/photo/suppressions.`
      );
      console.log(`[poll] opt-out from ${sender} — suppressed + alerted`);
      continue;
    }

    const [restaurant] = await db.select().from(restaurants).where(eq(restaurants.id, job.restaurantId)).limit(1);
    if (!restaurant) continue;

    // A second (or later) message in a thread already marked replied. The
    // pipeline only auto-handles the FIRST reply (photo -> sample, or a
    // queued draft reply); anything after that is a live back-and-forth —
    // always surface it, never try to auto-create a second magic link. Queues
    // a blank draft (no LLM drafting — a human writes every word) alongside
    // the alert, same as the no-photo branch below.
    if (!isFirstReply) {
      await db.insert(outreachJobs).values({
        restaurantId: job.restaurantId,
        kind: "reply",
        touchNumber: null,
        emailContent: "",
        replyBody: full.bodyText,
        replyFrom: sender,
        gmailThreadId: threadId,
        draftedAt: new Date(),
        status: "draft",
      });
      await sendAlert(
        "New message in an existing reply thread",
        `${restaurant.name} (${restaurant.city ?? "?"}) — ${sender} — sent another message in a thread ` +
          `already marked replied.\n\n"${full.bodyText.trim().slice(0, 500)}"\n\n` +
          `Draft a reply in Approvals — nothing sends until you write it and click send.`
      );
      console.log(`[poll] follow-up message from ${sender} — draft queued + alerted`);
      continue;
    }

    const image = full.imageAttachments[0];
    if (!image) {
      // A real human wrote back with a question or interest — the pipeline only
      // auto-handles photo replies and STOP, so this needs YOU, today. Queues a
      // blank draft rather than answering for you: no LLM-authored replies, by
      // design — you write every word before it can send.
      await db.insert(outreachJobs).values({
        restaurantId: job.restaurantId,
        kind: "reply",
        touchNumber: null,
        emailContent: "",
        replyBody: full.bodyText,
        replyFrom: sender,
        gmailThreadId: threadId,
        draftedAt: new Date(),
        status: "draft",
      });
      await sendAlert(
        "New reply — needs your answer",
        `${restaurant.name} (${restaurant.city ?? "?"}) — ${sender} — replied to Touch 1 without a photo.\n\n` +
          `"${full.bodyText.trim().slice(0, 500)}"\n\n` +
          `Draft a reply in Approvals — nothing sends until you write it and click send.`
      );
      console.log(`[poll] reply from ${sender} with no photo — draft queued + alerted`);
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
