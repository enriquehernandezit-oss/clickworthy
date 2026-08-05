# Clickworthy — Status & What's Left (handoff)

## What it is
Clickworthy is a photo-enhancement service for **restaurants in the US**
(Miami, New York, Chicago, LA). We enhance a restaurant's *real* dish photos —
we never generate food. Two ways money comes in:

1. **Self-serve one-time photos** — the public landing page sells this. Upload
   photos, pay per photo, get them back. Sliding price **$3.00 → $1.80 per
   photo** (drops $0.10 each, floor at 13+). This is what a stranger who finds
   the site buys.
2. **High-ticket packages** — sold **only** through cold outreach, never shown
   on the public site: **Menu Glow-Up $499 · Grand Opening $899** (one-time,
   Stripe Checkout) and **Always Fresh $249/mo** (retainer, booked on a call —
   no online checkout, blocked server-side too).

The outreach engine finds under-performing restaurants on Google Maps,
cold-emails them, hand-enhances one photo free when they reply, then converts
them on a magic-link page. Nothing is enhanced until a restaurant asks, so cost
scales with replies, not with volume contacted.

## Stack
Next.js 16 (App Router) + TypeScript + Bun on Railway · PostgreSQL + Drizzle ·
pg-boss (Postgres-backed queue/cron, no Redis) · Tailwind v4 · Claid.ai (photo
enhancement) · Cloudflare R2 (storage, optional) · Claude Sonnet (scoring/copy/
moderation) · Gmail API (cold email) · Resend (transactional/alerts) ·
NeverBounce (email verification) · Stripe (payments) · Google Places API.
Two Railway services from one repo: `web` (Next.js) + `worker` (background jobs).

## What's BUILT (code complete, lint+build clean, not yet run against live keys)
- **Landing page** selling the one-time self-serve service: per-photo sliding
  scale + live price calculator, all figures derived from `lib/pricing.ts` so
  the page can never quote a price checkout won't charge. Bilingual EN/ES
  (formal *usted*). CTAs go to `/enhance`.
- **Self-serve `/enhance`**: upload → Stripe Checkout → enhance → download.
- **Worker pipeline**: nightly Google Places sourcing → hard filters → email
  discovery (scrapes site; Places has no emails) → NeverBounce verify → Claude
  Vision photo scoring (also derives the signature dish) → priority scoring.
- **Cold outreach — approval-first**: the nightly job **drafts** Touch 1 (never
  sends directly); you approve drafts in `/admin/outreach`, then they send on the
  next run, 30→50/day ramp, gated by `OUTREACH_ENABLED`. An `outreach_autosend`
  toggle restores full auto-send with no code change. Touch 1.5 bump (one ever,
  threaded); reply poller stores every reply body and alerts on no-photo replies;
  STOP/opt-out suppression. Approved static EN/ES copy is in place.
- **Free sample = MANUAL production**: a photo reply creates an `awaiting_edit`
  record and alerts you. You and Jose edit it by hand in `/admin` (a one-click
  Claid first pass is optional, never automatic), upload the finished photo, and
  approve — which is what sends Touch 2. Nothing auto-sends to a prospect.
- **Conversion funnel** `/l/[token]`: Revenue Impact Card, before/after, package
  tiers, Stripe Checkout, post-payment upload, delivery page. Bilingual EN/ES.
- **Paid orders** are also human-gated: upload → Claid first pass →
  `ready_for_review` → you finish each photo in `/admin` → Deliver (emails the
  customer). Never auto-delivers.
- **Admin mission control** at `/admin` (Basic Auth via `proxy.ts`, 7 tabs):
  Overview (attention chips + 7-day stats + **live activity feed**) · Restaurants
  (filter/search, per-row detail page with inline field edit, hold/suppress/
  requeue, full timeline) · Outreach (**drafts awaiting approval** — approve/
  redraft/skip/approve-all — plus the full sent log with reply bodies) · Samples
  (edit queue + history) · Orders (package queue, all orders, self-serve orders) ·
  Suppressions (manual add/remove) · **Controls** (pause panic-button, approval↔
  autosend toggle, worker health + "worker down?" alarm, worker boot env, and
  Run-now buttons that enqueue any job on demand).
- **Hardening**: retries on Claid/Gmail, Resend failure alerts, weekly stats
  email, deliverability auto-pause if opt-out/bounce rate > 8%.
- DB schema migrated to Railway Postgres. Everything committed & pushed to `main`.

