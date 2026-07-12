// Shared pricing formula for /enhance — imported by both the client-side
// live preview and the server-side checkout-session route so the two never
// drift. All math is done in integer cents to avoid floating-point error.
//
// Price per photo = max($1.80, $3.00 - $0.10 * (quantity - 1))
// Total price = quantity * price per photo

const MIN_PRICE_PER_PHOTO_CENTS = 180;
const BASE_PRICE_PER_PHOTO_CENTS = 300;
const PRICE_STEP_CENTS = 10;

export function pricePerPhotoCents(quantity: number): number {
  const q = Math.max(1, Math.trunc(quantity));
  return Math.max(
    MIN_PRICE_PER_PHOTO_CENTS,
    BASE_PRICE_PER_PHOTO_CENTS - PRICE_STEP_CENTS * (q - 1)
  );
}

export function totalPriceCents(quantity: number): number {
  const q = Math.max(1, Math.trunc(quantity));
  return q * pricePerPhotoCents(q);
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}
