// The cost side of the P&L. Clickworthy instruments no external API call, so
// every cost here is MODELLED: a SQL-countable event × an editable unit-cost
// assumption (stored in app_settings, edited on /admin/photo/financials). This
// file owns the two things that must stay consistent everywhere: the Stripe-fee
// estimate, and how driver counts turn into cost lines.
//
// Honesty about the model lives with the model — read the BLIND SPOTS below
// before trusting a profit number:
//
//  1. Claid retries. worker/lib/retry.ts wraps the whole ai-edit→upscale chain
//     with attempts=3, so ONE delivered photo can bill up to 3×. Not recorded.
//     Calibrate cost_claid_per_photo_cents from the invoice, which includes it.
//  2. Order retry re-bills the whole batch (app/api/admin/orders/route.ts nulls
//     `results` and re-enhances every photo, successes included) and destroys the
//     prior count. Unrecoverable from the DB.
//  3. Free-sample re-clicks overwrite freeSampleFirstPassUrl — N clicks look like 1.
//  4. Moderation on a rejected /enhance prompt 400s before any row is written
//     (~$0.0003/call — excluded as de minimis).
//  5. Storage bytes are never recorded and nothing is ever deleted, so storage
//     cost is a flat per-photo guess that drifts low over time.
//  6. Places Text Search bills per PAGE, and hard-filter rejects leave no row, so
//     cost_source_per_lead_cents amortizes over survivors, not calls.
//  7. Founder labor is not costed. Every sample and order is hand-finished, so
//     contribution here is CASH margin, not economic margin.

import type { OpexItem, SettingsMap } from "@/lib/settings";

// --- Stripe fee estimate ----------------------------------------------------
// Deliberately NOT a setting: the US card rate is published and changes ~once a
// decade, and the ledger captures the REAL fee off the balance transaction — the
// estimate only ever applies to old or unmatched rows.
export const STRIPE_PCT = 0.029;
export const STRIPE_FIXED_CENTS = 30;

export function estimateStripeFeeCents(grossCents: number): number {
  if (grossCents <= 0) return 0;
  return Math.round(grossCents * STRIPE_PCT) + STRIPE_FIXED_CENTS;
}

// --- Cost assumptions -------------------------------------------------------
// The editable unit costs, pulled straight off the settings map so there's one
// source of truth for their names and types.
export type CostAssumptions = Pick<
  SettingsMap,
  | "cost_source_per_lead_cents"
  | "cost_enrich_per_lead_cents"
  | "cost_photo_score_per_photo_cents"
  | "cost_email_per_send_cents"
  | "cost_sample_per_reply_cents"
  | "cost_claid_per_photo_cents"
  | "cost_storage_per_photo_cents"
  | "opex_items"
>;

// The seven SCALAR per-event assumptions, in display order. The settings route
// validates against this same list, and the assumptions editor renders it as
// number inputs. Fixed opex is deliberately NOT here — it's an itemized list
// (opex_items), rendered as its own breakdown rather than one opaque total.
export const COST_KEYS = [
  "cost_source_per_lead_cents",
  "cost_enrich_per_lead_cents",
  "cost_photo_score_per_photo_cents",
  "cost_email_per_send_cents",
  "cost_sample_per_reply_cents",
  "cost_claid_per_photo_cents",
  "cost_storage_per_photo_cents",
] as const;

export type CostKey = (typeof COST_KEYS)[number];

// Narrow a full settings map down to just the cost assumptions.
export function pickAssumptions(v: CostAssumptions): CostAssumptions {
  return {
    cost_source_per_lead_cents: v.cost_source_per_lead_cents,
    cost_enrich_per_lead_cents: v.cost_enrich_per_lead_cents,
    cost_photo_score_per_photo_cents: v.cost_photo_score_per_photo_cents,
    cost_email_per_send_cents: v.cost_email_per_send_cents,
    cost_sample_per_reply_cents: v.cost_sample_per_reply_cents,
    cost_claid_per_photo_cents: v.cost_claid_per_photo_cents,
    cost_storage_per_photo_cents: v.cost_storage_per_photo_cents,
    opex_items: v.opex_items,
  };
}

// Fixed monthly opex is DERIVED from the itemized list — there is no separately
// stored total to drift out of sync with the line items. RECURRING items only:
// a one-time setup fee is not monthly opex and would otherwise be charged every
// month forever (see oneTimeOpexCents).
export function opexMonthlyCents(items: OpexItem[]): number {
  return (items ?? [])
    .filter((i) => !i?.oneTimeOn)
    .reduce((sum, i) => sum + (Number.isFinite(i?.cents) ? i.cents : 0), 0);
}

