import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders, magicLinks, payments, restaurants, outreachJobs } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { sendAlert } from "@/lib/alerts";
import { recordStripePayment } from "@/lib/paymentLedger";
import { composePackagePaymentConfirmationEmail } from "@/lib/customerEmail";
import { isPackageId } from "@/lib/packages";
import { getSetting, getPackages } from "@/lib/settings";
import { signatureBlock } from "@/worker/lib/outreachEmail";

function appOriginFrom(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

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

  const stripe = getStripe();
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature ?? "", webhookSecret);
  } catch (err) {
    console.error("[stripe-webhook] Signature verification failed:", err);
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 });
  }

  // Refunds. charge.amount_refunded is CUMULATIVE (covers partial refunds too),
  // so a plain assignment is naturally idempotent. Requires `charge.refunded` to
  // be enabled on the Stripe endpoint (see HANDOFF.md's webhook setup step).
  if (event.type === "charge.refunded") {
    const charge = event.data.object as Stripe.Charge;
    await db
      .update(payments)
      .set({ refundedCents: charge.amount_refunded, refundedAt: new Date() })
      .where(eq(payments.stripeChargeId, charge.id));
    return NextResponse.json({ received: true });
  }

  // Chargeback opened. Time-sensitive — Stripe gives a hard deadline to submit
  // evidence in the dashboard, or the funds are lost automatically plus a $15
  // fee. This app can't respond to a dispute (that's a Stripe-dashboard
  // workflow); its only job is to make sure a human finds out immediately.
  // Requires `charge.dispute.created` on the Stripe endpoint.
  if (event.type === "charge.dispute.created") {
    const dispute = event.data.object as Stripe.Dispute;
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
    const dueBy = dispute.evidence_details?.due_by
      ? new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
      : "unknown — check Stripe";
    await sendAlert(
      `Chargeback opened — respond by ${dueBy}`,
      `A customer disputed a $${(dispute.amount / 100).toFixed(2)} charge (reason: ${dispute.reason}). ` +
        `Submit evidence in the Stripe dashboard before ${dueBy}, or the charge is lost automatically plus ` +
        `a $15 dispute fee. Charge: ${chargeId}.`
    );
    return NextResponse.json({ received: true });
  }

  // Chargeback resolved. On a loss, treat it exactly like a refund for
  // accounting purposes — additive (+ not =) in case a genuine partial refund
  // already touched this row. Requires `charge.dispute.closed`.
  if (event.type === "charge.dispute.closed") {
    const dispute = event.data.object as Stripe.Dispute;
    const chargeId = typeof dispute.charge === "string" ? dispute.charge : dispute.charge.id;
    if (dispute.status === "lost") {
      await db
        .update(payments)
        .set({ refundedCents: sql`${payments.refundedCents} + ${dispute.amount}`, refundedAt: new Date() })
        .where(eq(payments.stripeChargeId, chargeId));
      await sendAlert(
        "Chargeback lost",
        `The $${(dispute.amount / 100).toFixed(2)} dispute on charge ${chargeId} was lost — funds are gone ` +
          `(plus the $15 dispute fee). Recorded as a refund in the P&L.`
      );
    } else if (dispute.status === "won") {
      await sendAlert("Chargeback won", `The dispute on charge ${chargeId} was won — funds retained, no P&L change.`);
    }
    return NextResponse.json({ received: true });
  }

  if (event.type !== "checkout.session.completed") {
    return NextResponse.json({ received: true });
  }

  const session = event.data.object as Stripe.Checkout.Session;

  // Outreach package payment: no photos exist yet (the customer uploads them
  // AFTER paying, on /l/[token]/upload). Just mark the link paid.
  if (session.metadata?.type === "outreach" && session.metadata.token) {
    const token = session.metadata.token;
    const [link] = await db
      .select({
        id: magicLinks.id,
        restaurantId: magicLinks.restaurantId,
        packageSelected: magicLinks.packageSelected,
      })
      .from(magicLinks)
      .where(eq(magicLinks.token, token))
      .limit(1);
    // isNull guard + .returning(): a redelivered event must not push paidAt
    // forward in time (which would move revenue between months on the funnel
    // pages) — and whether THIS delivery was the one that actually set it is
    // also what decides whether to send the one-time confirmation email below,
    // so a Stripe redelivery can't double-send it.
    const firstDelivery = await db
      .update(magicLinks)
      .set({ paidAt: new Date() })
      .where(and(eq(magicLinks.token, token), isNull(magicLinks.paidAt)))
      .returning({ id: magicLinks.id });

    if (link) {
      // The package ACTUALLY paid for comes from the checkout metadata, not the
      // magic link's mutable packageSelected. Fall back only if metadata is absent.
      const pkgId = session.metadata.package ?? link.packageSelected ?? undefined;
      const description = isPackageId(pkgId) ? (await getPackages())[pkgId].name.en : "Package";
      await recordStripePayment(stripe, {
        line: "package",
        session,
        magicLinkId: link.id,
        restaurantId: link.restaurantId,
        packageId: isPackageId(pkgId) ? pkgId : null,
        description,
      });

      // Drafts the confirmation instead of sending it directly — a human
      // approves (and can edit) before it goes out; see
      // app/api/admin/approvals/route.ts. Without SOME form of this, closing
      // the tab right after paying — easy on a slow connection, or if the
      // owner just gets pulled away — meant the ONLY way back to the upload
      // page was asking us for the link again. The customer's OWN path there
      // is unaffected either way: Stripe's own success redirect fires
      // instantly regardless of this email, which is only the "in case you
      // closed the tab" backup.
      //
      // firstDelivery.length > 0 is the same atomic paidAt guard used above —
      // a Stripe redelivery of this event can't queue a second draft.
      if (firstDelivery.length > 0 && link.restaurantId != null) {
        const [restaurant] = await db
          .select({ name: restaurants.name, email: restaurants.email, language: restaurants.language })
          .from(restaurants)
          .where(eq(restaurants.id, link.restaurantId))
          .limit(1);
        if (restaurant?.email) {
          const appOrigin = appOriginFrom(request);
          const { subject, body } = composePackagePaymentConfirmationEmail({
            restaurantName: restaurant.name,
            language: restaurant.language ?? "en",
            uploadUrl: `${appOrigin}/l/${token}/upload`,
          });
          const [senderName, signature] = await Promise.all([
            getSetting("outreach_sender_name"),
            getSetting("outreach_signature"),
          ]);
          // Baked into the stored draft (like Touch 1/bump/Touch 2), not
          // appended at send time — a human reviews this in Approvals, so
          // what they see should be what actually ships. postalAddress is
          // unused by signatureBlock (this send isn't CAN-SPAM commercial
          // mail — it's a receipt for a completed purchase).
          const fullBody = body + signatureBlock({ senderName, postalAddress: "", signature });
          await db.insert(outreachJobs).values({
            restaurantId: link.restaurantId,
            magicLinkId: link.id,
            kind: "payment_confirmation",
            touchNumber: null,
            subject,
            emailContent: fullBody,
            draftedAt: new Date(),
            status: "draft",
          });
        }
      }
    }
    console.log(`[stripe-webhook] outreach package paid — link ${token}`);
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

  // Record the payment before the duplicate-guard below: if a prior delivery
  // crashed after flipping status but before the ledger write, the retry is the
  // only chance to capture it. Idempotent via ledgerKey, so it's free otherwise.
  await recordStripePayment(stripe, {
    line: "self_serve",
    session,
    enhancementOrderId: order.id,
    description: `${order.photoCount} enhanced photo${order.photoCount === 1 ? "" : "s"}`,
  });

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
