import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { restaurants, magicLinks } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { isPackageId } from "@/lib/packages";
import { getPackages } from "@/lib/settings";

// Generates a Stripe PAYMENT LINK (not a Checkout Session) for a restaurant
// that's already agreed to a package — on a call, by email reply, however —
// so the founder can paste a link into their own message instead of walking
// the customer through the site. This is the admin-initiated counterpart to
// the self-serve /l/[token] funnel, which requires a finished sample photo to
// show package tiers at all (app/l/[token]/page.tsx:71 — "not ready" without
// one) and so can't be used for a deal that never went through that flow.
//
// Payment Link, not Checkout Session, because a Checkout Session URL expires
// in 24h — too short for "the owner gets to it in a few days." A Payment Link
// doesn't expire (the magic_links row it's tied to does, after 30 days, same
// as the rest of the funnel).
//
// A FRESH magic_links row is created per generated link, with packageSelected
// set at CREATION time (not mutated later) — unlike the funnel's checkout
// route, there's no window where a second checkout attempt on the same link
// could overwrite which package was actually paid for, because this link is
// single-purpose from the start. Repeat deals for the same restaurant just
// get another fresh link + row (the ledger already expects a restaurant to
// have multiple magic_links over time).
export async function POST(request: NextRequest) {
  const form = await request.formData();
  const restaurantId = Number(form.get("restaurantId"));
  const packageId = String(form.get("packageId") ?? "");
  const overrideRaw = form.get("overrideCents");

  if (!Number.isInteger(restaurantId)) return NextResponse.json({ error: "Bad restaurantId" }, { status: 400 });
  if (!isPackageId(packageId)) return NextResponse.json({ error: "Bad packageId" }, { status: 400 });

  const [restaurant] = await db.select().from(restaurants).where(eq(restaurants.id, restaurantId)).limit(1);
  if (!restaurant) return NextResponse.json({ error: "Restaurant not found" }, { status: 404 });

  const pkg = (await getPackages())[packageId];
  let priceCents = pkg.priceCents;
  if (overrideRaw != null && String(overrideRaw).trim() !== "") {
    const n = Number(overrideRaw);
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: "Override amount must be a positive whole number of cents." }, { status: 400 });
    }
    priceCents = n;
  }

  let stripe;
  try {
    stripe = getStripe();
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Stripe isn't configured." }, { status: 409 });
  }

  const linkToken = randomBytes(24).toString("hex");
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  const appOrigin = `${proto}://${host}`;

  let paymentLink;
  try {
    paymentLink = await stripe.paymentLinks.create({
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: priceCents,
            product_data: { name: `Clickworthy ${pkg.name.en} — ${restaurant.name}` },
          },
        },
      ],
      // Metadata on a Payment Link is automatically copied to the Checkout
      // Session it generates on payment — confirmed against the installed
      // stripe SDK's own doc comment (node_modules/stripe .../PaymentLinks.d.ts).
      // Same shape the funnel's own checkout route uses, so the EXISTING
      // webhook handler (app/api/webhooks/stripe/route.ts) attributes this
      // payment with zero changes.
      metadata: { type: "outreach", token: linkToken, package: pkg.id },
      after_completion: {
        type: "redirect",
        redirect: { url: `${appOrigin}/l/${linkToken}/upload?session_id={CHECKOUT_SESSION_ID}` },
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: `Stripe error: ${err instanceof Error ? err.message : String(err)}` },
      { status: 502 }
    );
  }

  // Written only after the Payment Link succeeds — an orphaned row with no way
  // to ever get paid is worse than the admin just clicking the button again.
  await db.insert(magicLinks).values({
    token: linkToken,
    restaurantId: restaurant.id,
    packageSelected: pkg.id,
    // No sample exists for this deal, so there's nothing to "await edit" — the
    // closest existing semantic is 'approved' (nothing pending review). Doesn't
    // risk an accidental Touch 2: that job also requires freeSampleEnhancedUrl,
    // which this row never has.
    reviewStatus: "approved",
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
  });

  return NextResponse.json({ ok: true, url: paymentLink.url, token: linkToken, priceCents });
}
