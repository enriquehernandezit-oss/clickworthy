import {
  pgTable,
  serial,
  text,
  integer,
  real,
  boolean,
  timestamp,
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
