import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { enhancePhoto } from "@/lib/claid";
import type { StoredPhoto } from "@/lib/storage";

type PhotoResult = {
  originalName: string;
  enhancedUrl: string | null;
  error: string | null;
};

export async function POST(request: NextRequest) {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) {
    // TODO: set STRIPE_WEBHOOK_SECRET (from the Stripe dashboard's webhook
    // endpoint config) — without it we cannot safely verify these requests
    // actually came from Stripe, so we refuse to process them.
    console.error("[stripe-webhook] STRIPE_WEBHOOK_SECRET is not configured.");
    return NextResponse.json({ error: "Webhook not configured" }, { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  let event: Stripe.Event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(rawBody, signature ?? "", webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  const [order] = await db
    .select()
    .from(enhancementOrders)
    .where(eq(enhancementOrders.stripeSessionId, session.id))
    .limit(1);

  if (!order) {
    console.error(
      `[stripe-webhook] No enhancement order found for completed session ${session.id}. ` +
        "TODO: this should alert us — a customer paid but we have no photos/prompt on file."
    );
    return NextResponse.json({ received: true });
  }

  await db
    .update(enhancementOrders)
    .set({ status: "processing" })
    .where(eq(enhancementOrders.id, order.id));

  // NOTE: this runs the whole enhancement pipeline synchronously inside the
  // webhook request. For a handful of photos this is fine; for larger orders
  // Stripe's webhook timeout may be hit before we finish, causing a retry.
  // TODO: move this to a background job/queue once order volume justifies it.
  const photos = order.photos as StoredPhoto[];
  const results: PhotoResult[] = [];

  for (const photo of photos) {
    try {
      const enhancedUrl = await enhancePhoto(photo.url, order.prompt);
      results.push({ originalName: photo.originalName, enhancedUrl, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // TODO: this should email/alert us in production — a paid order with a
      // failed photo should never fail silently.
      console.error(
        `[stripe-webhook] Claid enhancement failed for "${photo.originalName}" ` +
          `(order ${order.id}, session ${session.id}):`,
        message
      );
      results.push({ originalName: photo.originalName, enhancedUrl: null, error: message });
    }
  }

  const anySucceeded = results.some((r) => r.enhancedUrl !== null);

  await db
    .update(enhancementOrders)
    .set({
      status: anySucceeded ? "completed" : "failed",
      results,
      completedAt: new Date(),
    })
    .where(eq(enhancementOrders.id, order.id));

  return NextResponse.json({ received: true });
}
