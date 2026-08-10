// Writes one row to the `payments` ledger per real money movement. Shared by the
// Stripe webhook (app/api/webhooks/stripe/route.ts) and the backfill reconciler
// (scripts/backfill-payments.ts) so both record payments identically.
//
// Hard rule: this is analytics on the MONEY PATH — it must NEVER throw and never
// slow a webhook enough to trip Stripe's ~30s timeout. Every failure degrades to
// an 'estimated'-fee row (or no row) that the reconciler later repairs.

import type Stripe from "stripe";
import { db } from "@/db";
import { payments } from "@/db/schema";
import { estimateStripeFeeCents } from "@/lib/costs";

export type LedgerLine = "self_serve" | "package";

export type LedgerInput = {
  line: LedgerLine;
  session: Stripe.Checkout.Session;
  enhancementOrderId?: number | null;
  magicLinkId?: number | null;
  restaurantId?: number | null;
  packageId?: string | null;
  description?: string | null;
};

// Ceiling on the one Stripe round-trip. Worst case is a slightly slower 200 that
// carries an estimated fee; the reconciler upgrades it to the real fee later.
const STRIPE_LOOKUP_TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)),
  ]);
}

export async function recordStripePayment(stripe: Stripe, input: LedgerInput): Promise<void> {
  try {
    const { session } = input;
    const grossCents = session.amount_total ?? 0;
    if (grossCents <= 0) return; // nothing was charged

    const piId =
      typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;

    // Estimate first; upgrade to the real balance-transaction numbers if we can
    // fetch them. On any failure we keep the estimate and mark it as such.
    let feeCents = estimateStripeFeeCents(grossCents);
    let netCents = grossCents - feeCents;
    let feeSource: "stripe" | "estimated" = "estimated";
    let chargeId: string | null = null;
    let balanceTxnId: string | null = null;
    let paidAt = new Date();

    if (piId) {
      try {
        const pi = await withTimeout(
          stripe.paymentIntents.retrieve(piId, { expand: ["latest_charge.balance_transaction"] }),
          STRIPE_LOOKUP_TIMEOUT_MS
        );
        const charge = typeof pi.latest_charge === "object" ? pi.latest_charge : null;
        if (charge) {
          chargeId = charge.id;
          if (charge.created) paidAt = new Date(charge.created * 1000);
          const bt = typeof charge.balance_transaction === "object" ? charge.balance_transaction : null;
          if (bt) {
            feeCents = bt.fee;
            netCents = bt.net;
            balanceTxnId = bt.id;
            feeSource = "stripe";
          }
        }
      } catch (err) {
        console.error(
          "[ledger] fee lookup failed — recording an estimate:",
          err instanceof Error ? err.message : err
        );
      }
    }

    // Stripe rows key on the charge id; before the charge is known we fall back
    // to the session id so a redelivery still dedupes.
    const ledgerKey = chargeId ?? `session:${session.id}`;

    await db
      .insert(payments)
      .values({
        ledgerKey,
        line: input.line,
        method: "stripe",
        packageId: input.packageId ?? session.metadata?.package ?? null,
        description: input.description ?? null,
        grossCents,
        feeCents,
        netCents,
        currency: session.currency ?? "usd",
        feeSource,
        customerEmail: session.customer_details?.email ?? null,
        restaurantId: input.restaurantId ?? null,
        enhancementOrderId: input.enhancementOrderId ?? null,
        magicLinkId: input.magicLinkId ?? null,
        stripeSessionId: session.id,
        stripeChargeId: chargeId,
        stripePaymentIntentId: piId,
        stripeBalanceTxnId: balanceTxnId,
        paidAt,
      })
      // Redelivery / backfill self-heals: an 'estimated' row is upgraded to
      // 'stripe' once the balance transaction has settled. Deliberately does NOT
      // touch refundedCents/refundedAt — a later charge.refunded owns those.
      .onConflictDoUpdate({
        target: payments.ledgerKey,
        set: {
          feeCents,
          netCents,
          feeSource,
          stripeChargeId: chargeId,
          stripeBalanceTxnId: balanceTxnId,
          paidAt,
        },
      });
  } catch (err) {
    // Last-resort guard: a ledger write must never fail a payment.
    console.error("[ledger] recordStripePayment failed:", err instanceof Error ? err.message : err);
  }
}

// Records an off-Stripe payment (check/Zelle, via the admin "mark paid" action).
// Real processor fee is $0, so feeSource is 'none' and net == gross.
export async function recordManualPayment(input: {
  line: LedgerLine;
  magicLinkId: number;
  restaurantId?: number | null;
  packageId?: string | null;
  grossCents: number;
  description?: string | null;
  paidAt: Date;
}): Promise<void> {
  try {
    if (input.grossCents <= 0) return;
    await db
      .insert(payments)
      .values({
        ledgerKey: `manual:ml:${input.magicLinkId}`,
        line: input.line,
        method: "manual",
        packageId: input.packageId ?? null,
        description: input.description ?? null,
        grossCents: input.grossCents,
        feeCents: 0,
        netCents: input.grossCents,
        currency: "usd",
        feeSource: "none",
        restaurantId: input.restaurantId ?? null,
        magicLinkId: input.magicLinkId,
        paidAt: input.paidAt,
      })
      .onConflictDoUpdate({
        target: payments.ledgerKey,
        set: { grossCents: input.grossCents, netCents: input.grossCents, packageId: input.packageId ?? null },
      });
  } catch (err) {
    console.error("[ledger] recordManualPayment failed:", err instanceof Error ? err.message : err);
  }
}
