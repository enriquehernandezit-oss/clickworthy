import Stripe from "stripe";

let cached: Stripe | null = null;

// Lazily constructed so importing this module never throws when
// STRIPE_SECRET_KEY isn't set yet (e.g. at build time) — it only throws once
// a route actually tries to create a Checkout Session.
export function getStripe(): Stripe {
  if (cached) return cached;

  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error(
      "STRIPE_SECRET_KEY is not configured — cannot create a Checkout Session."
    );
  }

  cached = new Stripe(secretKey);
  return cached;
}
