// Seed the DB with demo data so every Financials section has something to show,
// then wipe it just as easily.
//   bun --env-file=.env.local run scripts/seed-demo.ts          # insert demo data
//   bun --env-file=.env.local run scripts/seed-demo.ts --clear  # remove ALL of it
//
// Everything it writes is tagged so cleanup is exact and total:
//   restaurants.google_place_id  like 'demo_seed_%'
//   magic_links.token            like 'demo_%'
//   enhancement_orders.stripe_session_id like 'demo_ss_%'
//   payments.ledger_key          like 'demo:%'
// Nothing real matches those patterns, so --clear can't touch genuine rows.

import { like, sql } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, outreachJobs, magicLinks, enhancementOrders, payments } from "@/db/schema";
import { type PackageId } from "@/lib/packages";
import { getPackages } from "@/lib/settings";
import { totalPriceCents } from "@/lib/pricing";

const clear = process.argv.includes("--clear");
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const feeOf = (gross: number) => Math.round(gross * 0.029) + 30;

// ---- CLEAR ----------------------------------------------------------------
if (clear) {
  // Delete children before parents (payments references all three others).
  const p = await db.delete(payments).where(like(payments.ledgerKey, "demo:%")).returning({ id: payments.id });
  const m = await db.delete(magicLinks).where(like(magicLinks.token, "demo_%")).returning({ id: magicLinks.id });
  await db.execute(
    sql`delete from outreach_jobs where restaurant_id in (select id from restaurants where google_place_id like 'demo_seed_%')`
  );
  const e = await db
    .delete(enhancementOrders)
    .where(like(enhancementOrders.stripeSessionId, "demo_ss_%"))
    .returning({ id: enhancementOrders.id });
  const r = await db.delete(restaurants).where(like(restaurants.googlePlaceId, "demo_seed_%")).returning({ id: restaurants.id });
  console.log(`Cleared demo data — payments:${p.length} magic_links:${m.length} orders:${e.length} restaurants:${r.length}`);
  process.exit(0);
}

// ---- SEED -----------------------------------------------------------------
type Status = "contacted" | "queued" | "rejected" | "needs_manual_email";
const REST: { key: string; name: string; city: string; email: string; status: Status; newOpening: boolean; photos: number; sourced: number }[] = [
  { key: "r1", name: "Casa del Sol", city: "Miami, FL", email: "maria@casadelsol.com", status: "contacted", newOpening: false, photos: 14, sourced: 150 },
  { key: "r2", name: "La Playa Grill", city: "Miami, FL", email: "hola@laplaya.com", status: "contacted", newOpening: true, photos: 9, sourced: 120 },
  { key: "r3", name: "Brooklyn Bites", city: "New York, NY", email: "eat@brooklynbites.com", status: "contacted", newOpening: false, photos: 18, sourced: 95 },
  { key: "r4", name: "Empire Eats", city: "New York, NY", email: "chef@empireeats.com", status: "contacted", newOpening: false, photos: 11, sourced: 80 },
  { key: "r5", name: "Windy City Kitchen", city: "Chicago, IL", email: "info@windycitykitchen.com", status: "contacted", newOpening: true, photos: 13, sourced: 60 },
  { key: "r6", name: "Deep Dish Co", city: "Chicago, IL", email: "hi@deepdishco.com", status: "contacted", newOpening: false, photos: 16, sourced: 175 },
  { key: "r7", name: "Sunset Tacos", city: "Los Angeles, CA", email: "tacos@sunset.la", status: "contacted", newOpening: false, photos: 12, sourced: 70 },
  { key: "r8", name: "Ocean Drive Cafe", city: "Miami, FL", email: "cafe@oceandrive.com", status: "contacted", newOpening: false, photos: 8, sourced: 45 },
  { key: "r9", name: "Manhattan Diner", city: "New York, NY", email: "diner@manhattan.com", status: "contacted", newOpening: false, photos: 7, sourced: 30 },
  { key: "r10", name: "Lakeview Bistro", city: "Chicago, IL", email: "", status: "rejected", newOpening: false, photos: 5, sourced: 40 },
  { key: "r11", name: "Venice Bowls", city: "Los Angeles, CA", email: "bowls@venice.la", status: "queued", newOpening: false, photos: 6, sourced: 15 },
  { key: "r12", name: "Little Havana Grill", city: "Miami, FL", email: "", status: "needs_manual_email", newOpening: false, photos: 4, sourced: 20 },
];

