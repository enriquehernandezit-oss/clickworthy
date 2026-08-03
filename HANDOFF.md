# Clickworthy — Status & What's Left (handoff)

## What it is
Clickworthy is an AI photo-enhancement service for **restaurants in the US**
(Miami, New York, Chicago, LA). Core mechanic: an automated pipeline finds
under-performing restaurants on Google Maps, cold-emails them, enhances one of
their photos free when they reply with one, then converts them on a magic-link
page. Nothing is enhanced until a restaurant asks — cost scales with replies,
not with volume contacted.

## Stack
Next.js (App Router) + TypeScript + Bun on Railway · PostgreSQL + Drizzle ·
pg-boss (Postgres-backed queue/cron, no Redis) · Tailwind · Claid.ai (photo
enhancement) · Cloudflare R2 (storage) · Claude Sonnet (scoring/copy/moderation)
· Gmail API (cold email) · Resend (transactional/alerts) · NeverBounce (email
verification) · Stripe (payments) · Google Places API (lead data).
Two Railway services from one repo: `web` (Next.js) + `worker` (background jobs).

## What's already BUILT (code complete, lint+build clean, not yet run live)
- **Landing page** + **self-serve `/enhance`** (upload → pay → AI enhance → download).
- **Worker pipeline**: nightly Google Places sourcing → hard filters → email
  discovery (scrapes site, Places has no emails) → NeverBounce verify → Claude
  Vision photo scoring → priority scoring.
- **Cold outreach**: Gmail send (Touch 1) with 20→50/day ramp, OFF by default
  behind an `OUTREACH_ENABLED` flag; reply poller; STOP/opt-out suppression.
- **Free sample + human review**: emailed photo enhanced via Claid → `/admin`
  page (Basic Auth) where the owner approves/rejects before Touch 2 is sent.
- **Conversion funnel** `/l/[token]`: Revenue Impact Card, before/after, package
  tiers, Stripe Checkout, post-payment upload, delivery page. Bilingual en/es.
- **Hardening**: retries on Claid/Gmail, Resend failure alerts, weekly stats
  email, deliverability auto-pause if opt-out/bounce rate > 8%.
- DB schema migrated to Railway Postgres. All Phases committed & pushed to GitHub.

---

## ⚠️ #1 — THE PIVOT: high-ticket offers (biggest open work)
The app is currently built **low-ticket** and needs to be re-thought for
high-ticket. Current pricing:
- Self-serve `/enhance`: sliding **$3.00 → $1.80 per photo** (kept, but de-emphasized — no longer linked from the landing).
- Outreach packages (now live, high-ticket): **Menu Glow-Up $499 · Grand Opening $899 (one-time) · Always Fresh $249/mo** (retainer, sold by call). The old $35/$50/$65 tiers are removed.

Decisions needed for the high-ticket pivot (business first, then code):
1. **What is the high-ticket offer?** (e.g. full menu/interior overhaul, done-for-
   you package, monthly refresh retainer, multi-platform posting bundle.) Define
   the actual value stack and price points (e.g. $299 / $499 / $999+, or a
   retainer).
2. **Does the cheap self-serve `/enhance` stay?** Options: remove it, keep it as a
   low-cost lead magnet, or reprice it. Right now it undercuts a high-ticket
   position.
3. **Positioning/copy** must change: the landing page, the Revenue Impact Card,
   and the funnel currently sell a cheap fix, not a premium service.
4. **Funnel mechanics** high-ticket often needs: a booking/sales-call step,
   deposits or invoicing, or a "request a quote" flow instead of instant Stripe
   Checkout. Decide if the one-click Checkout still fits.

**Where the code changes land (easy to edit — values are centralized):**
- `lib/packages.ts` — the 3 tier prices + photo limits (one file).
- `lib/pricing.ts` — the self-serve per-photo formula.
- `app/l/[token]/FunnelClient.tsx` + `app/l/[token]/copy.ts` — funnel UI + copy.
- `app/page.tsx` — landing page positioning.
- `worker/lib/anthropic.ts` — Revenue Impact Card + email copy prompts.

---

