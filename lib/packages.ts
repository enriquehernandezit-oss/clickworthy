// Outreach-funnel package tiers (PROJECT_CONTEXT Section 10b — the "default/
// recommended" structure). Single source of truth: the /l/[token] page, the
// checkout route, and post-payment photo-count validation all read from here,
// so changing a price or limit is a one-line edit.
//
// Prices are in USD cents (Stripe's native unit). Standard/$50 is the settled
// launch price; Starter/$35 and Complete/$65 are the recommended defaults and
// easy to adjust.

export type PackageId = "starter" | "standard" | "complete";

export type PackageTier = {
  id: PackageId;
  name: string;
  priceCents: number;
  photoLimit: number; // max photos the customer may upload after paying
  blurb: string;
};

export const PACKAGES: Record<PackageId, PackageTier> = {
  starter: {
    id: "starter",
    name: "Starter",
    priceCents: 3500,
    photoLimit: 5,
    blurb: "Up to 5 enhanced photos",
  },
  standard: {
    id: "standard",
    name: "Standard",
    priceCents: 5000,
    photoLimit: 8,
    blurb: "Up to 8 enhanced photos",
  },
  complete: {
    id: "complete",
    name: "Complete",
    priceCents: 6500,
    photoLimit: 14,
    blurb: "Up to 14 enhanced photos",
  },
};

export const PACKAGE_ORDER: PackageId[] = ["starter", "standard", "complete"];

export function isPackageId(value: unknown): value is PackageId {
  return value === "starter" || value === "standard" || value === "complete";
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