const insertedRests = await db
  .insert(restaurants)
  .values(
    REST.map((r) => ({
      name: r.name,
      googlePlaceId: `demo_seed_${r.key}`,
      city: r.city,
      email: r.email || null,
      emailSource: r.email ? "website" : null,
      enrichmentStatus: r.status,
      isNewOpening: r.newOpening,
      photoCount: r.photos,
      avgPhotoScore: 6.5,
      priorityScore: 70,
      language: "en",
      contactFirstName: r.name.split(" ")[0],
      signatureDish: "house special",
      createdAt: daysAgo(r.sourced),
      lastContactedAt: daysAgo(r.sourced - 2),
    }))
  )
  .returning({ id: restaurants.id, gpid: restaurants.googlePlaceId });

const restId = new Map(insertedRests.map((r) => [r.gpid?.replace("demo_seed_", "") ?? "", r.id]));

// Outreach: one Touch-1 send per restaurant; the payers + a couple leads replied.
const repliedKeys = new Set(["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r9"]);
await db.insert(outreachJobs).values(
  REST.map((r) => ({
    restaurantId: restId.get(r.key)!,
    touchNumber: 1,
    subject: `Quick idea for ${r.name}`,
    status: repliedKeys.has(r.key) ? "replied" : "sent",
    sentAt: daysAgo(r.sourced - 3),
    repliedAt: repliedKeys.has(r.key) ? daysAgo(r.sourced - 4) : null,
  }))
);

// Package deals → a magic link + a ledger payment each.
type Deal = { rest: string; pkg: PackageId; paid: number; photos: number; failed: number; manual?: boolean; estimated?: boolean };
const DEALS: Deal[] = [
  { rest: "r1", pkg: "glow_up", paid: 130, photos: 8, failed: 0 },
  { rest: "r1", pkg: "glow_up", paid: 20, photos: 6, failed: 1 }, // repeat buyer
  { rest: "r2", pkg: "grand_opening", paid: 100, photos: 12, failed: 0 },
  { rest: "r3", pkg: "glow_up", paid: 70, photos: 8, failed: 0 },
  { rest: "r4", pkg: "always_fresh", paid: 40, photos: 8, failed: 0, manual: true }, // off-Stripe
  { rest: "r5", pkg: "grand_opening", paid: 25, photos: 10, failed: 1 },
  { rest: "r6", pkg: "glow_up", paid: 175, photos: 8, failed: 0 },
  { rest: "r6", pkg: "glow_up", paid: 10, photos: 7, failed: 0 }, // repeat buyer
  { rest: "r7", pkg: "glow_up", paid: 55, photos: 9, failed: 1, estimated: true },
];

const pkgResults = (n: number, failed: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: `dish-${i + 1}.jpg`,
    originalUrl: `https://demo.local/orig-${i + 1}.jpg`,
    enhancedUrl: i < n - failed ? `https://demo.local/enh-${i + 1}.jpg` : null,
    error: i < n - failed ? null : "enhancement failed",
  }));

