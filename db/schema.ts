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
