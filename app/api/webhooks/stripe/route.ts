import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders, magicLinks } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { sendAlert } from "@/lib/alerts";

// Verifies Stripe's signature, records the payment, and returns fast. The slow
// enhancement work happens in the worker — see processEnhancementOrders.ts.
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

  // Hand off to the worker and return immediately. Claid takes ~1 min per photo
  // and Stripe only waits ~30s before treating the webhook as failed and
  // re-delivering the event, so enhancing here would time out on even a
  // one-photo order — and the retry would re-run the whole batch, paying Claid
  // twice. `worker/jobs/processEnhancementOrders.ts` picks the order up within
  // a minute.
  //
  // Only 'pending' advances to 'processing': Stripe retries and duplicate
  // deliveries of the same event must not knock a completed order back into
  // the queue and re-enhance it.
  const advanced = await db
    .update(enhancementOrders)
    .set({ status: "processing" })
    .where(and(eq(enhancementOrders.id, order.id), eq(enhancementOrders.status, "pending")))
    .returning({ id: enhancementOrders.id });

  if (advanced.length === 0) {
    console.log(
      `[stripe-webhook] order ${order.id} already ${order.status} — ignoring duplicate delivery of ${session.id}`
    );
    return NextResponse.json({ received: true });
  }

  console.log(`[stripe-webhook] order ${order.id} paid — queued for enhancement`);
  return NextResponse.json({ received: true });
}
