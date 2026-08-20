import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';

export const restaurants = pgTable('restaurants', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  googlePlaceId: text('google_place_id').unique(),
  rating: real('rating'),
  reviewCount: integer('review_count'),
  priceLevel: integer('price_level'),
  city: text('city'),
  phone: text('phone'),
  website: text('website'),
  email: text('email'),
  emailRank: integer('email_rank'),
  temporarilyClosed: boolean('temporarily_closed').default(false),
  isHospitalityGroup: boolean('is_hospitality_group').default(false),
  // --- Phase 1 lead-engine enrichment ---
  deliveryEnabled: boolean('delivery_enabled').default(false),
  language: text('language').default('en'), // 'en' | 'es' — US-based; Miami may skew bilingual, set per-restaurant
  priorityScore: real('priority_score'), // higher = contact sooner (see lib/priority.ts)
  photoCount: integer('photo_count'), // owner-uploaded photo count from Google (priority signal, never a filter)
  photosScored: integer('photos_scored'), // how many photos enrichment actually ran Claude Vision on (cost/coverage; distinct from photoCount so the priority signal stays the raw Google count)
  avgPhotoScore: real('avg_photo_score'), // mean Claude Vision score across scored photos
  // --- Phase 2 website photo-fit gate (worker/lib/photoFit.ts). Stored on every
  //     enriched lead (kept OR rejected) so the feedback loop can compare these
  //     signals against the human's later approve/skip decisions and recalibrate
  //     the reject threshold (see scripts/calibrate-threshold.ts). ---
  websitePhotoBand: text('website_photo_band'), // 'rich' | 'unclear' | 'sparse' (Gate 1)
  websitePhotoRichness: integer('website_photo_richness'), // 0–100 structural richness (Gate 1)
  websiteProScore: integer('website_pro_score'), // best real-photo Vision score 2–6 (Gate 2); null if sparse / unjudged
  emailSource: text('email_source'), // 'website' | 'manual' | null — where `email` came from
  // Personalization for the cold email (derived in enrichment):
  signatureDish: text('signature_dish'), // a real standout dish, from Claude Vision — the #1 reply-rate lever
  contactFirstName: text('contact_first_name'), // best-effort owner name; null -> generic greeting
  isNewOpening: boolean('is_new_opening').default(false), // hints the Grand Opening package
  held: boolean('held').default(false), // manually pulled out of drafting (via /admin); skip until unheld
  rejectionReason: text('rejection_reason'), // why enrichment set status='rejected' (e.g. the chain-check reasoning)
  // Pipeline lifecycle: sourced -> enriched -> queued -> contacted (or needs_manual_email / rejected)
  enrichmentStatus: text('enrichment_status').default('sourced'),
  lastContactedAt: timestamp('last_contacted_at'),
  suppressed: boolean('suppressed').default(false), // opted out / do-not-contact
  createdAt: timestamp('created_at').defaultNow(),
});

