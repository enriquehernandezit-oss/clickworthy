// Processes paid self-serve /enhance orders. The Stripe webhook only marks an
// order `processing` and returns immediately — Claid takes ~1 min per photo and
// Stripe gives a webhook ~30s before it retries the event, so enhancing inside
// the request would time out and get re-delivered, re-running the whole batch
// and double-paying for Claid. This job does the slow work instead.
//
// Picks up: status = 'processing' AND results IS NULL. Writing results is what
// takes an order out of the queue, so a crash mid-batch just retries next tick.

import { and, eq, isNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl, type StoredPhoto } from "@/lib/storage";
import { sendAlert } from "@/lib/alerts";
import { getStripe } from "@/lib/stripe";
import { config } from "../config";
import { withRetry } from "../lib/retry";

// Kept in sync with the same threshold app/admin/page.tsx uses to surface a
// "stuck pending" count on Needs-attention — both describe the same symptom.
const STUCK_PENDING_HOURS = 1;

type PhotoResult = { originalName: string; enhancedUrl: string | null; error: string | null };

async function processOne(orderId: number, sessionId: string, prompt: string, photos: StoredPhoto[]): Promise<void> {
  const results: PhotoResult[] = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    try {
      // Claid returns a tmp_url that expires in ~24h — download and re-store it
      // to our own durable storage so the customer's results don't rot.
      const claidUrl = await withRetry(() => enhancePhoto(photo.url, prompt), {
        label: `claid enhance order ${orderId} #${i}`,
      });
      const enhancedUrl = await persistEnhancedFromUrl(sessionId, i, claidUrl, config.appOrigin);
      results.push({ originalName: photo.originalName, enhancedUrl, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[enhance-order] failed "${photo.originalName}" (order ${orderId}):`, message);
      results.push({ originalName: photo.originalName, enhancedUrl: null, error: message });
    }
  }

  const failed = results.filter((r) => r.enhancedUrl === null);
  const anySucceeded = results.length > failed.length;

  await db
    .update(enhancementOrders)
    .set({
      status: anySucceeded ? "completed" : "failed",
      results,
      completedAt: new Date(),
    })
    .where(eq(enhancementOrders.id, orderId));

  console.log(`[enhance-order] order ${orderId}: ${results.length - failed.length}/${results.length} enhanced`);

  // They paid — any failure needs a human, not just a log line.
  if (failed.length > 0) {
    await sendAlert(
      "Paid /enhance order had photo failures",
      `Order ${orderId} (session ${sessionId}): ${failed.length}/${results.length} photos failed to enhance.`
    );
  }
}

export async function runProcessEnhancementOrders(): Promise<void> {
  const pending = await db
    .select({
      id: enhancementOrders.id,
      sessionId: enhancementOrders.stripeSessionId,
      prompt: enhancementOrders.prompt,
      photos: enhancementOrders.photos,
    })
    .from(enhancementOrders)
    .where(and(eq(enhancementOrders.status, "processing"), isNull(enhancementOrders.results)));

  for (const order of pending) {
    const photos = (order.photos as StoredPhoto[] | null) ?? [];
    if (photos.length === 0) {
      console.warn(`[enhance-order] order ${order.id} has no photos — marking failed`);
      await db
        .update(enhancementOrders)
        .set({ status: "failed", results: [], completedAt: new Date() })
        .where(eq(enhancementOrders.id, order.id));
      continue;
    }
    await processOne(order.id, order.sessionId, order.prompt, photos);
  }
}

// Recovers orders whose Stripe payment actually succeeded but the webhook
// never advanced them past 'pending' — the exact symptom of a missing or wrong
// STRIPE_WEBHOOK_SECRET (webhooks/stripe/route.ts returns 500 in that case, and
// Stripe gives up retrying after ~3 days). Checks Stripe directly rather than
// trusting local state, since local state is precisely what's in question.
// Runs on the same 1-minute PACKAGE_QUEUE cadence as the rest of this job —
// the >1h cutoff keeps it from ever touching an order still mid-checkout.
export async function recoverStuckPendingOrders(): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_PENDING_HOURS * 3_600_000);
  const stuck = await db
    .select({ id: enhancementOrders.id, sessionId: enhancementOrders.stripeSessionId })
    .from(enhancementOrders)
    .where(and(eq(enhancementOrders.status, "pending"), lt(enhancementOrders.createdAt, cutoff)));

  if (stuck.length === 0) return;

  let stripe;
  try {
    stripe = getStripe();
  } catch {
    // No Stripe key configured yet — Setup already flags that; not this job's
    // job to repeat it.
    return;
  }

  for (const order of stuck) {
    try {
      const session = await stripe.checkout.sessions.retrieve(order.sessionId);
      if (session.payment_status !== "paid") continue; // genuinely abandoned, not stuck — leave alone

      // Only 'pending' -> 'processing', mirroring the webhook's own guard, so
      // two overlapping recovery attempts can't double-queue the same order.
      const advanced = await db
        .update(enhancementOrders)
        .set({ status: "processing" })
        .where(and(eq(enhancementOrders.id, order.id), eq(enhancementOrders.status, "pending")))
        .returning({ id: enhancementOrders.id });

      if (advanced.length > 0) {
        console.warn(`[enhance-order] recovered stuck order ${order.id} — was paid, webhook never advanced it`);
        await sendAlert(
          "Recovered a paid order stuck on 'pending'",
          `Order ${order.id} (session ${order.sessionId}) was paid in Stripe but never advanced past ` +
            `'pending' — most likely the Stripe webhook didn't fire (check STRIPE_WEBHOOK_SECRET on the ` +
            `web service, and that the Stripe dashboard endpoint is registered). Recovered automatically; ` +
            `it will be enhanced on the next run.`
        );
      }
    } catch (err) {
      console.error(`[enhance-order] couldn't check stuck order ${order.id}:`, err instanceof Error ? err.message : err);
    }
  }
}