## Positioning rules (locked — don't let copy drift)
- We **enhance real photos, never generate**. Never use the phrase
  "AI-generated" in customer-facing copy (Google Business Profile bans
  AI-generated images, and owners are wary of it).
- Spanish is **neutral-formal (usted)** everywhere, including outreach.
- Packages are **outreach-only**. Don't put them back on the public landing.
- Every commercial email needs the CAN-SPAM postal address + STOP opt-out.

---

## What's MISSING to actually run (setup + keys, not code)

### A. Keys still unset in `.env.local` / Railway
- `GOOGLE_MAPS_API_KEY` — Google Places API (New), enabled + billing on.
  **Blocks all lead sourcing.**
- `GOOGLE_SERVICE_ACCOUNT_JSON` — Gmail service-account key (+ domain-wide
  delegation, below). **Blocks all sending AND the reply poller.**
- `NEVERBOUNCE_API_KEY` — email verification before sending.
- `RESEND_API_KEY` — alerts + customer transactional email.
- `ALERT_EMAIL_TO` — where "new reply" / "order ready" alerts go.
- `OUTREACH_POSTAL_ADDRESS` — CAN-SPAM. If blank, emails ship with a visible
  `[set OUTREACH_POSTAL_ADDRESS]` placeholder.
- `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_WEBHOOK_SECRET`.
- R2 vars (optional — falls back to Postgres blob storage).
- Then flip `OUTREACH_ENABLED=true` when you're ready to actually send.
- **Already set:** `ANTHROPIC_API_KEY`, `CLAID_API_KEY`, `DATABASE_URL`,
  `GMAIL_SENDER`, `APP_ORIGIN`, `ADMIN_USER`, `ADMIN_PASSWORD`.

See `.env.example` for the full annotated list.

### B. External service setup
- **Stripe**: create/verify business, get keys, **register a webhook** at
  `https://clickworthytool.com/api/webhooks/stripe` (event
  `checkout.session.completed`) → gives `STRIPE_WEBHOOK_SECRET`. Turn OFF
  "Managed Payments" if on.
- **Gmail service account** (to send from `mail@clickworthytool.com`): GCP
  project → enable Gmail API → service account + JSON key → in Workspace Admin,
  add **domain-wide delegation** with scopes `gmail.send` + `gmail.readonly`.
- **Resend**: verify the sending domain so `alerts@clickworthytool.com` can send.
- **Cloudflare R2** (optional): bucket + account ID + public URL.
- **Railway**: second service (`worker`) from the same repo, start command
  `bun run worker`; set env on both services; confirm `clickworthytool.com`.

### C. Testing before going live (in this order)
1. **Sourcing dry-run**: `bun run worker:once "Miami, FL" 10` — check the sourced
   + enriched rows in `/admin/restaurants`; confirm they land `queued` with a
   real signature dish (needs Google Maps + NeverBounce + Anthropic keys).
2. **3-way Claid quality test** — 4–5 real restaurant photos through AI-Edit vs
   AI-Edit+Upscale vs Upscale-only, to lock the enhancement approach and true
   per-photo cost. **Still pending; the harness is written.**
3. **Stripe test-mode order** end to end on `/enhance`.
4. **One outreach cycle to your own inbox**: let the nightly job draft a Touch 1
   to a test address → **approve the draft in `/admin/outreach`** → it sends →
   reply with a photo → edit + approve the sample in `/admin/samples` → confirm
   Touch 2 → funnel → delivery. (`/admin/controls` has Run-now buttons so you
   don't have to wait for the crons.)

---

## Known technical TODOs / gaps
- Deliverability auto-pause uses opt-out/bounce **proxy** signals, not real
  Google Postmaster Tools data.
- `/enhance` results page is reachable by anyone with the session-id URL (no
  auth) — low risk, but worth noting.
- `/enhance` is English-only, so the ES landing links into an English flow.
- Dead tables in the schema: `photos` and `payments` (nothing reads or writes
  them).

## Business/legal open items (US-based)
- LLC formation + which state, partnership agreement, business bank/Stripe setup.
- NOTE: earlier planning had Dominican-Republic items (Pagos Azul, ITBIS,
  Spanish-first) — those are **dropped**; this is 100% US now.

---
**Question for the assistant reading this:** the build is done and the pivot is
already implemented — I don't need help deciding the offer or rewriting
positioning. What I need is help getting it **live**: working through the API
keys and external setup in section A/B, running the tests in section C, and
deciding whether the technical TODOs above should block launch or wait.
