// High-ticket offer tiers — the CLIENT-SAFE half. Outreach-only — never shown
// on the public landing page (see the rule reasserted in HANDOFF.md and
// PIPELINE.md).
//
// This file is imported by client components (FunnelClient.tsx,
// PaymentLinkForm.tsx) for the pure/sync pieces below, so it must NEVER
// acquire a runtime dependency on lib/settings.ts — that file imports @/db,
// and db/index.ts calls postgres(...) at module scope, a side effect no
// bundler can tree-shake away. (Confirmed the hard way: even routing the
// import through a dynamic import() still pulled postgres into the client
// bundle and broke the production build — "Module not found: Can't resolve
// 'tls'". Turbopack apparently still walks a same-file dynamic import for its
// module graph.) The `import type` below is safe regardless — type-only
// imports are erased entirely at compile time, no runtime edge at all.
//
// The tier DATA (name, price, photo limit, blurb, billing note) is
// operator-editable on /admin/photo/templates and lives in the
// `package_tiers` setting. For the LIVE values, call getPackages() —
// `import { getPackages } from "@/lib/settings"` — which lives there
// specifically so this file stays clean. Everything that charges money or
// promises a photo count MUST go through it, never assume today's values, or
// the email/checkout/limit can drift from what the operator set. That drift
// is exactly what this file used to allow: a hardcoded constant here,
// duplicated as prose in the Touch 2 template, held in sync by nothing but a
// code comment.
//
// ids are permanent — persisted in payments.packageId and
// magicLinks.packageSelected, and app/admin/photo/clients/page.tsx matches
// "always_fresh" directly in SQL — so only the display fields are editable,
// never the id or the tier count.

import type { PackageId, PackageTier } from "./settings";

export type { PackageId, PackageTier };

export const PACKAGE_ORDER: PackageId[] = ["glow_up", "grand_opening", "always_fresh"];

export function isPackageId(value: unknown): value is PackageId {
  return value === "glow_up" || value === "grand_opening" || value === "always_fresh";
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}
