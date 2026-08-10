// Backfill / reconcile the payments ledger from existing paid orders.
//   bun run scripts/backfill-payments.ts                 # DRY RUN — prints the plan, writes nothing
//   bun run scripts/backfill-payments.ts --commit        # write ledger rows (idempotent)
//   bun run scripts/backfill-payments.ts --commit --refresh-fees  # + re-pull refunds for Stripe rows
//
// Idempotent by design (every write goes through the same onConflict(ledgerKey)
// as the webhook), so it doubles as a re-runnable fee reconciler — run it again
// any time and estimated rows upgrade to real Stripe fees. Safe to run twice; the
// row count won't change.

import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { enhancementOrders, magicLinks, payments } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { PACKAGES, isPackageId } from "@/lib/packages";
import { recordStripePayment, recordManualPayment } from "@/lib/paymentLedger";
import { getRevenue } from "@/lib/photoStats";
import type Stripe from "stripe";

const commit = process.argv.includes("--commit");
const refreshFees = process.argv.includes("--refresh-fees");
const stripe = getStripe();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Politeness pause between Stripe calls — not a rate-limit need at this volume.
async function getSession(id: string): Promise<Stripe.Checkout.Session | null> {
  try {
    const s = await stripe.checkout.sessions.retrieve(id);
    await sleep(120);
    return s;
  } catch (err) {
    console.warn(`  ! could not retrieve session ${id}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

let recordedPackageCents = 0;
let recordedSelfServeCents = 0;
let anomalies = 0;

// ---- Package payments (magic_links with a paidAt) --------------------------
console.log(`\n${commit ? "COMMIT" : "DRY RUN"} — packages`);
const paidLinks = await db
  .select()
  .from(magicLinks)
  .where(and(isNotNull(magicLinks.paidAt), isNotNull(magicLinks.packageSelected)));

for (const link of paidLinks) {
  const pkgId = isPackageId(link.packageSelected) ? link.packageSelected : null;
  const listCents = pkgId ? PACKAGES[pkgId].priceCents : 0;

  if (link.stripeSessionId) {
    const session = await getSession(link.stripeSessionId);
    if (session && session.payment_status === "paid") {
      const metaPkg = (session.metadata?.package && isPackageId(session.metadata.package))
        ? session.metadata.package
        : pkgId;
      const gross = session.amount_total ?? listCents;
      recordedPackageCents += gross;
      console.log(`  link ${link.token}: STRIPE $${(gross / 100).toFixed(2)} (${metaPkg ?? "?"})`);
      if (commit) {
        await recordStripePayment(stripe, {
          line: "package",
          session,
          magicLinkId: link.id,
          restaurantId: link.restaurantId,
          packageId: metaPkg,
          description: metaPkg ? `${PACKAGES[metaPkg].name.en}` : "Package",
        });
      }
      continue;
    }
    // paidAt is set but the recorded session was never paid — bug (a): a later
    // checkout attempt overwrote stripeSessionId/packageSelected. Record what we
    // can from the package list and flag it for a human.
    anomalies++;
    console.warn(
      `  link ${link.token}: ANOMALY paidAt set but session ${link.stripeSessionId} is ${session?.payment_status ?? "unretrievable"} — recording manual $${(listCents / 100).toFixed(2)}`
    );
  } else {
    console.log(`  link ${link.token}: MANUAL $${(listCents / 100).toFixed(2)} (no stripe session)`);
  }

  // Manual / off-Stripe (check/Zelle) or anomaly fallback.
  recordedPackageCents += listCents;
  if (commit && pkgId) {
    await recordManualPayment({
      line: "package",
      magicLinkId: link.id,
      restaurantId: link.restaurantId,
      packageId: pkgId,
      grossCents: listCents,
      description: `${PACKAGES[pkgId].name.en} (manual)`,
      paidAt: link.paidAt ?? new Date(),
    });
  }
}

// ---- Self-serve payments (non-pending enhancement_orders) ------------------
console.log(`\n${commit ? "COMMIT" : "DRY RUN"} — self-serve`);
const orders = await db
  .select()
  .from(enhancementOrders)
  .where(sql`${enhancementOrders.status} in ('processing','completed','failed')`);

for (const order of orders) {
  const session = await getSession(order.stripeSessionId);
  const gross = session?.amount_total ?? order.totalCents;
  recordedSelfServeCents += gross;
  console.log(`  order ${order.id}: $${(gross / 100).toFixed(2)} (${order.status})`);
  if (commit) {
    if (session) {
      await recordStripePayment(stripe, {
        line: "self_serve",
        session,
        enhancementOrderId: order.id,
        description: `${order.photoCount} enhanced photo${order.photoCount === 1 ? "" : "s"}`,
      });
    } else {
      // No retrievable session — record the known gross as an estimate so the
      // revenue isn't lost. ledgerKey falls back to session:{id} inside the helper.
      console.warn(`  order ${order.id}: no session — skipped (needs manual review)`);
    }
  }
}

// ---- Optional: re-pull refunds for existing Stripe rows ---------------------
if (refreshFees && commit) {
  console.log(`\nCOMMIT — refunds (re-pull for Stripe rows with a charge id)`);
  const chargeRows = await db
    .select({ id: payments.id, chargeId: payments.stripeChargeId })
    .from(payments)
    .where(and(eq(payments.method, "stripe"), isNotNull(payments.stripeChargeId)));
  for (const row of chargeRows) {
    if (!row.chargeId) continue;
    try {
      const charge = await stripe.charges.retrieve(row.chargeId);
      await sleep(120);
      if (charge.amount_refunded > 0) {
        await db
          .update(payments)
          .set({ refundedCents: charge.amount_refunded, refundedAt: new Date() })
          .where(eq(payments.id, row.id));
        console.log(`  charge ${row.chargeId}: refunded $${(charge.amount_refunded / 100).toFixed(2)}`);
      }
    } catch (err) {
      console.warn(`  ! charge ${row.chargeId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ---- Parity check ----------------------------------------------------------
// Compare backfilled package gross against the legacy packageSelected-derived
// revenue. A delta is bug (a) — a checkout attempt overwrote packageSelected —
// showing up in dollars. (getRevenue() still uses the legacy derivation until
// the final step of the build flips it onto this ledger.)
const legacy = await getRevenue();
console.log(`\n--- parity ---`);
console.log(`packages: backfill $${(recordedPackageCents / 100).toFixed(2)}  vs legacy getRevenue $${(legacy.packageCents / 100).toFixed(2)}`);
const delta = recordedPackageCents - legacy.packageCents;
if (delta !== 0) {
  console.warn(`  ⚠ package delta $${(delta / 100).toFixed(2)} — inspect the anomalies above (${anomalies} flagged).`);
}
console.log(`self-serve: backfill $${(recordedSelfServeCents / 100).toFixed(2)}  vs legacy getRevenue $${(legacy.selfServeCents / 100).toFixed(2)}`);
console.log(`\n${commit ? "Committed." : "Dry run complete — re-run with --commit to write."} Anomalies: ${anomalies}.`);

process.exit(0);