export const photos = pgTable('photos', {
  id: serial('id').primaryKey(),
  restaurantId: integer('restaurant_id').references(() => restaurants.id),
  sourceUrl: text('source_url').notNull(),
  qualityScore: integer('quality_score'),
  enhancementValueScore: integer('enhancement_value_score'),
  category: text('category'),
  enhanced: boolean('enhanced').default(false),
  enhancedUrl: text('enhanced_url'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const outreachJobs = pgTable('outreach_jobs', {
  id: serial('id').primaryKey(),
  restaurantId: integer('restaurant_id').references(() => restaurants.id),
  // Which magic link this row's email belongs to, when it's tied to one
  // (touch2/delivery/payment_confirmation always; reply usually; touch1/bump/
  // manual never — no magic link exists yet at that point). Lets "resend the
  // delivery email" for a repeat customer grab the right order instead of just
  // the most recent one for the restaurant.
  magicLinkId: integer('magic_link_id').references(() => magicLinks.id),
  touchNumber: integer('touch_number').default(1),
  // What this row actually is — the discriminator every query must filter on.
  // touchNumber alone is NOT enough (touch1 and bump both use 1). 'touch1' |
  // 'bump' | 'touch2' | 'reply' | 'delivery' | 'payment_confirmation' | 'manual'.
  // Nullable: old rows are backfilled once, every insert site going forward
  // sets it explicitly.
  kind: text('kind'),
  subject: text('subject'), // stored so the exact reviewed subject is what actually sends
  emailContent: text('email_content'),
  // Touch 1 approval flow: a run drafts (status 'draft', draftedAt set), a human
  // approves in /admin (status 'approved', approvedAt set), the next send run
  // sends it (status 'sent', sentAt + gmail ids set). Stale drafts -> 'cancelled'.
  // 'denied' is the terminal "a human said no" state for bump/reply/payment_confirmation drafts.
  draftedAt: timestamp('drafted_at'),
  approvedAt: timestamp('approved_at'),
  sentAt: timestamp('sent_at'),
  repliedAt: timestamp('replied_at'),
  status: text('status').default('pending'),
  // Gmail message + thread ids so the reply poller (Phase 2) can match inbound
  // replies back to the outreach they answer.
  gmailMessageId: text('gmail_message_id'),
  gmailThreadId: text('gmail_thread_id'),
  // What they actually wrote back (all reply branches: photo, no-photo, STOP) —
  // so a question like "how much?" is readable in /admin instead of vanishing
  // into a worker log.
  replyBody: text('reply_body'),
  replyFrom: text('reply_from'),
  // Gmail message id of the most recently PROCESSED reply in this thread. The
  // poller re-lists the same inbox window every run, so this is what lets it
  // recognize "already handled" per-message rather than per-thread — without
  // it, a second message in an already-replied thread either gets silently
  // dropped (old behavior) or re-alerted on every 4-minute run for 7 days.
  lastReplyMessageId: text('last_reply_message_id'),
});

// Money ledger — one row per REAL money movement, across both revenue lines.
// Redefined from the old dead `payments` table (nothing ever wrote it — see
// HANDOFF.md "Dead tables"). ADDITIVE + analytics-only: fulfillment state still
// lives on enhancementOrders.status / magicLinks.paidAt, and nothing in the
// customer path reads this. Written by the Stripe webhook and the backfill
// script (both via lib/paymentLedger.ts). The FK columns point at tables
// declared later in this file; drizzle resolves the `() =>` thunks lazily, so
// the forward reference is fine.
export const payments = pgTable(
  'payments',
  {
    id: serial('id').primaryKey(),

    // Total natural key + idempotency handle. Stripe rows use the charge id;
    // manual (check/Zelle) rows use "manual:ml:{magicLinkId}"; a Stripe row whose
    // charge isn't known yet falls back to "session:{id}". One always-populated
    // UNIQUE column means the webhook, its retries, and the backfill all converge
    // on the same ON CONFLICT — a unique on stripe_charge_id alone wouldn't dedupe
    // manual rows, since Postgres treats every NULL as distinct.
    ledgerKey: text('ledger_key').notNull().unique(),

    // What was sold.
    line: text('line').notNull(), // 'self_serve' | 'package'
    method: text('method').notNull(), // 'stripe' | 'manual'
    // The package ACTUALLY paid for, snapshotted from session.metadata.package.
    // magicLinks.packageSelected is overwritten on every checkout attempt, so it
    // isn't trustworthy after the fact (see app/api/outreach/checkout/route.ts).
    packageId: text('package_id'),
    description: text('description'), // human-readable ledger line

    // Money — all integer cents, Stripe's native unit.
    grossCents: integer('gross_cents').notNull(),
    feeCents: integer('fee_cents').notNull().default(0),
    netCents: integer('net_cents').notNull(), // Stripe's own net (accounts for FX), not gross-fee
    refundedCents: integer('refunded_cents').notNull().default(0),
    currency: text('currency').notNull().default('usd'),
    // 'stripe' = read off the charge's balance_transaction (authoritative)
    // 'estimated' = 2.9% + $0.30 fallback (old rows, or the BT wasn't available)
    // 'none' = manual/off-Stripe payment, there is no processor fee
    feeSource: text('fee_source').notNull(),

    // Who.
    customerEmail: text('customer_email'), // session.customer_details.email
    restaurantId: integer('restaurant_id').references(() => restaurants.id),

    // What it paid for — two real FKs + the `line` discriminator, not a
    // polymorphic (type, id) pair (which couldn't be a foreign key).
    enhancementOrderId: integer('enhancement_order_id').references(() => enhancementOrders.id),
    magicLinkId: integer('magic_link_id').references(() => magicLinks.id),

    // Stripe references.
    stripeSessionId: text('stripe_session_id'),
    stripeChargeId: text('stripe_charge_id'),
    stripePaymentIntentId: text('stripe_payment_intent_id'),
    stripeBalanceTxnId: text('stripe_balance_txn_id'),

    // Time. paidAt = when the money moved (charge.created); ALL P&L buckets on it.
    // createdAt = when we wrote the row (differs for backfilled rows).
    paidAt: timestamp('paid_at').notNull(),
    refundedAt: timestamp('refunded_at'),
    createdAt: timestamp('created_at').defaultNow(),
  },
  (t) => [
    index('payments_paid_at_idx').on(t.paidAt),
    index('payments_restaurant_idx').on(t.restaurantId),
    index('payments_charge_idx').on(t.stripeChargeId),
  ]
);

// One row per /enhance checkout: the shared prompt, photo references, and
// (once the webhook has run) the Claid enhancement results.
export const enhancementOrders = pgTable('enhancement_orders', {
  id: serial('id').primaryKey(),
  stripeSessionId: text('stripe_session_id').notNull().unique(),
  prompt: text('prompt').notNull(),
  photoCount: integer('photo_count').notNull(),
  totalCents: integer('total_cents').notNull(),
  storageType: text('storage_type').notNull(), // 'r2' | 'postgres_blob'
  // Array of { originalName, contentType, url } — url is either a public R2
  // URL or an absolute link to /api/enhance/photo/[id] (see storageType).
  photos: jsonb('photos').notNull(),
  status: text('status').notNull().default('pending'), // pending | processing | completed | failed
  // Array of { originalName, enhancedUrl, error } once the webhook has processed the order.
  results: jsonb('results'),
  createdAt: timestamp('created_at').defaultNow(),
  completedAt: timestamp('completed_at'),
});

// Fallback blob storage for uploaded photos when R2 credentials aren't configured.
// TODO: drop this table (and the postgres_blob storage path in lib/storage.ts)
// once R2 is wired in everywhere — base64-in-Postgres is a stopgap only.
export const enhancementPhotoBlobs = pgTable('enhancement_photo_blobs', {
  id: serial('id').primaryKey(),
  orderStripeSessionId: text('order_stripe_session_id').notNull(),
  contentType: text('content_type').notNull(),
  data: text('data').notNull(), // base64-encoded image bytes
  createdAt: timestamp('created_at').defaultNow(),
});

// One row per outreach magic link (Phase 3). Created when a restaurant replies
// with a photo; the token is the URL of the /l/[token] conversion page.
export const magicLinks = pgTable('magic_links', {
  id: serial('id').primaryKey(),
  token: text('token').notNull().unique(),
  restaurantId: integer('restaurant_id').references(() => restaurants.id),
  revenueImpactCopy: text('revenue_impact_copy'), // pre-generated Claude narrative
  // The one free sample: the customer's emailed original + its Claid-enhanced result.
  freeSampleOriginalUrl: text('free_sample_original_url'),
  // Optional Claid "first pass" rough (a human downloads it, finishes editing,
  // and re-uploads the finished version to freeSampleEnhancedUrl).
  freeSampleFirstPassUrl: text('free_sample_first_pass_url'),
  freeSampleEnhancedUrl: text('free_sample_enhanced_url'), // the FINISHED, human-approved photo
  qualifyingPhotoCount: integer('qualifying_photo_count'), // blurred-count teaser on the page
  // Human-in-the-loop gate. A reply lands as `awaiting_edit`; Enrique/Jose edit
  // by hand (optionally from a Claid first pass), upload the finished photo, and
  // approve. awaiting_edit -> approved | rejected. Approving is what sends Touch 2.
  reviewStatus: text('review_status').default('awaiting_edit'),
  packageSelected: text('package_selected'), // 'starter' | 'standard' | 'complete' | null until chosen
  stripeSessionId: text('stripe_session_id'),
  paidAt: timestamp('paid_at'), // set by the Stripe webhook once the package is paid
  // Uploaded originals awaiting enhancement: array of { name, url }.
  packageOriginals: jsonb('package_originals'),
  // Delivery data for the paid package: array of { name, originalUrl, enhancedUrl, error }.
  packageResults: jsonb('package_results'),
  // null | processing (Claid first pass running) | ready_for_review (human finishes
  // + approves each photo in /admin) | completed (delivered) | failed.
  packageStatus: text('package_status'),
  expiresAt: timestamp('expires_at'),
  viewedAt: timestamp('viewed_at'),
  touch2SentAt: timestamp('touch2_sent_at'), // set once the approved sample + link email goes out
  deliveredAt: timestamp('delivered_at'), // set when a paid package is marked delivered in /admin
  createdAt: timestamp('created_at').defaultNow(),
});

// Key/value app settings the worker + admin both read at run time (never cached
// at module load). Holds the outreach pause + autosend toggles and the worker's
// last-boot env snapshot. Value is JSON so booleans/objects share one table.
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value'),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Admin console users (Enrique + Jose). Created only via
// scripts/create-admin-user.ts — no public signup. Passwords are scrypt-hashed
// with a per-user salt (see lib/auth.ts); the raw password is never stored.
export const adminUsers = pgTable('admin_users', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  passwordHash: text('password_hash').notNull(),
  passwordSalt: text('password_salt').notNull(),
  role: text('role').notNull().default('admin'), // 'admin' | 'owner' — cosmetic for now
  createdAt: timestamp('created_at').defaultNow(),
  lastLoginAt: timestamp('last_login_at'),
});

// Do-not-contact list. Any email here is skipped by the outreach sender.
// Populated by "reply STOP" opt-outs and hard bounces.
export const suppressions = pgTable('suppressions', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  reason: text('reason'), // 'opt_out' | 'bounce' | 'complaint' | 'manual'
  createdAt: timestamp('created_at').defaultNow(),
});
