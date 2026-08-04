// Processes paid self-serve /enhance orders. The Stripe webhook only marks an
// order `processing` and returns immediately — Claid takes ~1 min per photo and
// Stripe gives a webhook ~30s before it retries the event, so enhancing inside
// the request would time out and get re-delivered, re-running the whole batch
// and double-paying for Claid. This job does the slow work instead.
//
// Picks up: status = 'processing' AND results IS NULL. Writing results is what
// takes an order out of the queue, so a crash mid-batch just retries next tick.

import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders } from "@/db/schema";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl, type StoredPhoto } from "@/lib/storage";
import { sendAlert } from "@/lib/alerts";
import { config } from "../config";
import { withRetry } from "../lib/retry";

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