const packages = await getPackages();
for (let i = 0; i < DEALS.length; i++) {
  const d = DEALS[i];
  const rid = restId.get(d.rest)!;
  const price = packages[d.pkg].priceCents;
  const token = `demo_${d.rest}_${i}`;
  const paidAt = daysAgo(d.paid);

  const [ml] = await db
    .insert(magicLinks)
    .values({
      token,
      restaurantId: rid,
      reviewStatus: "approved",
      packageSelected: d.pkg,
      stripeSessionId: `demo_sess_${token}`,
      paidAt,
      packageStatus: "completed",
      packageResults: pkgResults(d.photos, d.failed),
      deliveredAt: daysAgo(d.paid - 2),
      viewedAt: daysAgo(d.paid + 1),
      touch2SentAt: daysAgo(d.paid + 3),
      createdAt: daysAgo(d.paid + 5),
    })
    .returning({ id: magicLinks.id });

  const gross = price;
  const fee = d.manual ? 0 : feeOf(gross);
  await db.insert(payments).values({
    ledgerKey: `demo:pkg:${token}`,
    line: "package",
    method: d.manual ? "manual" : "stripe",
    packageId: d.pkg,
    description: `${packages[d.pkg].name.en}${d.manual ? " (manual)" : ""}`,
    grossCents: gross,
    feeCents: fee,
    netCents: gross - fee,
    currency: "usd",
    feeSource: d.manual ? "none" : d.estimated ? "estimated" : "stripe",
    restaurantId: rid,
    magicLinkId: ml.id,
    stripeChargeId: d.manual ? null : `demo_ch_${token}`,
    paidAt,
  });
}

// Self-serve orders → an enhancement order + a ledger payment each.
const ssResults = (n: number, failed: number) =>
  Array.from({ length: n }, (_, i) => ({
    originalName: `photo-${i + 1}.jpg`,
    enhancedUrl: i < n - failed ? `https://demo.local/e-${i + 1}.jpg` : null,
    error: i < n - failed ? null : "enhancement failed",
  }));
const ssPhotos = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ originalName: `photo-${i + 1}.jpg`, contentType: "image/jpeg", url: `https://demo.local/p-${i + 1}.jpg` }));

const SELF_SERVE = [
  { session: "demo_ss_1", email: "maria@casadelsol.com", photos: 1, failed: 0, paid: 120 }, // email matches r1 → "inferred"
  { session: "demo_ss_2", email: "walkin1@gmail.com", photos: 6, failed: 0, paid: 50 },
  { session: "demo_ss_3", email: "walkin1@gmail.com", photos: 4, failed: 1, paid: 15 }, // repeat buyer
  { session: "demo_ss_4", email: "chef@empireeats.com", photos: 12, failed: 0, paid: 25 }, // matches r4 → "inferred"
];

for (const s of SELF_SERVE) {
  const total = totalPriceCents(s.photos);
  const paidAt = daysAgo(s.paid);
  const [ord] = await db
    .insert(enhancementOrders)
    .values({
      stripeSessionId: s.session,
      prompt: "Make my dishes look vibrant and appetizing",
      photoCount: s.photos,
      totalCents: total,
      storageType: "r2",
      photos: ssPhotos(s.photos),
      status: "completed",
      results: ssResults(s.photos, s.failed),
      createdAt: daysAgo(s.paid + 1),
      completedAt: paidAt,
    })
    .returning({ id: enhancementOrders.id });

  const fee = feeOf(total);
  await db.insert(payments).values({
    ledgerKey: `demo:ss:${s.session}`,
    line: "self_serve",
    method: "stripe",
    description: `${s.photos} enhanced photo${s.photos === 1 ? "" : "s"}`,
    grossCents: total,
    feeCents: fee,
    netCents: total - fee,
    currency: "usd",
    feeSource: "stripe",
    customerEmail: s.email,
    enhancementOrderId: ord.id,
    stripeSessionId: s.session,
    stripeChargeId: `demo_ch_${s.session}`,
    paidAt,
  });
}

console.log(`Seeded: ${REST.length} restaurants, ${DEALS.length} package payments, ${SELF_SERVE.length} self-serve orders.`);
console.log("Refresh /admin/photo/financials to see it. Run with --clear to remove all of it.");
process.exit(0);
