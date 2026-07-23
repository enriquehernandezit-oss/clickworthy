import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders, magicLinks } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { enhancePhoto } from "@/lib/claid";
import { persistEnhancedFromUrl, type StoredPhoto } from "@/lib/storage";
import { sendAlert } from "@/lib/alerts";

type PhotoResult = {
  originalName: string;
  enhancedUrl: string | null;
  error: string | null;
};

function appOriginFrom(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

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

  // Outreach package payment: no photos exist yet (the customer uploads them
  // AFTER paying, on /l/[token]/upload). Just mark the link paid.
  if (session.metadata?.type === "outreach" && session.metadata.token) {
    await db
      .update(magicLinks)
      .set({ paidAt: new Date() })
      .where(eq(magicLinks.token, session.metadata.token));
    console.log(`[stripe-webhook] outreach package paid — link ${session.metadata.token}`);
    return NextResponse.json({ received: true });
  }

  const [order] = await db
    .select()
    .from(enhancementOrders)
    .where(eq(enhancementOrders.stripeSessionId, session.id))
    .limit(1);

  if (!order) {
    console.error(`[stripe-webhook] No enhancement order for completed session ${session.id}.`);
    // A customer paid but we have no photos/prompt on file — needs a human now.
    await sendAlert(
      "Paid order with no record",
      `Stripe session ${session.id} completed but no enhancement order or outreach link matched it. ` +
        "A customer was charged and we have nothing to fulfill."
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
  const appOrigin = appOriginFrom(request);

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    try {
      // Claid returns a tmp_url that expires in ~24h — download and re-store it
      // to our own durable storage so the customer's results don't rot.
      const claidUrl = await enhancePhoto(photo.url, order.prompt);
      const enhancedUrl = await persistEnhancedFromUrl(order.stripeSessionId, i, claidUrl, appOrigin);
      results.push({ originalName: photo.originalName, enhancedUrl, error: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[stripe-webhook] Claid enhancement failed for "${photo.originalName}" ` +
          `(order ${order.id}, session ${session.id}):`,
        message
      );
      results.push({ originalName: photo.originalName, enhancedUrl: null, error: message });
    }
  }

  const failed = results.filter((r) => r.enhancedUrl === null);
  const anySucceeded = results.length > failed.length;

  // A paid /enhance order with any failed photo needs a human — they paid.
  if (failed.length > 0) {
    await sendAlert(
      "Paid /enhance order had photo failures",
      `Order ${order.id} (session ${session.id}): ${failed.length}/${results.length} photos failed to enhance.`
    );
  }

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
