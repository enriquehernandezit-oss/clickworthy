import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { magicLinks } from "@/db/schema";
import { getStripe } from "@/lib/stripe";
import { isPackageId } from "@/lib/packages";
import { getPackages } from "@/lib/settings";

function appOriginFrom(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto") ?? request.nextUrl.protocol.replace(":", "");
  const host = request.headers.get("host") ?? request.nextUrl.host;
  return `${proto}://${host}`;
}

// Creates a Stripe Checkout Session for an outreach package. Price is taken
// server-side from the live package_tiers setting (lib/packages.ts) — never
// trusted from the client.
export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { token?: string; package?: string } | null;
  if (!body || !body.token || !isPackageId(body.package)) {
    return NextResponse.json({ error: "Expected { token, package }" }, { status: 400 });
  }

  const [link] = await db.select().from(magicLinks).where(eq(magicLinks.token, body.token)).limit(1);
  if (!link || link.reviewStatus !== "approved") {
    return NextResponse.json({ error: "This link isn't available." }, { status: 404 });
  }
  // Already paid — refuse a second checkout independently of the funnel page's
  // redirect (a direct POST bypasses the page). The second payment couldn't be
  // fulfilled anyway (the upload route 409s on the in-flight order).
  if (link.paidAt) {
    return NextResponse.json({ error: "This order has already been paid." }, { status: 409 });
  }
  if (link.expiresAt && new Date(link.expiresAt).getTime() < Date.now()) {
    return NextResponse.json({ error: "This link has expired." }, { status: 410 });
  }

  const pkg = (await getPackages())[body.package];

  // Retainer tier is sold on a call, not self-serve — reject any attempt to
  // check out directly (the client hides its button, but never trust that).
  if (!pkg.checkoutEnabled) {
    return NextResponse.json({ error: "This plan is set up on a quick call, not online checkout." }, { status: 400 });
  }

  const appOrigin = appOriginFrom(request);

  let session;
  try {
    const stripe = getStripe();
    session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      allow_promotion_codes: true,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: pkg.priceCents,
            product_data: {
              name: `Clickworthy ${pkg.name.en} — ${pkg.blurb.en}`,
            },
          },
        },
      ],
      // Metadata is how the shared Stripe webhook tells an outreach package
      // payment apart from a self-serve /enhance order.
      metadata: { type: "outreach", token: link.token, package: pkg.id },
      success_url: `${appOrigin}/l/${link.token}/upload?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appOrigin}/l/${link.token}`,
    });
  } catch (err) {
    console.error("[outreach-checkout] Stripe session failed:", err);
    return NextResponse.json({ error: "We couldn't start checkout. Please try again." }, { status: 502 });
  }

  if (!session.url) {
    return NextResponse.json({ error: "We couldn't start checkout. Please try again." }, { status: 502 });
  }

  await db
    .update(magicLinks)
    .set({ packageSelected: pkg.id, stripeSessionId: session.id })
    .where(eq(magicLinks.id, link.id));

  return NextResponse.json({ url: session.url });
}