export function isOneTime(i: OpexItem): boolean {
  return Boolean(i?.oneTimeOn);
}

// One-time setup fees that land inside [from, to) — charged once, in the window
// containing their date, rather than prorated across every reporting window.
// An unparseable date is skipped rather than silently counted in every window.
export function oneTimeOpexCents(items: OpexItem[], from: Date, to: Date): number {
  return (items ?? []).reduce((sum, i) => {
    if (!i?.oneTimeOn || !Number.isFinite(i?.cents)) return sum;
    const t = Date.parse(i.oneTimeOn);
    if (!Number.isFinite(t)) return sum;
    return t >= from.getTime() && t < to.getTime() ? sum + i.cents : sum;
  }, 0);
}

// Pure event counts, all straight from SQL (see lib/financeStats.ts). No cost
// math lives in the DB — it's applied here so the P&L, the per-client table, and
// the segment rollups share one formula and can't drift.
export type CostDrivers = {
  leadsSourced: number;
  leadsEnriched: number;
  photosScored: number;
  emailsSent: number;
  samplesCreated: number;
  photosDelivered: number; // enhancedUrl is not null
  photosFailed: number; // enhancedUrl is null — billed anyway (see blind spot 1)
};

export type CostBucket = "acquire" | "serve";

export type CostLine = {
  key: CostKey | "claid_failed";
  label: string;
  bucket: CostBucket;
  count: number;
  unitLabel: string; // e.g. "leads sourced" — already pluralized
  unitCents: number; // may be fractional
  totalCents: number; // integer cents, rounded
  estimate: true; // every modelled line is an estimate; the UI marks them
};

// Variable cost lines only — fixed opex is apportioned separately (see below) so
// it never lands in a per-client contribution number. `acquire` = spent getting
// the lead to a sale; `serve` = spent fulfilling once they paid.
export function buildCostLines(d: CostDrivers, a: CostAssumptions): CostLine[] {
  const line = (
    key: CostLine["key"],
    label: string,
    bucket: CostBucket,
    count: number,
    unitLabel: string,
    unitCents: number
  ): CostLine => ({
    key,
    label,
    bucket,
    count,
    unitLabel,
    unitCents,
    totalCents: Math.round(count * unitCents),
    estimate: true,
  });

  return [
    line("cost_source_per_lead_cents", "Lead sourcing (Google Places)", "acquire", d.leadsSourced, "leads sourced", a.cost_source_per_lead_cents),
    line("cost_enrich_per_lead_cents", "Enrichment (Claude + NeverBounce)", "acquire", d.leadsEnriched, "leads enriched", a.cost_enrich_per_lead_cents),
    line("cost_photo_score_per_photo_cents", "Photo scoring (Places Photo + Vision)", "acquire", d.photosScored, "photos scored", a.cost_photo_score_per_photo_cents),
    line("cost_email_per_send_cents", "Cold email (Gmail)", "acquire", d.emailsSent, "emails sent", a.cost_email_per_send_cents),
    line("cost_sample_per_reply_cents", "Free samples (copy + Claid first pass)", "acquire", d.samplesCreated, "samples created", a.cost_sample_per_reply_cents),
    line("cost_claid_per_photo_cents", "Claid production", "serve", d.photosDelivered, "photos delivered", a.cost_claid_per_photo_cents),
    line("claid_failed", "Claid — failed photos, billed anyway", "serve", d.photosFailed, "photos failed", a.cost_claid_per_photo_cents),
    line("cost_storage_per_photo_cents", "Storage (R2 + egress)", "serve", d.photosDelivered, "photos stored", a.cost_storage_per_photo_cents),
  ];
}

export function sumCostLines(lines: CostLine[]): number {
  return lines.reduce((sum, l) => sum + l.totalCents, 0);
}

export function sumBucket(lines: CostLine[], bucket: CostBucket): number {
  return lines.reduce((sum, l) => (l.bucket === bucket ? sum + l.totalCents : sum), 0);
}

// Fixed monthly opex (the itemized subscriptions in opex_items) apportioned to
// a window. Average month = 365.25/12 = 30.4375 days, so "last 30d" ≈ one month
// and a year ≈ 12. Exact calendar proration would be ~3% tighter at month
// boundaries and isn't worth the complexity here.
const AVG_MONTH_DAYS = 30.4375;

export function apportionFixedCents(a: CostAssumptions, rangeDays: number): number {
  if (rangeDays <= 0) return 0;
  return Math.round((opexMonthlyCents(a.opex_items) / AVG_MONTH_DAYS) * rangeDays);
}
