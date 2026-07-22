import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
  jsonb,
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
  avgPhotoScore: real('avg_photo_score'), // mean Claude Vision score across scored photos
  emailSource: text('email_source'), // 'website' | 'manual' | null — where `email` came from
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
  touchNumber: integer('touch_number').default(1),
  emailContent: text('email_content'),
  sentAt: timestamp('sent_at'),
  repliedAt: timestamp('replied_at'),
  status: text('status').default('pending'),
  // Gmail message + thread ids so the reply poller (Phase 2) can match inbound
  // replies back to the outreach they answer.
  gmailMessageId: text('gmail_message_id'),
  gmailThreadId: text('gmail_thread_id'),
});

export const payments = pgTable('payments', {
  id: serial('id').primaryKey(),
  restaurantId: integer('restaurant_id').references(() => restaurants.id),
  amountCents: integer('amount_cents'),
  stripePaymentId: text('stripe_payment_id'),
  status: text('status'),
  createdAt: timestamp('created_at').defaultNow(),
});

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
  freeSampleEnhancedUrl: text('free_sample_enhanced_url'),
  qualifyingPhotoCount: integer('qualifying_photo_count'), // blurred-count teaser on the page
  // Human-in-the-loop gate: the AI-enhanced sample must be approved before the
  // Touch 2 email + magic link go out. pending_review -> approved | rejected.
  reviewStatus: text('review_status').default('pending_review'),
  packageSelected: text('package_selected'), // 'starter' | 'standard' | 'complete' | null until chosen
  stripeSessionId: text('stripe_session_id'),
  paidAt: timestamp('paid_at'), // set by the Stripe webhook once the package is paid
  // Uploaded originals awaiting enhancement: array of { name, url }.
  packageOriginals: jsonb('package_originals'),
  // Delivery data for the paid package: array of { name, originalUrl, enhancedUrl, error }.
  packageResults: jsonb('package_results'),
  packageStatus: text('package_status'), // null | processing | completed | failed (post-upload)
  expiresAt: timestamp('expires_at'),
  viewedAt: timestamp('viewed_at'),
  touch2SentAt: timestamp('touch2_sent_at'), // set once the approved sample + link email goes out
  createdAt: timestamp('created_at').defaultNow(),
});

// Do-not-contact list. Any email here is skipped by the outreach sender.
// Populated by "reply STOP" opt-outs and hard bounces.
export const suppressions = pgTable('suppressions', {
  id: serial('id').primaryKey(),
  email: text('email').notNull().unique(),
  reason: text('reason'), // 'opt_out' | 'bounce' | 'complaint' | 'manual'
  createdAt: timestamp('created_at').defaultNow(),
});
