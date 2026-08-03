// High-ticket offer tiers. Single source of truth: the /l/[token] funnel, the
// landing page, the checkout route, and post-payment photo-count validation all
// read from here, so changing a price/limit is a one-line edit.
//
// Prices are in USD cents (Stripe's native unit). Menu Glow-Up $499 is the main
// cold-outreach sale; Grand Opening $899 is for new openings; Always Fresh
// $249/mo is the retainer — sold on a call, so it has NO self-serve checkout
// (checkoutEnabled: false) and renders a "book a call" CTA instead.

export type PackageId = "glow_up" | "grand_opening" | "always_fresh";

export type PackageTier = {
  id: PackageId;
  name: { en: string; es: string };
  priceCents: number;
  photoLimit: number; // max photos the customer may upload (per delivery / per month)
  blurb: { en: string; es: string };
  billingNote: { en: string; es: string };
  checkoutEnabled: boolean; // false => booking-call CTA instead of Stripe Checkout
};

export const PACKAGES: Record<PackageId, PackageTier> = {
  glow_up: {
    id: "glow_up",
    name: { en: "Menu Glow-Up", es: "Renovación de Menú" },
    priceCents: 49900,
    photoLimit: 30,
    blurb: {
      en: "Up to 30 dishes enhanced, sized for your site, Google, Instagram & Yelp",
      es: "Hasta 30 platos mejorados, listos para su sitio, Google, Instagram y Yelp",
    },
    billingNote: { en: "one-time", es: "pago único" },
    checkoutEnabled: true,
  },
  grand_opening: {
    id: "grand_opening",
    name: { en: "Grand Opening Package", es: "Paquete de Apertura" },
    priceCents: 89900,
    photoLimit: 40,
    blurb: {
      en: "Up to 40 photos — dishes plus interior & exterior, social-ready",
      es: "Hasta 40 fotos — platos más interior y exterior, listas para redes",
    },
    billingNote: { en: "one-time", es: "pago único" },
    checkoutEnabled: true,
  },
  always_fresh: {
    id: "always_fresh",
    name: { en: "Always Fresh", es: "Siempre Fresco" },
    priceCents: 24900,
    photoLimit: 8,
    blurb: {
      en: "8 photos/month — specials & seasonal items kept looking their best",
      es: "8 fotos al mes — especiales y platos de temporada siempre impecables",
    },
    billingNote: { en: "per month · 3-month minimum", es: "por mes · mínimo 3 meses" },
    checkoutEnabled: false,
  },
};

export const PACKAGE_ORDER: PackageId[] = ["glow_up", "grand_opening", "always_fresh"];

export function isPackageId(value: unknown): value is PackageId {
  return value === "glow_up" || value === "grand_opening" || value === "always_fresh";
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