## What's MISSING to actually run (nothing here is "build," it's setup + keys)

### A. API keys / credentials to obtain and set (in `.env.local` + Railway)
- `GOOGLE_MAPS_API_KEY` — Google Places API (New), enabled + billing on.
- `NEVERBOUNCE_API_KEY` — email verification.
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
- `RESEND_API_KEY` — alerts + transactional (account exists, need key).
- `GOOGLE_SERVICE_ACCOUNT_JSON` — Gmail service-account key (see below).
- `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `R2_ACCOUNT_ID`,
  `R2_PUBLIC_URL_BASE` — Cloudflare R2 (optional; falls back to Postgres blob).
- `ADMIN_USER`, `ADMIN_PASSWORD` — for the `/admin` page.
- `ALERT_EMAIL_TO`, `OUTREACH_POSTAL_ADDRESS` — alerts recipient + CAN-SPAM footer.
- (Already set: `ANTHROPIC_API_KEY`, `CLAID_API_KEY`, `DATABASE_URL`.)

### B. External service setup
- **Stripe**: create/verify business, get keys, **register a webhook** pointing at
  `https://clickworthytool.com/api/webhooks/stripe` (event `checkout.session.completed`)
  → that gives `STRIPE_WEBHOOK_SECRET`. Turn OFF "Managed Payments" if it's on.
  (Stripe also requires a live business website — the landing page satisfies this.)
- **Gmail service account** (for cold email from `mail@clickworthytool.com`):
  GCP project → enable Gmail API → create service account + JSON key → in Google
  Workspace Admin, add **domain-wide delegation** for that account with scopes
  `gmail.send` and `gmail.readonly`.
- **Cloudflare R2**: create a bucket, get the account ID + a public URL (r2.dev or
  custom domain). Optional but recommended (otherwise photos store in Postgres).
- **Resend**: verify the sending domain so `alerts@clickworthytool.com` can send.
- **Railway**: create the **second service** (the `worker`) from the same repo with
  start command `bun run worker`; set all env vars on both services; confirm the
  custom domain `clickworthytool.com` is connected.

### C. Testing before going live (in this order)
1. **Phase 1 dry-run**: `bun run worker:once "Miami, FL" 10` — review the sourced +
   enriched restaurants in the DB (needs Google Maps + NeverBounce + Anthropic keys).
2. **3-way Claid quality test** — run 4–5 real restaurant photos through AI-Edit vs
   AI-Edit+Upscale vs Upscale-only to lock the enhancement approach + true cost
   (still pending; the test harness is written).
3. **Stripe test-mode order** end to end on `/enhance`.
4. **One outreach cycle to your own inbox** (send Touch 1 to a test address, reply
   with a photo, approve in `/admin`, confirm Touch 2 + funnel + delivery).

### D. Content still owed
- The 3 email templates (Touch 1 cold, Touch 2 follow-up, free-sample reply). The
  code uses AI-generated placeholders that follow the right structure — fine to
  test, but replace with real approved copy before live sending.

---

## Known technical TODOs / gaps in the current code
- The `/enhance` Stripe webhook enhances photos **inline** — for a large order it
  could hit Stripe's webhook timeout. Should move to a queued worker job (the
  outreach package flow already does this correctly; `/enhance` doesn't yet).
- **Touch 2** is sent as a new email, not threaded onto the customer's reply — a
  deliverability/UX nicety worth adding.
- Deliverability auto-pause uses opt-out/bounce **proxy** signals, not real Google
  Postmaster Tools data.
- `/enhance` results page is reachable by anyone with the session-id URL (no auth) —
  low risk but worth noting.

## Business/legal open items (US-based now)
- LLC formation + which state, partnership agreement, business bank/Stripe setup.
- NOTE: earlier planning had Dominican-Republic items (Pagos Azul, ITBIS, Spanish-
  first) — those are **dropped**; this is 100% US now.

---
**Question for the assistant reading this:** given the pivot to high-ticket, help
me (1) define the offer + pricing, (2) decide the fate of the cheap self-serve
tool, and (3) rework the funnel/positioning — then I'll make the code edits in the
files listed above.
